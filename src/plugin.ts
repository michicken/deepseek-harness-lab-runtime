import { Context, Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MissionStore } from "./store.js";
import { MissionRuntime } from "./runtime.js";
import { DshExecutor } from "./executor.js";
import { defaults, type RuntimeOptions } from "./types.js";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-cmdline";
import type {} from "@deepseek-ai/dsh-system-prompt";

// dsh 0.1.x calls this a plugin source; dsh 0.2.x stores the producer-owned
// kind directly and rejects the legacy { kind: "plugin" } wrapper at append
// time. The string form is accepted by both runtimes.
const PLUGIN_SOURCE = { kind: "plugin:lab-runtime" } as unknown as {
  kind: "plugin";
  plugin: string;
};

export interface Config extends Partial<RuntimeOptions> {
  stateDir?: string;
  autoStart?: boolean;
  allowedTargets?: string[];
  promptFile?: string;
  missionModePreset?: string;
  missionWorkerPreset?: string;
}
export const name = "lab-runtime";
export const inject = [
  "agents",
  "agentLoop",
  "tools",
  "agentDefaultModel",
  "systemPrompt",
];

/**
 * The durable session header records the composition the session was created
 * with, but switching presets in the UI only appends an
 * `agent-preset/selected` event. Read the latest selection so the Lab Mission
 * mode works both for fresh sessions and for an existing session switched into
 * the mode.
 */
