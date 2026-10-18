import { afterEach, describe, expect, it } from "vitest";
import { MissionRuntime } from "../src/runtime.js";
import { PermanentError, type RoundExecutor } from "../src/types.js";
import { fixture, input, report, until } from "./helpers.js";
const fixtures: ReturnType<typeof fixture>[] = [];
const runtimes: MissionRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  fixtures.splice(0).forEach((f) => f.close());
});
function setup(executor: RoundExecutor, options = {}) {
  const f = fixture();
  fixtures.push(f);
  const runtime = new MissionRuntime(f.store, executor, {
    pollMs: 10,
    heartbeatMs: 10,
    leaseMs: 100,
    roundIntervalMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 20,
    ...options,
  });
  runtimes.push(runtime);
  return { ...f, runtime };
}
describe("scheduler", () => {
  it("continues across fresh rounds and finishes a verified finite objective", async () => {
    let calls = 0;
    const { store, runtime } = setup({
      async run(c) {
        c.checkpoint(`round ${++calls}`);
        return report(calls === 3 ? "complete" : "continue");
      },
    });
    const m = store.create(input);
    runtime.start();
    await until(() => store.get(m.id).status === "completed");
    expect(calls).toBe(3);
    expect(store.get(m.id).round).toBe(3);
  });
  it("renews leases during a long model/tool call", async () => {
    const { store, runtime } = setup({
      async run() {
        await new Promise((r) => setTimeout(r, 350));
        return report("complete");
      },
    });
    const m = store.create(input);
    runtime.start();
    await until(() => runtime.running === 1);
    await new Promise((r) => setTimeout(r, 220));
    expect(store.claim("competitor", 100)).toBeUndefined();
    await until(() => store.get(m.id).status === "completed");
  });
  it("does not apply a fixed round timeout to visible continuous missions", async () => {
    let started = false;
    let aborted = false;
    const { store, runtime } = setup(
      {
        async run(c) {
          started = true;
          await new Promise<void>((resolve) => {
            c.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return report();
        },
      },
      { roundTimeoutMs: 10, heartbeatMs: 10, leaseMs: 100 },
    );
    const m = store.create({
      ...input,
      mode: "continuous",
      executionMode: "visible",
    });
    runtime.start();
    await until(() => started);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.get(m.id).status).toBe("running");
    await runtime.stop();
    expect(aborted).toBe(true);
  });
  it("retries transient failures and opens a circuit on repeated failure", async () => {
    let calls = 0;
    const { store, runtime } = setup(
      {
        async run() {
          calls++;
          throw new Error("network temporarily down");
        },
      },
      { maxConsecutiveFailures: 3 },
    );
    const m = store.create(input);
    runtime.start();
    await until(() => store.get(m.id).status === "blocked");
    expect(calls).toBe(3);
    expect(store.get(m.id).failures).toBe(3);
  });
  it("blocks permanent authentication/config failures without burning retries", async () => {
    const { store, runtime } = setup({
      async run() {
        throw new PermanentError("AUTH invalid credential");
      },
    });
    const m = store.create(input);
    runtime.start();
    await until(() => store.get(m.id).status === "blocked");
    expect(store.get(m.id).failures).toBe(1);
  });
  it("keeps continuous missions waiting instead of opening an automatic circuit", async () => {
    let calls = 0;
    const { store, runtime } = setup(
      {
        async run() {
          calls++;
          throw new PermanentError("AUTH temporarily unavailable");
        },
      },
      { retryBaseMs: 1, retryMaxMs: 1, maxConsecutiveFailures: 2 },
    );
    const m = store.create({ ...input, mode: "continuous" });
    runtime.start();
    await until(() => calls >= 3);
    expect(store.get(m.id).status).toBe("waiting");
    expect(store.get(m.id).status).not.toBe("blocked");
    expect(store.get(m.id).status).not.toBe("completed");
  });
  it("cancels a paused worker and cannot commit a stale report", async () => {
    let observed = false;
    const { store, runtime } = setup({
      async run(c) {
        await new Promise<void>((resolve) => {
          c.signal.addEventListener(
            "abort",
            () => {
              observed = true;
              resolve();
            },
            { once: true },
          );
        });
        return report("complete");
      },
    });
    const m = store.create(input);
    runtime.start();
    await until(() => runtime.running === 1);
    store.control(m.id, "pause");
    await until(() => observed && runtime.running === 0);
    expect(store.get(m.id).status).toBe("paused");
    expect(store.get(m.id).round).toBe(0);
  });
  it("releases work on graceful shutdown and a new runtime resumes its checkpoint", async () => {
    const first = setup({
      async run(c) {
        c.checkpoint("Step A complete");
        await new Promise<void>((resolve) =>
          c.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        c.signal.throwIfAborted();
        return report();
      },
    });
    const m = first.store.create(input);
    first.runtime.start();
    await until(() => first.store.get(m.id).checkpoint !== "");
    await first.runtime.stop();
    expect(first.store.get(m.id).status).toBe("ready");
    const recovered = new MissionRuntime(
      first.store,
      {
        async run(c) {
          expect(c.lease.mission.checkpoint).toBe("Step A complete");
          return report("complete");
        },
      },
      { pollMs: 10 },
    );
    runtimes.push(recovered);
    recovered.start();
    await until(() => first.store.get(m.id).status === "completed");
  });
  it("rejects unsafe timing configuration", () => {
    const f = fixture();
    fixtures.push(f);
    expect(
      () =>
        new MissionRuntime(
          f.store,
          {
            async run() {
              return report();
            },
          },
          { leaseMs: 10, heartbeatMs: 10 },
        ),
    ).toThrow("three heartbeat");
  });
});
