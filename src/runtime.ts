import { randomUUID } from "node:crypto";
import { MissionStore } from "./store.js";
import {
  defaults,
  LeaseLostError,
  PermanentError,
  type Lease,
  type RoundExecutor,
  type RuntimeOptions,
} from "./types.js";
/** Persistent scheduler. Each round gets a fresh Agent, and only a fenced report advances the mission. */
export class MissionRuntime {
  readonly options: RuntimeOptions;
  readonly worker = `worker-${randomUUID()}`;
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(
    readonly store: MissionStore,
    private readonly executor: RoundExecutor,
    options: Partial<RuntimeOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    for (const [key, value] of Object.entries(this.options))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${key} must be a positive safe integer`);
    if (this.options.heartbeatMs * 3 > this.options.leaseMs)
      throw new Error("leaseMs must be at least three heartbeat intervals");
    if (this.options.retryMaxMs < this.options.retryBaseMs)
      throw new Error("retryMaxMs must be >= retryBaseMs");
  }
  start(): void {
    if (this.stopped) throw new Error("Runtime stopped");
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.pollMs);
    this.tick();
  }
  tick(): void {
    if (this.stopped) return;
    try {
      while (this.active.size < this.options.concurrency) {
        const lease = this.store.claim(this.worker, this.options.leaseMs);
        if (!lease) break;
        const controller = new AbortController();
        const done = Promise.resolve()
          .then(() => this.run(lease, controller))
          .finally(() => this.active.delete(lease.mission.id));
        this.active.set(lease.mission.id, { controller, done });
        // run() owns durable failures; unexpected storage failures must remain visible.
        void done.catch((error) => this.onError(error));
      }
    } catch (error) {
      this.onError(error);
    }
  }
  onError: (error: unknown) => void = (error) => {
    console.error(
      "[lab-runtime]",
      error instanceof Error ? error.message : String(error),
    );
  };
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const active of this.active.values())
      active.controller.abort(new Error("Runtime shutting down"));
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
  get running(): number {
    return this.active.size;
  }
  private async run(lease: Lease, controller: AbortController): Promise<void> {
    const heartbeat = setInterval(() => {
      try {
        this.store.renew(lease, this.options.leaseMs);
      } catch (error) {
        controller.abort(error);
      }
    }, this.options.heartbeatMs);
    const timeout = setTimeout(
      () => controller.abort(new Error("Round timeout; retry from checkpoint")),
      this.options.roundTimeoutMs,
    );
    try {
      const report = await this.executor.run({
        lease,
        signal: controller.signal,
        checkpoint: (text) => this.store.checkpoint(lease, text),
        tasks: {
          list: () => {
            this.store.assertLease(lease);
            return this.store.tasks(lease.mission.id);
          },
          create: (title, deps) => this.store.createTask(lease, title, deps),
          update: (id, revision, status, evidence) =>
            this.store.updateTask(lease, id, revision, status, evidence),
        },
      });
      controller.signal.throwIfAborted();
      this.store.settle(
        lease,
        report,
        this.options.roundIntervalMs,
        this.options.maxStagnantRounds,
      );
    } catch (error) {
      if (this.stopped) {
        try {
          this.store.release(lease);
        } catch (releaseError) {
          if (!(releaseError instanceof LeaseLostError)) throw releaseError;
        }
        return;
      }
      if (
        error instanceof LeaseLostError ||
        controller.signal.reason instanceof LeaseLostError
      )
        return;
      const retry = Math.min(
        this.options.retryMaxMs,
        this.options.retryBaseMs * 2 ** Math.min(lease.mission.failures, 20),
      );
      try {
        this.store.fail(
          lease,
          error instanceof Error ? error.message : String(error),
          retry,
          this.options.maxConsecutiveFailures,
          error instanceof PermanentError,
        );
      } catch (commitError) {
        if (!(commitError instanceof LeaseLostError)) throw commitError;
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }
}
