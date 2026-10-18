import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { MissionStore } from "./store.js";
import {
  PermanentError,
  type RoundContext,
  type RoundExecutor,
  type RoundReport,
} from "./types.js";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-system-prompt";

const PLUGIN_SOURCE = { kind: "plugin:lab-runtime" } as unknown as {
  kind: "plugin";
  plugin: string;
};

/**
 * A report is a handoff point, not a substitute for doing the round's work.
 * These are deliberately small hard floors: the prompt describes the quality
 * bar, while the runtime prevents a model from ending after one quick read.
 */
export const MIN_ROUND_WORK_UNITS = 6;
export const MIN_WAIT_WORK_UNITS = 3;
export const MIN_ROUND_CHECKPOINTS = 1;

interface RoundActivity {
  workUnits: number;
  checkpointWrites: number;
}

interface VisibleRunState {
  context: RoundContext;
  activity: RoundActivity;
  report?: RoundReport;
  error?: Error;
}

const CONTROL_TOOLS = new Set([
  "lab_checkpoint",
  "lab_tasks",
  "lab_finding",
  "lab_round_report",
  "lab_mission_start",
  "lab_mission_status",
  "lab_mission_control",
]);

/** Count successful research calls while excluding durable Mission bookkeeping. */
function researchWorkWeight(name: string): number {
  if (CONTROL_TOOLS.has(name)) return 0;
  if (name === "subagent" || name === "subagent_fork") return 2;
  if (/^(todo|ask_user|present|compact|schedule)$/i.test(name)) return 0;
  return 1;
}

function enforceRoundEffort(
  mode: RoundContext["lease"]["mission"]["mode"],
  action: RoundReport["action"],
  activity: RoundActivity,
): void {
  const requiredWork =
    action === "continue" || action === "complete"
      ? MIN_ROUND_WORK_UNITS
      : action === "wait"
        ? MIN_WAIT_WORK_UNITS
        : 0;
  if (requiredWork === 0) return;
  const missing: string[] = [];
  if (activity.workUnits < requiredWork)
    missing.push(
      `还需要至少 ${requiredWork - activity.workUnits} 个真实研究动作`,
    );
  if (activity.checkpointWrites < MIN_ROUND_CHECKPOINTS)
    missing.push("还需要至少 1 次成功的 lab_checkpoint");
  if (!missing.length) return;
  const label = action === "wait" ? "wait" : action;
  throw new Error(
    `本轮不能以 ${label} 结束：只完成了 ${activity.workUnits} 个真实研究动作、${activity.checkpointWrites} 次 checkpoint；${missing.join("，")}。请继续执行源码/配置分析、实验/测试、证据核对或子 Agent 复核后再提交 lab_round_report。重复无意义调用不算实质进展。${mode === "continuous" && action === "wait" ? "只有确有外部依赖或授权缺口时才可以 wait。" : ""}`,
  );
}

