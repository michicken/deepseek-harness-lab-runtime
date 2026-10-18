import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMissionStore } from "../src/store.js";
import { MissionRuntime } from "../src/runtime.js";
import type { MissionAgent } from "../src/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function agent(id: string) {
  const messages: unknown[] = [];
  const value: MissionAgent = {
    id,
    followup: (message) => {
      messages.push(message);
    },
    steer: (message) => {
      messages.push(message);
    },
  };
  return { value, messages };
}

async function makeRuntime(options: { maxEventHistory?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-lab-runtime-"));
  dirs.push(dir);
  const store = new FileMissionStore(dir);
  const messages: string[] = [];
  const runtime = new MissionRuntime(
    store,
    { stateDir: dir, ...options },
    (text) => {
      messages.push(text);
      return text;
    },
  );
  return { dir, store, runtime, messages };
}

describe("MissionRuntime", () => {
  it("persists a mission and starts the first turn", async () => {
    const { runtime, store, messages } = await makeRuntime();
    const lead = agent("lead");
    const mission = await runtime.start({
      goal: "Keep investigating until the evidence is complete.",
      agent: lead.value,
    });

    expect(mission.status).toBe("running");
    expect(lead.messages).toHaveLength(1);
    expect(messages[0]).toContain(mission.id);
    expect((await store.read()).missions[mission.id]?.agentId).toBe("lead");
  });

  it("continues after every turn and stops continuing after pause", async () => {
    const { runtime } = await makeRuntime();
    const lead = agent("lead");
    const mission = await runtime.start({
      goal: "Work forever until paused.",
      agent: lead.value,
    });

    await runtime.onTurnStopping(lead.value);
    await runtime.onTurnStopping(lead.value);
    expect(lead.messages).toHaveLength(3);
    expect((await runtime.status(mission.id))[0]?.turnCount).toBe(2);

    await runtime.pause(mission.id, lead.value);
    await runtime.onTurnStopping(lead.value);
    expect(lead.messages).toHaveLength(3);
  });

  it("requires the owning agent and resumes a persisted mission on another agent", async () => {
    const { runtime, store } = await makeRuntime();
    const lead = agent("lead");
    const other = agent("other");
    const mission = await runtime.start({
      goal: "Recover after restart.",
      agent: lead.value,
    });
    await expect(
      runtime.checkpoint(mission.id, other.value, "forged"),
    ).rejects.toThrow("owned by another agent");
    await runtime.checkpoint(
      mission.id,
      lead.value,
      "Finished the first investigation phase.",
    );

    const resumed = await runtime.resume(mission.id, other.value);
    expect(resumed.agentId).toBe("other");
    expect(other.messages).toHaveLength(1);
    expect((await store.read()).missions[mission.id]?.checkpoint).toContain(
      "Finished",
    );
  });

  it("bounds event history and preserves checkpoints across a fresh store instance", async () => {
    const { dir, runtime } = await makeRuntime({ maxEventHistory: 3 });
    const lead = agent("lead");
    const mission = await runtime.start({
      goal: "Bound history.",
      agent: lead.value,
    });
    await runtime.checkpoint(mission.id, lead.value, "one");
    await runtime.onTurnStopping(lead.value);
    await runtime.checkpoint(mission.id, lead.value, "two");
    await runtime.onTurnStopping(lead.value);
    await runtime.checkpoint(mission.id, lead.value, "three");

    const state = await new FileMissionStore(dir).read();
    const saved = state.missions[mission.id];
    expect(saved?.checkpoint).toBe("three");
    expect(saved?.events.length).toBe(3);
    expect(
      JSON.parse(await readFile(join(dir, "missions.json"), "utf8")).version,
    ).toBe(1);
  });
});

it("uses a persistent lease to reject duplicate runtime ownership and allows takeover after expiry", async () => {
  const { dir } = await makeRuntime();
  const first = new MissionRuntime(new FileMissionStore(dir), {
    stateDir: dir,
    leaseMs: 20,
  });
  const second = new MissionRuntime(new FileMissionStore(dir), {
    stateDir: dir,
    leaseMs: 20,
  });
  const lead = agent("lead");
  const takeover = agent("takeover");
  const mission = await first.start({
    goal: "Lease this mission.",
    agent: lead.value,
  });
  await expect(second.resume(mission.id, takeover.value)).rejects.toThrow(
    "leased by another runtime",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expect(
    second.resume(mission.id, takeover.value),
  ).resolves.toMatchObject({ agentId: "takeover" });
});
