import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MissionState, MissionStore } from "./types.js";

const INITIAL_STATE: MissionState = { version: 1, missions: {} };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface FileMissionStoreOptions {
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

/** Atomic JSON store with an inter-process lock for mission state transitions. */
export class FileMissionStore implements MissionStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private processMutex: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: FileMissionStoreOptions = {}) {
    this.filePath = join(stateDir, "missions.json");
    this.lockPath = join(stateDir, "missions.json.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
  }

  async read(): Promise<MissionState> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      return validateState(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return INITIAL_STATE;
      throw error;
    }
  }

  async transact<T>(
    fn: (
      state: MissionState,
    ) =>
      | Promise<{ state: MissionState; result: T }>
      | { state: MissionState; result: T },
  ): Promise<T> {
    let resolveOuter!: () => void;
    const previous = this.processMutex;
    this.processMutex = new Promise<void>((resolve) => {
      resolveOuter = resolve;
    });
    await previous;
    try {
      return await this.withFileLock(async () => {
        const current = await this.read();
        const next = await fn(current);
        validateState(next.state);
        await this.write(next.state);
        return next.result;
      });
    } finally {
      resolveOuter();
    }
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (handle === undefined) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            token: randomUUID(),
            at: Date.now(),
          }),
        );
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
        if (await this.isStaleLock()) await rm(this.lockPath, { force: true });
        if (Date.now() >= deadline)
          throw new Error(`mission store lock timeout: ${this.lockPath}`);
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.lockPath, { force: true });
    }
  }

  private async isStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      return Date.now() - info.mtimeMs > this.staleLockMs;
    } catch (error: unknown) {
      return isNodeError(error, "ENOENT");
    }
  }

  private async write(state: MissionState): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, this.filePath);
  }
}

function validateState(value: unknown): MissionState {
  if (typeof value !== "object" || value === null)
    throw new Error("mission state must be an object");
  const state = value as Partial<MissionState>;
  if (
    state.version !== 1 ||
    typeof state.missions !== "object" ||
    state.missions === null
  ) {
    throw new Error("unsupported mission state version");
  }
  return state as MissionState;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