/** Uses public dsh Agent APIs for worker-mode and same-Session visible missions. */
export class DshExecutor implements RoundExecutor {
  readonly workers = new Set<string>();
  private readonly visibleRuns = new Map<string, VisibleRunState>();
  private readonly visibleAgents = new Set<string>();
  constructor(
    private readonly ctx: Context,
    private readonly store: MissionStore,
    private readonly systemPrompt: string,
    private readonly workerPreset?: string,
  ) {
    ctx.on("agent/disposed", ({ agent }) => {
      this.visibleAgents.delete(agent.id);
      this.visibleRuns.delete(agent.id);
    });
  }
  canRun(mission: import("./types.js").Mission): boolean {
    return (
      mission.executionMode !== "visible" ||
      this.ctx.agents.get(SessionId(mission.owner)) !== undefined
    );
  }
  async run(context: RoundContext): Promise<RoundReport> {
    let report: RoundReport | undefined;
    let turnError: Error | undefined;
    let handle: AgentHandle | undefined;
    const activity: RoundActivity = { workUnits: 0, checkpointWrites: 0 };
    const store = this.store;
    const parent = this.ctx.agents.get(SessionId(context.lease.mission.owner));
    if (context.lease.mission.executionMode === "visible") {
      if (parent === undefined)
        throw new Error(
          "Visible owner Session disappeared before the round started",
        );
      return this.runVisible(parent, context);
    }
    const presetService = parent?.ctx.get("agentPresets") as
      AgentPresetRuntime | undefined;
    const workerPreset =
      this.workerPreset ??
      (parent === undefined
        ? undefined
        : presetService?.composedPreset(parent.ctx));
    const id = SessionId(
      `lab-${context.lease.mission.id}-${context.lease.fence}-${randomUUID()}`,
    );
    store.recordSession(context.lease, id);
    const onAbort = () =>
      handle?.agent.cancel({
        kind: "hook",
        reason: "Lab round cancelled or lease revoked",
      });
    this.workers.add(id);
    try {
      handle = await this.ctx.agents.create({
        sessionId: id,
        ...(parent === undefined ? {} : { parentAgent: parent }),
        agentOptions: {
          provider: context.lease.mission.provider,
          model: context.lease.mission.model,
        },
        meta: {
          cwd: context.lease.mission.cwd,
          ...(workerPreset === undefined ? {} : { agentPreset: workerPreset }),
          ...(parent === undefined
            ? {}
            : {
                parentSession: SessionId(context.lease.mission.owner),
                origin: "subagent" as const,
                delegationDepth: 1,
              }),
        },
        signal: context.signal,
        setup: async (agentCtx) => {
          if (this.workerPreset !== undefined) {
            const childPresets = agentCtx.get("agentPresets") as
              AgentPresetRuntime | undefined;
            if (childPresets === undefined)
              throw new Error(
                `Configured mission worker preset "${this.workerPreset}" requires agentPresets`,
              );
            await childPresets.mount(agentCtx, this.workerPreset);
          } else if (parent !== undefined) {
            (
              agentCtx.get("agentPresets") as AgentPresetRuntime | undefined
            )?.composeFrom(agentCtx, parent.ctx);
          }
          agentCtx.systemPrompt.section({
            name: "lab-security-research-system-prompt-v3.1",
            order:
              agentCtx.systemPrompt.getSectionOrder(
                "DEPLOYMENT_PERSONA_SUFFIX",
              ) + 1,
            text: this.systemPrompt,
          });
          agentCtx.on("tools/pre-execute", async (exec, next) => {
            const reason = hostGuard(
              exec.name,
              exec.arguments,
              context.lease.mission.cwd,
            );
            return reason === undefined ? next() : { kind: "deny", reason };
          });
          agentCtx.on("tools/post-execute", async (exec, result, next) => {
            if (!result.isError)
              activity.workUnits += researchWorkWeight(exec.name);
            return next();
          });
          agentCtx.on("agent/pre-step", async (_payload, next) => {
            context.signal.throwIfAborted();
            this.store.assertLease(context.lease);
            return next();
          });
          agentCtx.on("agent/error", ({ error }) => {
            turnError =
              error instanceof Error ? error : new Error(String(error));
          });
          agentCtx.tools.register(
            defineTool({
              name: "lab_checkpoint",
              description:
                "Persist progress now. Include completed work, experiment outcomes, file paths, unresolved questions, and the exact next action. Survives a crash before the round ends.",
              parameters: { checkpoint: { type: "string", required: true } },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                context.checkpoint(args.checkpoint);
                activity.checkpointWrites += 1;
                return JSON.stringify({ saved: true });
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_tasks",
              description:
                "Persistent task DAG for this mission. List first. Create a task with existing dependency IDs. Update uses revision compare-and-set; done requires evidence.",
              parameters: {
                action: {
                  type: "string",
                  enum: ["list", "create", "update"],
                  required: true,
                },
                title: { type: "string" },
                depends_on: { type: "array", items: { type: "string" } },
                task_id: { type: "string" },
                revision: { type: "integer" },
                status: { type: "string", enum: ["pending", "doing", "done"] },
                evidence: { type: "array", items: { type: "string" } },
              },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                if (args.action === "list")
                  return JSON.stringify(context.tasks.list());
                if (args.action === "create") {
                  if (!args.title) throw new Error("title required");
                  return JSON.stringify(
                    context.tasks.create(args.title, args.depends_on ?? []),
                  );
                }
                if (
                  !args.task_id ||
                  args.revision === undefined ||
                  !args.status
                )
                  throw new Error("task_id, revision and status required");
                return JSON.stringify(
                  context.tasks.update(
                    args.task_id,
                    args.revision,
                    args.status,
                    args.evidence ?? [],
                  ),
                );
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_finding",
              description:
                "Record a vulnerability finding with prerequisites and reproducible evidence. Distinguish static clues, lab reproduction, verified impact, and failed reproduction. Evidence files must exist inside this workspace and are SHA-256 hashed.",
              parameters: {
                title: { type: "string", required: true },
                target: { type: "string", required: true },
                classification: {
                  type: "string",
                  enum: [
                    "static",
                    "lab-reproduced",
                    "impact-verified",
                    "not-reproduced",
                  ],
                  required: true,
                },
                prerequisites: { type: "string", required: true },
                evidence_paths: {
                  type: "array",
                  items: { type: "string" },
                  required: true,
                },
              },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                const origin = new URL(args.target).origin;
                if (!context.lease.mission.targets.includes(origin))
                  throw new Error("Finding target outside mission scope");
                if (
                  !args.title.trim() ||
                  args.title.length > 2000 ||
                  !args.prerequisites.trim() ||
                  args.prerequisites.length > 4000
                )
                  throw new Error(
                    "Title/prerequisites required within size limits",
                  );
                if (
                  args.classification !== "static" &&
                  !args.evidence_paths.length
                )
                  throw new Error("Validation requires saved evidence");
                if (args.evidence_paths.length > 16)
                  throw new Error("At most 16 evidence files per finding");
                const root = realpathSync(context.lease.mission.cwd);
                const evidence = args.evidence_paths.map((path) => {
                  const full = realpathSync(resolve(root, path));
                  const rel = relative(root, full);
                  if (rel.startsWith("..") || isAbsolute(rel))
                    throw new Error("Evidence file outside workspace");
                  const stat = statSync(full);
                  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
                    throw new Error("Evidence must be a file under 16 MiB");
                  return {
                    path: rel,
                    sha256: createHash("sha256")
                      .update(readFileSync(full))
                      .digest("hex"),
                  };
                });
                return JSON.stringify(
                  store.addFinding(context.lease, {
                    title: args.title,
                    target: origin,
                    classification: args.classification,
                    prerequisites: args.prerequisites,
                    evidence,
                  }),
                );
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_round_report",
              description: `用持久交接结束本轮。提交前必须完成至少 ${MIN_ROUND_WORK_UNITS} 个成功的真实研究动作并成功调用 1 次 lab_checkpoint；只有确有外部依赖时才可 wait，wait 也至少需要 ${MIN_WAIT_WORK_UNITS} 个动作。continue 表示继续研究；finite Mission 只有在证据充分时才能 complete。continuous Mission 永远不能 complete 或 blocked，遇到障碍也必须使用 wait；只有用户通过 lab_mission_control 手动暂停或停止。证据必须写明实际结果。本工具会结束当前轮次。`,
              parameters: {
                action: {
                  type: "string",
                  enum: ["continue", "wait", "complete", "blocked"],
                  required: true,
                },
                checkpoint: { type: "string", required: true },
                evidence: {
                  type: "array",
                  items: { type: "string" },
                  required: true,
                },
                progress: { type: "boolean", required: true },
                wait_ms: { type: "integer" },
              },
              output: jsonOutput,
              async execute(args, exec) {
                context.signal.throwIfAborted();
                store.assertLease(context.lease);
                if (!args.checkpoint.trim() || args.checkpoint.length > 16000)
                  throw new Error(
                    "checkpoint must contain 1..16000 characters",
                  );
                const action =
                  context.lease.mission.mode === "continuous" &&
                  (args.action === "complete" || args.action === "blocked")
                    ? "wait"
                    : args.action;
                enforceRoundEffort(
                  context.lease.mission.mode,
                  action,
                  activity,
                );
                if (
                  action === "complete" &&
                  (!args.evidence.some((e) => e.trim()) ||
                    context.tasks.list().some((t) => t.status !== "done"))
                )
                  throw new Error(
                    "Completion needs evidence and all declared tasks done",
                  );
                const waitMs = args.wait_ms ?? 60000;
                if (
                  !Number.isSafeInteger(waitMs) ||
                  waitMs < 1000 ||
                  waitMs > 7 * 86400000
                )
                  throw new Error("wait_ms must be between 1000 and 604800000");
                if (
                  args.evidence.length > 32 ||
                  args.evidence.some((e) => e.length > 2000)
                )
                  throw new Error("Evidence exceeds size limit");
                report = {
                  action,
                  checkpoint: args.checkpoint,
                  evidence: args.evidence,
                  progress: args.progress,
                  waitMs,
                };
                exec.concludeTurn();
                return JSON.stringify({ accepted: true });
              },
            }),
          );
        },
      });
      context.signal.addEventListener("abort", onAbort, { once: true });
      context.signal.throwIfAborted();
      const m = context.lease.mission;
      handle.agent.followup(
        createUserMessage({
          source: PLUGIN_SOURCE,
          content: [{ type: "text", text: buildPrompt(context) }],
        }),
      );
      await handle.agent.whenIdle();
      context.signal.throwIfAborted();
      if (turnError) {
        const message = turnError.message;
        if (
          /(?:401|403|AUTH|INVALID_CREDENTIAL|NO_ADAPTER|UNKNOWN_MODEL|insufficient.*(?:balance|quota))/i.test(
            message,
          )
        )
          throw new PermanentError(message);
        throw turnError;
      }
      const end = handle.agent.session
        .snapshotEvents()
        .findLast((event) => event.type === "turn/end");
      if (end?.type === "turn/end" && end.data.reason.kind !== "completed")
        throw new Error(
          `dsh turn did not complete: ${JSON.stringify(end.data.reason)}`,
        );
      if (!report)
        throw new Error(
          `Round ended without lab_round_report (${m.id}); no success inferred`,
        );
      return report;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (handle) await handle.dispose();
      this.workers.delete(id);
    }
  }

