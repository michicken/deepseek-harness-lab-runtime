import { describe, expect, it } from "vitest";
import { currentAgentPreset } from "../src/plugin.js";

function session(
  headerPreset: string | undefined,
  events: readonly { type: string; data?: unknown }[],
) {
  return {
    header: { agentPreset: headerPreset },
    snapshotEvents: () => events,
  };
}

describe("currentAgentPreset", () => {
  it("uses the header for a session created in the preset", () => {
    expect(currentAgentPreset(session("lab-mission", []))).toBe("lab-mission");
  });

  it("uses the latest preset selection after an in-session switch", () => {
    expect(
      currentAgentPreset(
        session("standard", [
          { type: "agent-preset/selected", data: { agentPreset: "vulnhunt" } },
          { type: "agent-preset/selected", data: { agentPreset: "lab-mission" } },
        ]),
      ),
    ).toBe("lab-mission");
  });

  it("ignores unrelated events and malformed selections", () => {
    expect(
      currentAgentPreset(
        session("standard", [
          { type: "turn/start", data: { turn: 1 } },
          { type: "agent-preset/selected", data: { agentPreset: 42 } },
        ]),
      ),
    ).toBe("standard");
  });
});
