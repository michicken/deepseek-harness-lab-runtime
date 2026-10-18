// Real dsh loop + real Lab Mission preset, with a scripted model. This fixture
// proves that the first user message in a `lab-mission` session becomes a
// durable mission and executes through the same visible Agent Session.
import {
  LlmAdapter,
  ToolCallId,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "lab-mode-fixture";
export const inject = ["labRuntime", "llm", "tools", "agentPresets", "agents"];

// The first visible research step deliberately ends with prose only. The
// runtime must steer it back into a tool call; otherwise the fixture fails.
let stoppedOnce = false;
let waitTested = false;
const minProbes = Number.parseInt(
  process.env.LAB_MIN_VISIBLE_ROUND_WORK_UNITS ?? "3",
  10,
);

class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    const prompt = options.messages
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (prompt.includes("你正在执行持久自主任务")) {
      if (!stoppedOnce) {
        stoppedOnce = true;
        const text =
          "我会先说明计划，然后再开始；这里故意不调用工具，验证运行时必须强制续接。";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const called = options.messages
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === "tool-call")
        .map((block) => block.name);
      const lastReport = called.lastIndexOf("lab_round_report");
      const currentCycle = called.slice(lastReport + 1);
      const probes = currentCycle.filter(
        (name) => name === "lab_mode_probe",
      ).length;
      let name;
      let args;
      if (probes < minProbes) {
        name = "lab_mode_probe";
        args = { attempt: probes + 1 };
      } else if (!currentCycle.includes("lab_checkpoint")) {
        name = "lab_checkpoint";
        args = {
          checkpoint:
            "Lab Mission mode fixture completed three owner-Session probes; next: verify the visible handoff.",
        };
      } else if (!waitTested) {
        waitTested = true;
        name = "lab_round_report";
        args = {
          action: "wait",
          checkpoint:
            "Lab Mission mode fixture intentionally attempted wait; runtime must reject it.",
          evidence: ["none"],
          progress: false,
        };
      } else {
        name = "lab_round_report";
        args = {
          action: "continue",
          checkpoint: "Lab Mission mode fixture ran in the owner Session.",
          evidence: ["none"],
          progress: false,
        };
      }
      const id = ToolCallId("mode-worker-report");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id,
        name,
        argumentsDelta: JSON.stringify(args),
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id,
          name,
          arguments: JSON.stringify(args),
        },
      };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const text = "LAB_MODE_LAUNCH_CARD";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(["lab-mode-fixture"], new ScriptedAdapter());
  ctx.tools.register(
    defineTool({
      name: "lab_mode_probe",
      description:
        "Integration fixture: perform one visible owner-Session probe.",
      parameters: { attempt: { type: "integer", required: true } },
      output: {
        schema: { type: "string" },
        render: (_a, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        return JSON.stringify({ visibleSession: true, attempt: args.attempt });
      },
    }),
  );
  const start = async () => {
    let handle;
    try {
      const workspace = process.env.LAB_WORKSPACE;
      handle = await ctx.agents.create({
        sessionId: SessionId("lab-mode-controller"),
        agentOptions: { provider: "lab-mode-fixture", model: "scripted-mode" },
        meta: { cwd: workspace, agentPreset: "lab-mission" },
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, "lab-mission");
        },
      });
      handle.agent.followup(
        createUserMessage({
          source: { kind: "user" },
          content: [
            {
              type: "text",
              text: "Audit the local lab fixture and record a checkpoint.",
            },
          ],
        }),
      );
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const missions = ctx.labRuntime.store.list("lab-mode-controller");
        if (missions.length > 0) {
          const mission = missions[0];
          const events = ctx.labRuntime.store.events(mission.id, 100);
          const sessionEvents = handle.agent.session.snapshotEvents();
          if (events.some((event) => event.kind === "cycle-settled")) {
            console.log(
              JSON.stringify({
                kind: "lab-mode-result",
                mission,
                events,
                hasLaunchAcknowledgment: sessionEvents.some((event) =>
                  JSON.stringify(event).includes("LAB_MODE_LAUNCH_CARD"),
                ),
                visibleRoundInOwner: sessionEvents.some((event) =>
                  JSON.stringify(event).includes("lab_round_report"),
                ),
                turnStoppingSteered: sessionEvents.some((event) =>
                  JSON.stringify(event).includes("运行时强制连续执行"),
                ),
                waitRejected: sessionEvents.some((event) =>
                  JSON.stringify(event).includes("禁止 wait"),
                ),
              }),
            );
            ctx.labRuntime.store.control(mission.id, "pause");
            ctx.labRuntime.runtime.cancelMission(
              mission.id,
              "fixture observed a durable cycle",
            );
            ctx.appExit(0);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("mode fixture timed out waiting for a visible cycle");
    } catch (error) {
      console.error("lab-mode-fixture-error", error);
      ctx.appExit(1);
    }
  };
  ctx.effect(() => ctx.appReady.onReady(start));
}
