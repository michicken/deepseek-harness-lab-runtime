import { afterEach, describe, it, expect } from "vitest";
import { MissionStore } from "../src/store.js";
import { LeaseLostError } from "../src/types.js";
import { fixture, input, report } from "./helpers.js";
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.close()));
function setup() {
  const f = fixture();
  fixtures.push(f);
  return f;
}
describe("transactional mission store", () => {
  it("claims once across independent connections and fences an expired worker", () => {
    const { store } = setup();
    const m = store.create(input, 100);
    const other = new MissionStore(store.path);
    try {
      const first = store.claim("one", 1000, 100)!;
      expect(other.claim("two", 1000, 500)).toBeUndefined();
      const next = other.claim("two", 1000, 1101)!;
      expect(next.fence).toBe(first.fence + 1);
      expect(() => store.assertLease(first, 1102)).toThrow(LeaseLostError);
      expect(other.assertLease(next, 1102).id).toBe(m.id);
    } finally {
      other.close();
    }
  });
  it("leaves visible missions unclaimed until their owner Session is available", () => {
    const { store } = setup();
    const mission = store.create({ ...input, executionMode: "visible" });
    expect(
      store.claim(
        "runtime",
        10000,
        Date.now(),
        (candidate) => candidate.executionMode !== "visible",
      ),
    ).toBeUndefined();
    expect(store.get(mission.id).status).toBe("ready");
    expect(
      store.events(mission.id).some((event) => event.kind === "claimed"),
    ).toBe(false);
  });
  it("preserves checkpoint and state after reopening", () => {
    const { store } = setup();
    const m = store.create(input);
    const lease = store.claim("worker", 10000)!;
    store.checkpoint(lease, "Artifact A exists; next B");
    const other = new MissionStore(store.path);
    try {
      expect(other.get(m.id).checkpoint).toContain("Artifact A");
      expect(other.health().ok).toBe(true);
    } finally {
      other.close();
    }
  });
  it("enforces controller ownership, canonical workspace exclusion, and duplicate prevention", () => {
    const { store } = setup();
    const m = store.create(input);
    expect(() => store.get(m.id, "stranger")).toThrow("another controller");
    expect(() => store.create(input)).toThrow("unfinished");
    store.create({ ...input, owner: "second" });
    expect(store.claim("one", 10000)).toBeDefined();
    expect(store.claim("two", 10000)).toBeUndefined();
  });
  it("pauses and stops by revoking the lease immediately", () => {
    const { store } = setup();
    const m = store.create(input);
    const lease = store.claim("worker", 10000)!;
    store.control(m.id, "pause", "controller");
    expect(() => store.checkpoint(lease, "stale")).toThrow(LeaseLostError);
    store.control(m.id, "resume");
    expect(store.claim("new", 10000)).toBeDefined();
    store.control(m.id, "stop");
    expect(() => store.control(m.id, "resume")).toThrow("terminal");
  });
  it("uses CAS and enforces the task dependency DAG and completion evidence", () => {
    const { store } = setup();
    store.create(input);
    const lease = store.claim("worker", 10000)!;
    const a = store.createTask(lease, "Experiment", []);
    const b = store.createTask(lease, "Review", [a.id]);
    expect(() => store.updateTask(lease, b.id, 1, "doing", [])).toThrow(
      "dependencies",
    );
    expect(() => store.updateTask(lease, a.id, 99, "done", ["x"])).toThrow(
      "revision",
    );
    expect(() => store.updateTask(lease, a.id, 1, "done", [])).toThrow(
      "evidence",
    );
    store.updateTask(lease, a.id, 1, "done", ["test passed"]);
    expect(() => store.settle(lease, report("complete"), 100, 4)).toThrow(
      "all declared",
    );
    store.updateTask(lease, b.id, 1, "done", ["reviewed"]);
    expect(store.settle(lease, report("complete"), 100, 4).status).toBe(
      "completed",
    );
  });
  it("retains finite history and blocks a stagnant objective", () => {
    const { store } = setup();
    const m = store.create(input);
    let lease = store.claim("worker", 10000)!;
    store.settle(lease, { ...report(), progress: false }, 1, 2);
    lease = store.claim("worker", 10000, Date.now() + 10)!;
    store.settle(lease, { ...report(), progress: false }, 1, 2);
    expect(store.get(m.id).status).toBe("blocked");
    expect(store.events(m.id).length).toBeGreaterThan(3);
  });
  it("keeps continuous missions alive and persists wait deadlines", () => {
    const { store } = setup();
    const m = store.create({ ...input, mode: "continuous" });
    const lease = store.claim("worker", 10000)!;
    const next = store.settle(lease, report("complete"), 1, 3);
    expect(next.status).toBe("waiting");
    expect(store.events(m.id)[0]).toMatchObject({
      kind: "round-settled",
      data: expect.stringContaining('"action":"wait"'),
    });
    const retry = store.claim("worker", 10000, next.nextRunAt)!;
    const blockedAsWait = store.settle(
      retry,
      { ...report("blocked"), waitMs: 60000 },
      1,
      3,
    );
    expect(blockedAsWait.status).toBe("waiting");
    expect(store.get(m.id).status).not.toBe("completed");
    expect(store.get(m.id).status).not.toBe("blocked");
    expect(store.get(m.id).nextRunAt).toBeGreaterThan(Date.now() + 59000);
  });
});
