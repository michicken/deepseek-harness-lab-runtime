// Real dsh loop + real Lab Mission preset, with a scripted model. This fixture
// proves that the first user message in a `lab-mission` session becomes a
// durable mission and that the runtime creates a visible worker session.
import {
  LlmAdapter,
  ToolCallId,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "lab-mode-fixture";
export const inject = ["labRuntime", "llm", "tools", "agentPresets", "agents"];

class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    const prompt = options.messages
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (prompt.includes("carrying out round")) {
      const args = {
        action: "blocked",
        checkpoint: "Lab Mission mode fixture reached a worker session.",
        evidence: ["none"],
        progress: false,
      };
      const id = ToolCallId("mode-worker-report");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id,
        name: "lab_round_report",
        argumentsDelta: JSON.stringify(args),
      };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id, name: "lab_round_report", arguments: JSON.stringify(args) },
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
      console.error(
        "mode-diag",
        JSON.stringify({
          header: handle.agent.session.header,
          composed: ctx.agentPresets.composedPreset(handle.agent.ctx),
        }),
      );
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
      await handle.agent.whenIdle();
      console.error(
        "mode-diag-after-turn",
        JSON.stringify({
          events: handle.agent.session
            .snapshotEvents()
            .map((event) => event.type),
          missions: ctx.labRuntime.store.list("lab-mode-controller"),
        }),
      );
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const missions = ctx.labRuntime.store.list("lab-mode-controller");
        if (missions.length > 0) {
          const mission = missions[0];
          const events = ctx.labRuntime.store.events(mission.id, 100);
          if (events.some((event) => event.kind === "session")) {
            console.log(
              JSON.stringify({
                kind: "lab-mode-result",
                mission,
                events,
                launchCard: handle.agent.session
                  .snapshotEvents()
                  .some((event) =>
                    JSON.stringify(event).includes("LAB_MODE_LAUNCH_CARD"),
                  ),
              }),
            );
            ctx.appExit(0);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("mode fixture timed out waiting for a mission and worker session");
    } catch (error) {
      console.error("lab-mode-fixture-error", error);
      ctx.appExit(1);
    }
  };
  ctx.effect(() => ctx.appReady.onReady(start));
}