export function currentAgentPreset(session: {
  header: { agentPreset?: string | undefined };
  snapshotEvents(): readonly unknown[];
}): string | undefined {
  const events = session.snapshotEvents() as readonly {
    type?: string;
    data?: { agentPreset?: unknown };
  }[];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "agent-preset/selected" &&
      typeof event.data?.agentPreset === "string"
    )
      return event.data.agentPreset;
  }
  return session.header.agentPreset;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    labRuntime: LabService;
  }
}
export class LabService extends Service {
  static inject = inject;
  readonly store: MissionStore;
  readonly runtime: MissionRuntime;
  readonly executor: DshExecutor;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "labRuntime");
    const stateDir = config.stateDir ?? resolve(homedir(), ".dsh-lab");
    if (!isAbsolute(stateDir)) throw new Error("stateDir must be absolute");
    this.store = new MissionStore(resolve(stateDir, "missions.sqlite"));
    const promptFile =
      config.promptFile ??
      fileURLToPath(
        new URL(
          "../assets/security-research-system-prompt.txt",
          import.meta.url,
        ),
      );
    const systemPrompt = readFileSync(promptFile, "utf8").trim();
    if (
      !systemPrompt.includes("系统提示词 V3.1-LAB") ||
      !systemPrompt.includes("长期无人值守运行协议")
    )
      throw new Error(
        "promptFile is not the compatible V3.1-LAB security research prompt",
      );
    this.executor = new DshExecutor(
      ctx,
      this.store,
      systemPrompt,
      config.missionWorkerPreset,
    );
    const options: Partial<RuntimeOptions> = {};
    for (const key of Object.keys(defaults) as (keyof RuntimeOptions)[])
      if (config[key] !== undefined) options[key] = config[key];
    this.runtime = new MissionRuntime(this.store, this.executor, options);
    const service = this;
    const output = {
      schema: { type: "string" },
      render: (_args: unknown, value: string) => [
        { type: "text" as const, text: value },
      ],
    } as const;
    ctx.tools.register(
      defineTool({
        name: "lab_mission_start",
        description:
          "在授权工作区启动一个持久自主 Mission。Lab Mission (24h) 模式会在当前 Agent 和 Session 中直接运行，普通工具调用与结果可见；同一个 Session 只允许一个未结束 Mission。后续用户消息应作为当前 Mission 的纠正或补充，不得创建第二个 Mission。continuous 用于持续研究，finite 用于有明确结束条件的目标；系统不设置总 token 上限。",
        parameters: {
          goal: { type: "string", required: true },
          cwd: { type: "string", required: true },
          mode: { type: "string", enum: ["finite", "continuous"] },
          targets: { type: "array", items: { type: "string" }, required: true },
        },
        output,
        async execute(args, exec) {
          if (!exec.agent || service.executor.workers.has(exec.agent.id))
            throw new Error("A human controller Session is required");
          if (!isAbsolute(args.cwd)) throw new Error("cwd must be absolute");
          const cwd = realpathSync(args.cwd);
          if (!statSync(cwd).isDirectory())
            throw new Error("cwd must be an existing directory");
          const selection = ctx.agentDefaultModel.currentSelection();
          const provider = exec.agent.options.provider ?? selection.provider;
          const model = exec.agent.options.model ?? selection.model;
          const targets = args.targets.map((target) =>
            authorizedTarget(target, config.allowedTargets),
          );
          if (!targets.length)
            throw new Error(
              "At least one explicit laboratory target is required",
            );
          const mission = service.store.create({
            targets,
            owner: exec.agent.id,
            goal: args.goal,
            cwd,
            provider,
            model,
            ...(args.mode ? { mode: args.mode } : {}),
            ...(config.missionModePreset !== undefined &&
            currentAgentPreset(exec.agent.session) === config.missionModePreset
              ? {
                  mode: "continuous" as const,
                  executionMode: "visible" as const,
                }
              : {}),
          });
          service.runtime.tick();
          return JSON.stringify(publicMission(mission));
        },
      }),
    );

    // The first message in a Lab Mission session creates a visible mission.
    // DshExecutor runs the main round in this same Agent; the preset may still
    // create parallel subagents, which must report back to this main Agent.
    ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
      if (process.env.LAB_RUNTIME_DEBUG)
        console.error(
          "lab-runtime/pre-step",
          JSON.stringify({
            preset: currentAgentPreset(agent.session),
            configured: config.missionModePreset,
            messages: messages.length,
          }),
        );
      if (
        config.missionModePreset === undefined ||
        currentAgentPreset(agent.session) !== config.missionModePreset ||
        messages.length === 0
      ) {
        return next();
      }
      const active = service.store
        .list(agent.id)
        .find((mission) => !["stopped", "completed"].includes(mission.status));
      if (active !== undefined) return next();
      const goal = messages
        .filter((message) => message.source.kind === "user")
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (goal.length === 0) return next();
      let cwd: string | undefined;
      try {
        const sessionCwd = agent.session.header.cwd;
        if (sessionCwd !== undefined && isAbsolute(sessionCwd)) {
          const resolvedCwd = realpathSync(sessionCwd);
          if (statSync(resolvedCwd).isDirectory()) cwd = resolvedCwd;
        }
      } catch {
        cwd = undefined;
      }
      if (cwd === undefined || config.allowedTargets === undefined) {
        return {
          kind: "enter",
          messages: [
            createUserMessage({
              content: [
                {
                  type: "text",
                  text: "Lab Mission mode could not start: the session workspace must be an existing directory and allowedTargets must be configured. Ask the human to fix the session or profile.",
                },
              ],
              source: PLUGIN_SOURCE,
            }),
          ],
        };
      }
      const selection = ctx.agentDefaultModel.currentSelection();
      try {
        const mission = service.store.create({
          owner: agent.id,
          goal,
          cwd,
          provider: agent.options.provider ?? selection.provider,
          model: agent.options.model ?? selection.model,
          targets: config.allowedTargets,
          mode: "continuous",
          executionMode: "visible",
        });
        service.runtime.tick();
        return {
          kind: "enter",
          messages: [
            createUserMessage({
              content: [
                {
                  type: "text",
                  text: `Mission ${mission.id} 已在当前同一会话中可见运行。目标：${goal}。请用简体中文简短告知用户已开始；主研究轮次会在当前会话使用普通工具继续。这个会话只允许一个 Mission；用户后续消息视为对当前 Mission 的纠正或补充，不得调用 lab_mission_start 或把纠正当成新任务。可以按需创建子 Agent 并行研究，但主会话必须继续工作、验证结果并用简体中文向用户沟通和报告。`,
                },
              ],
              source: PLUGIN_SOURCE,
            }),
          ],
        };
      } catch (error) {
        return {
          kind: "enter",
          messages: [
            createUserMessage({
              content: [
                {
                  type: "text",
                  text: `Lab Mission mode could not start: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              source: PLUGIN_SOURCE,
            }),
          ],
        };
      }
    });
    ctx.on("agent/created", ({ agent }) => {
      if (
        config.missionModePreset === undefined ||
        currentAgentPreset(agent.session) !== config.missionModePreset
      )
        return;
      const hidden = service.store
        .list(agent.id)
        .find(
          (mission) =>
            mission.executionMode !== "visible" &&
            !["stopped", "completed"].includes(mission.status),
        );
      if (hidden === undefined) return;
      service.runtime.cancelMission(
        hidden.id,
        "Adopting the active mission into its visible owner Session",
      );
      service.store.adoptVisible(hidden.id, agent.id);
      service.runtime.tick();
    });
    ctx.tools.register(
      defineTool({
        name: "lab_mission_status",
        description:
          "Read missions belonging to this controller Session, including checkpoints, failure state and task board.",
        parameters: { mission_id: { type: "string" } },
        output,
        async execute(args, exec) {
          if (!exec.agent) throw new Error("Controller Session required");
          const missions = args.mission_id
            ? [service.store.get(args.mission_id, exec.agent.id)]
            : service.store.list(exec.agent.id);
          return JSON.stringify(
            missions.map((m) => ({
              ...publicMission(m),
              tasks: service.store.tasks(m.id),
              findings: service.store.findings(m.id),
            })),
          );
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "lab_mission_control",
        description:
          "Pause, resume or permanently stop an owned mission. Pause/stop revoke the lease immediately; an active worker is cancelled on the next heartbeat. Resume requeues paused/blocked work.",
        parameters: {
          mission_id: { type: "string", required: true },
          action: {
            type: "string",
            enum: ["pause", "resume", "stop"],
            required: true,
          },
        },
        output,
        async execute(args, exec) {
          if (!exec.agent || service.executor.workers.has(exec.agent.id))
            throw new Error("Controller Session required");
          const mission = service.store.control(
            args.mission_id,
            args.action,
            exec.agent.id,
          );
          service.runtime.tick();
          return JSON.stringify(publicMission(mission));
        },
      }),
    );
    ctx.effect(() => async () => {
      await this.runtime.stop();
      this.store.close();
    });
    if (config.autoStart !== false) {
      if (ctx.appReady)
        ctx.effect(() => ctx.appReady!.onReady(() => this.runtime.start()));
      else this.runtime.start();
    }
  }
}
export function apply(ctx: Context, config: Config = {}): void {
  new LabService(ctx, config);
}
function publicMission(m: import("./types.js").Mission) {
  const { leaseOwner: _owner, leaseUntil: _until, ...rest } = m;
  return rest;
}

export function authorizedTarget(target: string, allowed?: string[]): string {
  const url = new URL(target);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Target must be an HTTP(S) URL without credentials");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    allowed
      ? !allowed.some((item) => new URL(item).origin === url.origin)
      : !local
  )
    throw new Error("Target is outside configured allowedTargets");
  return url.origin;
}
