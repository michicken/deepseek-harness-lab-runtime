// Scripted MODEL, real dsh plugin tree, real tools, real loopback HTTP target and persisted artifacts.
import { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const name = "lab-integration-fixture";
export const inject = ["labRuntime", "llm", "tools"];
class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    const content = options.messages.flatMap((m) => m.content ?? []);
    const systemText = options.messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (
      !systemText.includes("系统提示词 V3.1-LAB") ||
      !systemText.includes("长期无人值守运行协议")
    )
      throw new Error(
        `Worker system prompt was not injected: ${systemText.slice(0, 300)}`,
      );
    const prompt = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const round = Number(
      prompt.match(/正在执行持久自主任务的第 (\d+) 轮/)?.[1] ?? 1,
    );
    const called = content
      .filter((b) => b.type === "tool-call")
      .map((b) => b.name);
    const toolErrors = content
      .filter((b) => b.type === "tool-result" && b.isError)
      .map((b) => b.content);
    const effortGateError = toolErrors.some((value) =>
      JSON.stringify(value).includes("本轮不能以"),
    );
    if (toolErrors.length && !effortGateError)
      throw new Error(`fixture saw tool error: ${JSON.stringify(toolErrors)}`);
    let name, args;
    const probeCount = called.filter(
      (value) => value === "lab_fixture_probe",
    ).length;
    if (
      round < 2 &&
      probeCount === 1 &&
      !effortGateError &&
      !called.includes("lab_round_report")
    ) {
      name = "lab_round_report";
      args = {
        action: "continue",
        checkpoint: `Round ${round}: intentionally attempted an early handoff to verify the runtime floor.`,
        evidence: ["proof.json"],
        progress: true,
      };
    } else if (probeCount < 6) {
      name = "lab_fixture_probe";
      args = { attempt: probeCount + 1 };
    } else if (!called.includes("lab_finding")) {
      name = "lab_finding";
      args = {
        title: "Synthetic object authorization failure",
        target: process.env.LAB_TARGET,
        classification: "lab-reproduced",
        prerequisites:
          "Two laboratory principals; authenticated as bob; synthetic alice record",
        evidence_paths: ["proof.json"],
      };
    } else if (!called.includes("lab_checkpoint")) {
      name = "lab_checkpoint";
      args = {
        checkpoint: `Round ${round} reproduced the synthetic ownership violation; saved proof.json; next independently repeat and review.`,
      };
    } else {
      name = "lab_round_report";
      args = {
        action: round >= 2 ? "complete" : "continue",
        checkpoint: `Round ${round}: reproduced local synthetic ownership violation, checked proof.json, recorded finding.`,
        evidence: ["proof.json"],
        progress: true,
      };
    }
    const id = ToolCallId(`fixture-${round}-${called.length}`),
      argumentsJson = JSON.stringify(args);
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index: 0,
      id,
      name,
      argumentsDelta: argumentsJson,
    };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name, arguments: argumentsJson },
    };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}
export function apply(ctx) {
  ctx.llm.registerAdapter(["lab-fixture"], new ScriptedAdapter());
  ctx.tools.register(
    defineTool({
      name: "lab_fixture_probe",
      description:
        "Integration fixture: probe only the owned loopback target and save synthetic evidence.",
      parameters: { attempt: { type: "integer", required: true } },
      output: {
        schema: { type: "string" },
        render: (_a, v) => [{ type: "text", text: v }],
      },
      async execute(_args, exec) {
        const target = process.env.LAB_TARGET;
        if (new URL(target).hostname !== "127.0.0.1")
          throw new Error("Loopback only");
        const response = await fetch(`${target}/record?id=alice`, {
          headers: { "X-Lab-Principal": "bob" },
          signal: exec.signal,
        });
        const body = await response.json();
        const control = await fetch(`${target}/record?id=bob`, {
          headers: { "X-Lab-Principal": "bob" },
          signal: exec.signal,
        });
        const controlBody = await control.json();
        if (body.owner !== "alice" || controlBody.owner !== "bob")
          throw new Error("Fixture evidence did not reproduce");
        const value = {
          fixtureProbe: true,
          at: new Date().toISOString(),
          classification: "lab-reproduced",
          request: { path: "/record?id=alice", principal: "bob" },
          response: { status: response.status, body },
          control: { status: control.status, body: controlBody },
        };
        writeFileSync(
          join(process.env.LAB_WORKSPACE, "proof.json"),
          JSON.stringify(value, null, 2),
        );
        return JSON.stringify(value);
      },
    }),
  );
  const start = () => {
    const m = ctx.labRuntime.store.create({
      owner: "integration-fixture",
      goal: "Discover and independently reproduce the synthetic object authorization defect twice; save evidence and classify it as lab reproduction.",
      cwd: process.env.LAB_WORKSPACE,
      provider: "lab-fixture",
      model: "scripted-fixture",
      targets: [process.env.LAB_TARGET],
    });
    ctx.labRuntime.runtime.tick();
    const timer = setInterval(() => {
      const current = ctx.labRuntime.store.get(m.id);
      if (["completed", "blocked"].includes(current.status)) {
        clearInterval(timer);
        console.log(
          JSON.stringify({
            kind: "lab-smoke-result",
            mission: current,
            findings: ctx.labRuntime.store.findings(m.id),
            events: ctx.labRuntime.store.events(m.id),
          }),
        );
        ctx.appExit(current.status === "completed" ? 0 : 1);
      }
    }, 50);
    ctx.effect(() => () => clearInterval(timer));
  };
  ctx.effect(() => ctx.appReady.onReady(start));
}
