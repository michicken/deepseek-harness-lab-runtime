import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionStore } from "../src/store.js";
import type { RoundReport } from "../src/types.js";
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-lab-"));
  const store = new MissionStore(join(dir, "state.sqlite"));
  return {
    dir,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export const input = {
  owner: "controller",
  goal: "Investigate with evidence",
  cwd: "/tmp",
  provider: "mock",
  model: "mock",
};
export function report(
  action: RoundReport["action"] = "continue",
): RoundReport {
  return {
    action,
    checkpoint: "Completed experiment A; next: verify B",
    evidence: ["experiment-a.json"],
    progress: true,
    waitMs: 1000,
  };
}
export async function until(fn: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
