import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMissionStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("FileMissionStore", () => {
  it("creates the state directory and atomically writes valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-lab-store-"));
    dirs.push(dir);
    const store = new FileMissionStore(join(dir, "nested"));
    await store.transact((state) => ({
      state: { ...state, missions: { x: { id: "x" } as never } },
      result: true,
    }));
    const parsed = JSON.parse(
      await readFile(join(dir, "nested", "missions.json"), "utf8"),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.missions.x.id).toBe("x");
  });

  it("serializes concurrent transactions in one process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-lab-store-"));
    dirs.push(dir);
    const store = new FileMissionStore(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.transact((state) => {
          const count = Number(
            (state.missions.counter as { count?: number } | undefined)?.count ??
              0,
          );
          return {
            state: {
              ...state,
              missions: {
                ...state.missions,
                counter: { count: count + 1 } as never,
              },
            },
            result: undefined,
          };
        }),
      ),
    );
    expect((await store.read()).missions.counter).toEqual({ count: 20 });
  });
});

it("serializes transactions across two store instances sharing one file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-lab-store-"));
  dirs.push(dir);
  const first = new FileMissionStore(dir);
  const second = new FileMissionStore(dir);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? first : second).transact(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const count = Number(
          (state.missions.counter as { count?: number } | undefined)?.count ??
            0,
        );
        return {
          state: {
            ...state,
            missions: {
              ...state.missions,
              counter: { count: count + 1 } as never,
            },
          },
          result: undefined,
        };
      }),
    ),
  );
  expect((await first.read()).missions.counter).toEqual({ count: 12 });
});