  private async runVisible(
    agent: Agent,
    context: RoundContext,
  ): Promise<RoundReport> {
    if (this.visibleRuns.has(agent.id))
      throw new Error(`Visible mission already active in Session ${agent.id}`);
    this.installVisibleTools(agent);
    const state: VisibleRunState = {
      context,
      activity: { workUnits: 0, checkpointWrites: 0 },
    };
    this.visibleRuns.set(agent.id, state);
    const onAbort = () =>
      agent.cancel({ kind: "hook", reason: "Visible mission round cancelled" });
    try {
      context.signal.addEventListener("abort", onAbort, { once: true });
      context.signal.throwIfAborted();
      agent.followup(
        createUserMessage({
          source: PLUGIN_SOURCE,
          content: [{ type: "text", text: buildPrompt(context, true) }],
        }),
      );
      await agent.whenIdle();
      context.signal.throwIfAborted();
      if (state.error) throw state.error;
      const end = agent.session
        .snapshotEvents()
        .findLast((event) => event.type === "turn/end");
      if (
        end?.type === "turn/end" &&
        end.data.reason.kind === "aborted" &&
        end.data.reason.reason.kind === "user" &&
        state.report === undefined
      ) {
        return {
          action: "wait",
          checkpoint:
            context.lease.mission.checkpoint ||
            "本轮可见研究被用户打断，尚未产生新的 checkpoint；下一轮从当前会话轨迹继续。",
          evidence: ["用户打断了可见研究轮次，不能据此推断为执行失败。"],
          progress: false,
          waitMs: 60000,
        };
      }
      if (end?.type === "turn/end" && end.data.reason.kind !== "completed")
        throw new Error(
          `Visible dsh turn did not complete: ${JSON.stringify(end.data.reason)}`,
        );
      if (!state.report)
        throw new Error(
          `Visible Session ended without lab_round_report (${context.lease.mission.id})`,
        );
      return state.report;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (this.visibleRuns.get(agent.id) === state)
        this.visibleRuns.delete(agent.id);
    }
  }

