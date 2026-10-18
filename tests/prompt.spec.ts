import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hostGuard } from "../src/executor.js";

describe("worker system prompt", () => {
  it("is the reviewed V3.1-LAB prompt with long-running and evidence rules", () => {
    const prompt = readFileSync(
      new URL("../assets/security-research-system-prompt.txt", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("System Prompt V3.1-LAB");
    expect(prompt).toContain("长期无人值守运行协议");
    expect(prompt).toContain("授权范围、主机隔离与 Clash 禁区");
    expect(prompt).toContain("拥有完成整个研究目标所需的完整行动权限");
    expect(prompt).toContain("lab_round_report");
    expect(prompt).toContain("SHA-256");
    expect(prompt).not.toContain("System Prompt V3.0");
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
    ).toContain("macOS host");
    expect(hostGuard("computer", {}, workspace)).toContain("GUI");
  });
  it("blocks writes outside the workspace but allows lab-local work", () => {
    expect(
      hostGuard("write", { file_path: "/Users/micx/Library/test" }, workspace),
    ).toContain("workspace");
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
