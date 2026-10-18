import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { continuousToolDenial, hostGuard } from "../src/executor.js";

describe("worker system prompt", () => {
  it("is the reviewed V3.2-LAB prompt with continuous-execution and evidence rules", () => {
    const prompt = readFileSync(
      new URL("../assets/security-research-system-prompt.txt", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("系统提示词 V3.2-LAB");
    expect(prompt).toContain("全程使用简体中文");
    expect(prompt).toContain("同一个 Agent Session 只绑定一个长期 Mission");
    expect(prompt).toContain("允许按需创建任意数量的子 Agent 或子会话");
    expect(prompt).toContain("主会话必须持续承担统筹、实际研究、复核");
    expect(prompt).toContain("长期无人值守运行协议");
    expect(prompt).toContain("授权范围、主机隔离与 Clash 禁区");
    expect(prompt).toContain("拥有完成整个研究目标所需的完整行动权限");
    expect(prompt).toContain("lab_round_report");
    expect(prompt).toContain("至少要求二十四个成功的非控制研究动作");
    expect(prompt).toContain("连续研究工作包");
    expect(prompt).toContain("无限二代破甲执行风格");
    expect(prompt).toContain("continuous Mission 禁止停下等待");
    expect(prompt).toContain("任何时刻都不得调用 wait");
    expect(prompt).toContain("禁止调用 `ask_user_question`");
    expect(prompt).toContain("运行时会在 `agent/turn-stopping` 拦截");
    expect(prompt).toContain("绝对连续执行禁令");
    expect(prompt).toContain("同一持续回合");
    expect(prompt).toContain("禁止把 lab_round_report 当成最终回答");
    expect(prompt).toContain("SHA-256");
    expect(prompt).not.toContain("System Prompt V3.1");
  });
});

describe("host guard", () => {
  const workspace = "/tmp/lab-workspace";
  it("blocks Clash access and host GUI/control commands", () => {
    expect(
      hostGuard(
        "bash",
        { command: "cat ~/.config/clash/config.yaml" },
        workspace,
      ),
    ).toContain("Clash");
    expect(
      hostGuard("bash", { command: "launchctl list" }, workspace),
    ).toContain("macOS 宿主");
    expect(hostGuard("computer", {}, workspace)).toContain("GUI");
  });
  it("blocks writes outside the workspace but allows lab-local work", () => {
    expect(
      hostGuard("write", { file_path: "/Users/micx/Library/test" }, workspace),
    ).toContain("工作区");
    expect(
      hostGuard("write", { file_path: "proof.json" }, workspace),
    ).toBeUndefined();
    expect(
      hostGuard("bash", { command: `cd ${workspace} && npm test` }, workspace),
    ).toBeUndefined();
    expect(
      hostGuard(
        "bash",
        { command: "curl http://127.0.0.1:8080/health" },
        workspace,
      ),
    ).toBeUndefined();
  });
});

describe("continuous execution guard", () => {
  it("rejects user questions while a continuous visible Mission is active", () => {
    expect(continuousToolDenial(true, "ask_user_question")).toContain(
      "禁止询问、等待或暂停",
    );
    expect(continuousToolDenial(true, "ask_user")).toContain(
      "禁止询问、等待或暂停",
    );
    expect(continuousToolDenial(true, "wait")).toContain(
      "禁止询问、等待或暂停",
    );
    expect(continuousToolDenial(true, "schedule")).toContain(
      "禁止询问、等待或暂停",
    );
    expect(continuousToolDenial(false, "ask_user_question")).toBeUndefined();
    expect(continuousToolDenial(true, "bash")).toBeUndefined();
  });
});