  private installVisibleTools(agent: Agent): void {
    if (this.visibleAgents.has(agent.id)) return;
    this.visibleAgents.add(agent.id);
    const store = this.store;
    const active = (exec: { agent?: Agent }) =>
      exec.agent === undefined
        ? undefined
        : this.visibleRuns.get(exec.agent.id);
    const contextFor = (exec: { agent?: Agent }) => {
      const state = active(exec);
      if (!state)
        throw new Error("No visible mission round is active in this Session");
      state.context.signal.throwIfAborted();
      this.store.assertLease(state.context.lease);
      return { context: state.context, state };
    };
    agent.ctx.systemPrompt.section({
      name: "lab-security-research-system-prompt-v3.1",
      order:
        agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + 1,
      text: this.systemPrompt,
    });
    agent.ctx.on("tools/pre-execute", async (exec, next) => {
      const state = active(exec);
      if (!state || exec.name.startsWith("lab_")) return next();
      const reason = hostGuard(
        exec.name,
        exec.arguments,
        state.context.lease.mission.cwd,
      );
      return reason === undefined ? next() : { kind: "deny", reason };
    });
    agent.ctx.on("tools/post-execute", async (exec, result, next) => {
      const state = active(exec);
      if (state && !result.isError)
        state.activity.workUnits += researchWorkWeight(exec.name);
      return next();
    });
    agent.ctx.on("agent/pre-step", async (_payload, next) => {
      const state = this.visibleRuns.get(agent.id);
      if (!state) return next();
      state.context.signal.throwIfAborted();
      this.store.assertLease(state.context.lease);
      return next();
    });
    agent.ctx.on("agent/error", ({ error }) => {
      const state = this.visibleRuns.get(agent.id);
      if (state)
        state.error = error instanceof Error ? error : new Error(String(error));
    });
    agent.ctx.tools.register(
      defineTool({
        name: "lab_checkpoint",
        description:
          "Persist visible mission progress, results, paths, unresolved questions, and the exact next action.",
        parameters: { checkpoint: { type: "string", required: true } },
        output: jsonOutput,
        async execute(args, exec) {
          const { context, state } = contextFor(exec);
          context.checkpoint(args.checkpoint);
          state.activity.checkpointWrites += 1;
          return JSON.stringify({ saved: true });
        },
      }),
    );
    agent.ctx.tools.register(
      defineTool({
        name: "lab_tasks",
        description:
          "Persistent task DAG for this mission. List first; create tasks with dependency IDs; updates use revision compare-and-set and done requires evidence.",
        parameters: {
          action: {
            type: "string",
            enum: ["list", "create", "update"],
            required: true,
          },
          title: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          task_id: { type: "string" },
          revision: { type: "integer" },
          status: { type: "string", enum: ["pending", "doing", "done"] },
          evidence: { type: "array", items: { type: "string" } },
        },
        output: jsonOutput,
        async execute(args, exec) {
          const { context } = contextFor(exec);
          if (args.action === "list")
            return JSON.stringify(context.tasks.list());
          if (args.action === "create") {
            if (!args.title) throw new Error("title required");
            return JSON.stringify(
              context.tasks.create(args.title, args.depends_on ?? []),
            );
          }
          if (!args.task_id || args.revision === undefined || !args.status)
            throw new Error("task_id, revision and status required");
          return JSON.stringify(
            context.tasks.update(
              args.task_id,
              args.revision,
              args.status,
              args.evidence ?? [],
            ),
          );
        },
      }),
    );
    agent.ctx.tools.register(
      defineTool({
        name: "lab_finding",
        description:
          "Record a vulnerability finding with prerequisites and evidence files inside this mission workspace; evidence is SHA-256 hashed.",
        parameters: {
          title: { type: "string", required: true },
          target: { type: "string", required: true },
          classification: {
            type: "string",
            enum: [
              "static",
              "lab-reproduced",
              "impact-verified",
              "not-reproduced",
            ],
            required: true,
          },
          prerequisites: { type: "string", required: true },
          evidence_paths: {
            type: "array",
            items: { type: "string" },
            required: true,
          },
        },
        output: jsonOutput,
        async execute(args, exec) {
          const { context } = contextFor(exec);
          const origin = new URL(args.target).origin;
          if (!context.lease.mission.targets.includes(origin))
            throw new Error("Finding target outside mission scope");
          if (
            !args.title.trim() ||
            args.title.length > 2000 ||
            !args.prerequisites.trim() ||
            args.prerequisites.length > 4000
          )
            throw new Error("Title/prerequisites required within size limits");
          if (args.classification !== "static" && !args.evidence_paths.length)
            throw new Error("Validation requires saved evidence");
          if (args.evidence_paths.length > 16)
            throw new Error("At most 16 evidence files per finding");
          const root = realpathSync(context.lease.mission.cwd);
          const evidence = args.evidence_paths.map((path) => {
            const full = realpathSync(resolve(root, path));
            const rel = relative(root, full);
            if (rel.startsWith("..") || isAbsolute(rel))
              throw new Error("Evidence file outside workspace");
            const stat = statSync(full);
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
              throw new Error("Evidence must be a file under 16 MiB");
            return {
              path: rel,
              sha256: createHash("sha256")
                .update(readFileSync(full))
                .digest("hex"),
            };
          });
          return JSON.stringify(
            store.addFinding(context.lease, {
              title: args.title,
              target: origin,
              classification: args.classification,
              prerequisites: args.prerequisites,
              evidence,
            }),
          );
        },
      }),
    );
    agent.ctx.tools.register(
      defineTool({
        name: "lab_round_report",
        description: `结束本轮可见研究；提交前必须完成至少 ${MIN_ROUND_WORK_UNITS} 个成功的真实研究动作并成功调用 1 次 lab_checkpoint，wait 也至少需要 ${MIN_WAIT_WORK_UNITS} 个动作。运行时会在同一个 Session 中继续，所有工具调用和结果都会保留在当前轨迹。当前会话只绑定一个 Mission，用户后续消息是对该 Mission 的纠正或补充，不得创建第二个 Mission。continuous Mission 永远不能 complete 或 blocked，遇到障碍必须使用 wait；只有用户通过 lab_mission_control 手动暂停或停止。`,
        parameters: {
          action: {
            type: "string",
            enum: ["continue", "wait", "complete", "blocked"],
            required: true,
          },
          checkpoint: { type: "string", required: true },
          evidence: {
            type: "array",
            items: { type: "string" },
            required: true,
          },
          progress: { type: "boolean", required: true },
          wait_ms: { type: "integer" },
        },
        output: jsonOutput,
        async execute(args, exec) {
          const { context, state } = contextFor(exec);
          if (!args.checkpoint.trim() || args.checkpoint.length > 16000)
            throw new Error("checkpoint must contain 1..16000 characters");
          const action =
            context.lease.mission.mode === "continuous" &&
            (args.action === "complete" || args.action === "blocked")
              ? "wait"
              : args.action;
          enforceRoundEffort(
            context.lease.mission.mode,
            action,
            state.activity,
          );
          if (
            action === "complete" &&
            (!args.evidence.some((e) => e.trim()) ||
              context.tasks.list().some((t) => t.status !== "done"))
          )
            throw new Error(
              "Completion needs evidence and all declared tasks done",
            );
          const waitMs = args.wait_ms ?? 60000;
          if (
            !Number.isSafeInteger(waitMs) ||
            waitMs < 1000 ||
            waitMs > 7 * 86400000
          )
            throw new Error("wait_ms must be between 1000 and 604800000");
          if (
            args.evidence.length > 32 ||
            args.evidence.some((e) => e.length > 2000)
          )
            throw new Error("Evidence exceeds size limit");
          state.report = {
            action,
            checkpoint: args.checkpoint,
            evidence: args.evidence,
            progress: args.progress,
            waitMs,
          };
          exec.concludeTurn();
          return JSON.stringify({ accepted: true, visibleSession: true });
        },
      }),
    );
  }
}

