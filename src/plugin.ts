import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { FileMissionStore } from "./store.js";
import { MissionRuntime } from "./runtime.js";
import type { MissionRuntimeConfig } from "./types.js";

export const name = "long-running-runtime";
export const inject = ["tools"];

export interface Config extends MissionRuntimeConfig {
  readonly enabled?: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    longRunning: LongRunningService;
  }
}

export class LongRunningService extends Service {
  static inject = ["tools"];
  readonly runtime: MissionRuntime;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "longRunning");
    if (config.enabled === false) {
      this.runtime = new MissionRuntime(
        new FileMissionStore(config.stateDir ?? `${process.cwd()}/.dsh-lab`),
        config,
        (text) =>
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "long-running" } as never,
          }),
      );
      return;
    }
    const stateDir = config.stateDir ?? `${process.cwd()}/.dsh-lab`;
    this.runtime = new MissionRuntime(
      new FileMissionStore(
        stateDir,
        config.lockTimeoutMs === undefined
          ? {}
          : { lockTimeoutMs: config.lockTimeoutMs },
      ),
      config,
      (text) =>
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "long-running" } as never,
        }),
    );

    ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
      if (signal.aborted) return;
      await this.runtime.onTurnStopping(agent);
    });

    ctx.tools.register(
      defineTool({
        name: "lab_mission_start",
        description:
          "Start a durable long-running autonomous mission owned by the current Agent. The runtime continues the mission after each completed turn until it is completed, paused, stopped, or fails.",
        parameters: {
          goal: {
            type: "string",
            required: true,
            description: "The durable mission objective.",
          },
          cwd: {
            type: "string",
            description:
              "Optional absolute working directory for the mission record.",
          },
        },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.start({
            goal: args.goal,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            agent: exec.agent,
          });
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_resume",
        description:
          "Reattach a persisted mission to the current Agent after a process restart and continue from its last checkpoint.",
        parameters: { mission_id: { type: "string", required: true } },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.resume(args.mission_id, exec.agent);
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_status",
        description:
          "Read one durable mission or all missions visible to the runtime.",
        parameters: {
          mission_id: {
            type: "string",
            description: "Mission ID. Omit to list all missions.",
          },
        },
        output: {
          schema: {
            type: "object",
            properties: {
              missions: { type: "array", items: missionSchema, required: true },
            },
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return {
            missions: await this.runtime.status(args.mission_id, exec.agent),
          };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_checkpoint",
        description:
          "Persist a concise checkpoint for the current durable mission so a later turn or restarted process can resume without repeating completed work.",
        parameters: {
          mission_id: { type: "string", required: true },
          checkpoint: { type: "string", required: true },
        },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.checkpoint(
            args.mission_id,
            exec.agent,
            args.checkpoint,
          );
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_complete",
        description:
          "Mark the current durable mission completed after verifying that its objective is actually done.",
        parameters: {
          mission_id: { type: "string", required: true },
          summary: {
            type: "string",
            description: "Optional completion summary.",
          },
        },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.complete(
            args.mission_id,
            exec.agent,
            args.summary,
          );
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_pause",
        description:
          "Pause the current durable mission. Use when human input or an external dependency is required.",
        parameters: { mission_id: { type: "string", required: true } },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.pause(args.mission_id, exec.agent);
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "lab_mission_stop",
        description:
          "Stop the current durable mission and record why it was stopped.",
        parameters: {
          mission_id: { type: "string", required: true },
          reason: { type: "string", description: "Optional stop reason." },
        },
        output: {
          schema: missionSchema,
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          requireAgent(exec.agent);
          return await this.runtime.stop(
            args.mission_id,
            exec.agent,
            args.reason,
          );
        },
      }),
    );

    ctx.effect(() => async () => {
      await this.runtime.dispose();
    });
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new LongRunningService(ctx, config);
}

function requireAgent(agent: Agent | undefined): asserts agent is Agent {
  if (agent === undefined)
    throw new Error("long-running mission tools require an Agent Session");
}

const missionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "goal",
    "status",
    "createdAt",
    "updatedAt",
    "turnCount",
    "checkpoint",
    "eventCount",
  ],
  properties: {
    id: { type: "string" },
    goal: { type: "string" },
    status: { type: "string" },
    agentId: { type: "string" },
    cwd: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    lastTurnAt: { type: "number" },
    turnCount: { type: "number" },
    checkpoint: { type: "string" },
    lastError: { type: "string" },
    eventCount: { type: "number" },
  },
} as const;
