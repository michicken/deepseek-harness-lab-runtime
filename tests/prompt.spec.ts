import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("worker system prompt", () => {
  it("is the reviewed V3.1-LAB prompt with long-running and evidence rules", () => {
    const prompt = readFileSync(
      new URL("../assets/security-research-system-prompt.txt", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("System Prompt V3.1-LAB");
    expect(prompt).toContain("长期无人值守运行协议");
    expect(prompt).toContain("网络安全实验室的授权与证据边界");
    expect(prompt).toContain("lab_round_report");
    expect(prompt).toContain("SHA-256");
    expect(prompt).not.toContain("System Prompt V3.0");
  });
});