interface AgentPresetRuntime {
  composedPreset(ctx: Context): string | undefined;
  composeFrom(ctx: Context, parent: Context): string | undefined;
  mount(ctx: Context, id: string): Promise<{ id: string }>;
}
const jsonOutput = {
  schema: { type: "string" } satisfies ValueSchemaSpec,
  render: (_args: unknown, value: string) => [
    { type: "text" as const, text: value },
  ],
} as const;
function buildPrompt(context: RoundContext, visible = false): string {
  const m = context.lease.mission;
  const tasks = context.tasks.list();
  return `你正在执行持久自主任务的第 ${m.round + 1} 轮${visible ? "，并且直接运行在用户当前的 Agent 会话中" : ""}。
当前会话只绑定一个 Mission。第一条用户消息定义目标；后续用户消息都是对这个 Mission 的纠正、补充、优先级调整或范围说明，不是新任务。把它们合并到当前计划、checkpoint、任务看板和下一步行动中，不要调用 lab_mission_start，不要创建第二个 Mission，也不要把纠正内容单独登记成任务。只有用户明确要求暂停、恢复或停止时才调用 lab_mission_control。
目标：${m.goal}
模式：${m.mode}。${m.mode === "continuous" ? "该目标会持续存在；没有可执行工作时，使用 wait 并设置合理等待时间。" : "只有证据证明目标已经完成时才结束。"}
工作区：${m.cwd}
已授权目标 origin：${JSON.stringify(m.targets)}
只能在这些目标内行动。不得测试其他主机、导出真实用户数据或进行超出授权的破坏性验证。使用最小化合成测试数据，并保存准确的请求与响应。lab_finding 会记录证据哈希，并区分静态线索、实验室复现和已验证影响；不得混淆这些类别。目标声明用于约束工具和报告范围，操作系统与容器网络隔离必须由部署环境提供。
最近 checkpoint（必须用实际文件校验事实）：
${m.checkpoint || "（尚无 checkpoint）"}
任务看板摘要：${JSON.stringify(tasks.slice(-20).map((t) => ({ id: t.id, title: t.title, status: t.status, revision: t.revision })))}

使用工具和可验证实验取得具体进展。${visible ? "主会话必须继续在当前会话中统筹、实际研究、复核、更新 checkpoint，并让用户看到主会话的进展、工具调用和结果。允许按需创建任意数量的子 Agent 或子会话并行处理独立研究项，但不得让主会话停摆、只等待子代理或变成黑盒；子 Agent 不得创建第二个 Mission，所有结果必须回传当前主会话，由主会话验证并用简体中文向用户说明。" : "如果已安装相应 dsh 工具，可以在确有帮助时委托，并协调共享文件。"} 使用 lab_tasks 维护持久任务 DAG。在有意义的进展后调用 lab_checkpoint，避免崩溃丢失交接信息。${visible ? "之前的对话仍然可见，但重要事实必须与持久 checkpoint 和实际文件核对。" : "本轮使用新的会话；必须检查工作区和 checkpoint，不能假设上一轮对话仍然可用。"}
每一轮都必须完成一个完整的研究工作单元后才能交接，不能只读取一两个文件、写几句总结或调用一次工具就停下。运行时硬性底线是：提交 lab_round_report 前至少完成 ${MIN_ROUND_WORK_UNITS} 个成功的非控制研究动作，并成功调用至少 1 次 lab_checkpoint；研究动作应覆盖有区别的源码/配置或数据流分析、可执行实验/测试、独立交叉核对、证据保存或子 Agent 复核中的至少两类。子 Agent 可以并行提高吞吐，但主会话必须继续自己的分析和验证。运行时计数只是最低门槛，重复无意义读取不能代替真实进展。只有确有外部依赖、授权缺口或暂时不可用的目标才可 wait，wait 也必须先完成至少 ${MIN_WAIT_WORK_UNITS} 个真实动作并记录阻塞证据；没有阻塞证据时继续研究，不得用 wait 偷懒。
必须以 lab_round_report 结束本轮。写明准确完成的工作、失败的方法、证据路径或结果以及下一步具体行动。${m.mode === "continuous" ? "这是常驻 Mission：不得使用 complete 或 blocked；遇到人类输入、授权或外部依赖问题时记录缺口并使用 wait，之后自动重试。不得自行调用 lab_mission_control；只有用户明确要求时才暂停或停止。" : "需要人类输入或授权时使用 blocked；只有证据充分时使用 complete。"} 外部目标暂不可用时使用 wait；不得循环制造活动或编造进展。没有工具证据时不得声称命令已经执行。轮次可能因崩溃而重放：外部修改必须幂等，重复前先检查已有结果。系统没有设置总 token 或轮次上限，但 provider 上下文、单轮运行时限和部署费用仍是真实边界。所有说明和报告使用简体中文；工具名、参数、枚举值、文件路径、命令和代码标识保留原文。`;
}

const CLASH_PATTERN = /\b(clashx?|mihomo|clash[- ]?verge)\b/i;
const HOST_COMMAND_PATTERN =
  /\b(osascript|launchctl|systemsetup|networksetup|diskutil|csrutil|nvram|tmutil|shutdown|reboot|killall|pkill|sudo|defaults\s+write)\b/i;
const HOST_PATH_PATTERN =
  /(?:^|[\s"'=:])(?:~|\$HOME|\/Users\/|\/System\/|\/Library\/|\/Applications\/|\/private\/|\/etc\/)/;

/** Best-effort process guard. Container/VM isolation remains the real boundary. */
export function hostGuard(
  name: string,
  args: unknown,
  workspace: string,
): string | undefined {
  const serialized = JSON.stringify(args);
  if (CLASH_PATTERN.test(serialized)) {
    return "Clash/Mihomo 明确不在任务范围内：不得读取、修改、控制、探测或通过它转发流量。";
  }
  if (/computer|cua|osascript|applescript/i.test(name)) {
    return "宿主 GUI 和系统控制不在实验室边界内。";
  }
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const filePath = record.file_path ?? record.path;
  if (typeof filePath === "string" && (name === "write" || name === "edit")) {
    const target = resolve(workspace, filePath);
    const rel = relative(workspace, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return "文件写入仅限 mission 工作区；macOS 宿主不在任务范围内。";
    }
  }
  const command = record.command ?? record.cmd;
  if (typeof command === "string") {
    const guardedCommand = command.split(workspace).join("<workspace>");
    if (HOST_COMMAND_PATTERN.test(guardedCommand)) {
      return "该命令可能修改 macOS 宿主；请改为在隔离实验室内执行等价操作。";
    }
    if (HOST_PATH_PATTERN.test(guardedCommand)) {
      return "引用宿主 home 或系统路径的命令已拦截；请使用 mission 工作区或隔离实验室内的路径。";
    }
  }
  return undefined;
}
