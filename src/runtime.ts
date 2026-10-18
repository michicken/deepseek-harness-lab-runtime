import { randomUUID } from "node:crypto";
import type {
  MissionEventKind,
  MissionMessageFactory,
  MissionRecord,
  MissionRuntimeConfig,
  MissionStartInput,
  MissionStore,
  MissionSummary,
  MissionAgent,
} from "./types.js";

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_CHECKPOINT_CHARS = 16_000;
type EventInput = { readonly kind: MissionEventKind; readonly detail?: string };

export class MissionRuntime {
  private readonly store: MissionStore;
  private readonly config: Required<
    Pick<
      MissionRuntimeConfig,
      | "maxEventHistory"
      | "maxCheckpointChars"
      | "continuationDelayMs"
      | "leaseMs"
    >
  >;
  private readonly pending = new Set<Promise<void>>();
  private readonly continuing = new Set<string>();
  private readonly ownerId = `runtime-${randomUUID()}`;
  private readonly message: MissionMessageFactory;
  private disposed = false;

  constructor(
    store: MissionStore,
    config: MissionRuntimeConfig,
    messageFactory: MissionMessageFactory = (text) => ({
      content: [{ type: "text", text }],
      source: { kind: "long-running" },
    }),
  ) {
    this.store = store;
    this.message = messageFactory;
    this.config = {
      maxEventHistory: config.maxEventHistory ?? DEFAULT_MAX_EVENTS,
      maxCheckpointChars:
        config.maxCheckpointChars ?? DEFAULT_MAX_CHECKPOINT_CHARS,
      continuationDelayMs: config.continuationDelayMs ?? 0,
      leaseMs: config.leaseMs ?? 60_000,
    };
  }

  async start(input: MissionStartInput): Promise<MissionSummary> {
    this.ensureOpen();
    const goal = normalizeText(input.goal, "goal");
    const now = Date.now();
    const id = `mission-${randomUUID()}`;
    const record: MissionRecord = {
      id,
      goal,
      status: "running",
      agentId: input.agent.id,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      leaseOwner: this.ownerId,
      leaseExpiresAt: now + this.config.leaseMs,
      checkpoint: "No work has been completed yet.",
      events: [
        { at: now, kind: "created" },
        {
          at: now,
          kind: "claimed",
          detail: `${input.agent.id}:${this.ownerId}`,
        },
      ],
    };
    await this.store.transact((state) => ({
      state: { ...state, missions: { ...state.missions, [id]: record } },
      result: undefined,
    }));
    try {
      input.agent.followup(this.message(this.startPrompt(record)));
    } catch (error: unknown) {
      await this.fail(id, errorMessage(error));
      throw error;
    }
    return summarize(record);
  }

  async resume(id: string, agent: MissionAgent): Promise<MissionSummary> {
    this.ensureOpen();
    const record = await this.store.transact((state) => {
      const current = requireMission(state, id);
      if (current.status === "completed" || current.status === "stopped")
        throw new Error(`mission ${id} is terminal`);
      const now = Date.now();
      if (
        current.leaseExpiresAt !== undefined &&
        current.leaseExpiresAt > now &&
        current.leaseOwner !== this.ownerId
      ) {
        throw new Error(`mission ${id} is leased by another runtime`);
      }
      const next = this.update(
        current,
        {
          status: "running",
          agentId: agent.id,
          leaseOwner: this.ownerId,
          leaseExpiresAt: now + this.config.leaseMs,
          updatedAt: now,
        },
        { kind: "recovered", detail: `${agent.id}:${this.ownerId}` },
      );
      return { state: replaceMission(state, next), result: next };
    });
    agent.followup(this.message(this.resumePrompt(record)));
    return summarize(record);
  }

  async onTurnStopping(agent: MissionAgent): Promise<void> {
    if (this.disposed) return;
    const state = await this.store.read();
    const record = Object.values(state.missions).find(
      (mission) => mission.agentId === agent.id && mission.status === "running",
    );
    if (record === undefined) return;
    if (this.continuing.has(record.id)) return;
    this.continuing.add(record.id);
    const task = this.continueMission(record.id, agent);
    this.pending.add(task);
    task
      .finally(() => {
        this.pending.delete(task);
        this.continuing.delete(record.id);
      })
      .catch(() => undefined);
    await task;
  }

  async checkpoint(
    id: string,
    agent: MissionAgent,
    text: string,
  ): Promise<MissionSummary> {
    const value = normalizeText(text, "checkpoint").slice(
      0,
      this.config.maxCheckpointChars,
    );
    const record = await this.store.transact((state) => {
      const current = requireMission(state, id);
      assertOwner(current, agent);
      assertLease(current, this.ownerId);
      if (current.status !== "running")
        throw new Error(`mission ${id} is not running`);
      const next = this.update(
        current,
        { checkpoint: value, updatedAt: Date.now() },
        { kind: "checkpoint" },
      );
      return { state: replaceMission(state, next), result: next };
    });
    return summarize(record);
  }

  async complete(
    id: string,
    agent: MissionAgent,
    detail?: string,
  ): Promise<MissionSummary> {
    return this.finish(id, agent, "completed", detail);
  }

  async pause(id: string, agent: MissionAgent): Promise<MissionSummary> {
    return this.finish(id, agent, "paused");
  }

  async stop(
    id: string,
    agent: MissionAgent,
    detail?: string,
  ): Promise<MissionSummary> {
    return this.finish(id, agent, "stopped", detail);
  }

  async fail(id: string, detail: string): Promise<void> {
    await this.store.transact((state) => {
      const current = state.missions[id];
      if (current === undefined || isTerminal(current.status))
        return { state, result: undefined };
      const next = this.update(
        current,
        { status: "failed", lastError: detail, updatedAt: Date.now() },
        { kind: "failed", detail },
      );
      delete (next as { leaseOwner?: string }).leaseOwner;
      delete (next as { leaseExpiresAt?: number }).leaseExpiresAt;
      return { state: replaceMission(state, next), result: undefined };
    });
  }

  async status(id?: string, agent?: MissionAgent): Promise<MissionSummary[]> {
    const state = await this.store.read();
    if (id !== undefined) {
      const record = requireMission(state, id);
      if (agent !== undefined) assertOwner(record, agent);
      return [summarize(record)];
    }
    const records = Object.values(state.missions).filter(
      (record) => agent === undefined || record.agentId === agent.id,
    );
    return records.map(summarize);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.pending);
  }

  private async continueMission(
    id: string,
    agent: MissionAgent,
  ): Promise<void> {
    if (this.config.continuationDelayMs > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.continuationDelayMs),
      );
    const record = await this.store.transact((state) => {
      const current = requireMission(state, id);
      const now = Date.now();
      if (
        current.status !== "running" ||
        current.agentId !== agent.id ||
        current.leaseOwner !== this.ownerId ||
        (current.leaseExpiresAt ?? 0) <= now
      )
        return { state, result: undefined };
      const next = this.update(
        current,
        {
          turnCount: current.turnCount + 1,
          lastTurnAt: now,
          leaseExpiresAt: now + this.config.leaseMs,
          updatedAt: now,
        },
        { kind: "continued" },
      );
      return { state: replaceMission(state, next), result: next };
    });
    if (record === undefined || this.disposed) return;
    agent.followup(this.message(this.continuationPrompt(record)));
  }

  private async finish(
    id: string,
    agent: MissionAgent,
    status: "paused" | "stopped" | "completed",
    detail?: string,
  ): Promise<MissionSummary> {
    const record = await this.store.transact((state) => {
      const current = requireMission(state, id);
      assertOwner(current, agent);
      assertLease(current, this.ownerId);
      if (isTerminal(current.status) && current.status !== "paused")
        return { state, result: current };
      const now = Date.now();
      const next = this.update(
        current,
        {
          status,
          updatedAt: now,
          ...(status === "stopped" && detail !== undefined
            ? { lastError: detail }
            : {}),
        },
        { kind: status, ...(detail === undefined ? {} : { detail }) },
      );
      delete (next as { leaseOwner?: string }).leaseOwner;
      delete (next as { leaseExpiresAt?: number }).leaseExpiresAt;
      return { state: replaceMission(state, next), result: next };
    });
    return summarize(record);
  }

  private update(
    record: MissionRecord,
    patch: Partial<MissionRecord>,
    event: EventInput,
  ): MissionRecord {
    return updateRecord(record, patch, event, this.config.maxEventHistory);
  }

  private startPrompt(record: MissionRecord): string {
    return `You are the lead of a durable long-running mission. Mission ID: ${record.id}.\nGoal: ${record.goal}\n\nBegin working immediately. Make concrete progress, use available tools, and call lab_mission_checkpoint after meaningful progress. The runtime will automatically give you another turn while this mission is running. Call lab_mission_complete only when the goal is actually complete, lab_mission_pause when human input is required, or lab_mission_stop when the mission must stop.`;
  }

  private resumePrompt(record: MissionRecord): string {
    return `Resume mission ${record.id}.\nGoal: ${record.goal}\nLast checkpoint: ${record.checkpoint}\nTurn count: ${record.turnCount}\n\nRecover the state from the workspace and checkpoint, then continue from the next useful action. Do not restart completed work. Use lab_mission_checkpoint as you progress.`;
  }

  private continuationPrompt(record: MissionRecord): string {
    return `Continue mission ${record.id}.\nGoal: ${record.goal}\nCheckpoint: ${record.checkpoint}\nThis is continuation ${record.turnCount}. Inspect the current state, choose the next highest-value action, and execute it. Continue until the goal is complete or blocked. Call lab_mission_checkpoint after meaningful progress; call lab_mission_complete only when done.`;
  }

  private ensureOpen(): void {
    if (this.disposed)
      throw new Error("long-running mission runtime is disposed");
  }
}

function updateRecord(
  record: MissionRecord,
  patch: Partial<MissionRecord>,
  event: EventInput,
  limit = DEFAULT_MAX_EVENTS,
): MissionRecord {
  const events = [...record.events, { at: Date.now(), ...event }].slice(-limit);
  return { ...record, ...patch, events };
}

function replaceMission(
  state: { version: 1; missions: Record<string, MissionRecord> },
  record: MissionRecord,
) {
  return { ...state, missions: { ...state.missions, [record.id]: record } };
}

function requireMission(
  state: { missions: Record<string, MissionRecord> },
  id: string,
): MissionRecord {
  const record = state.missions[id];
  if (record === undefined) throw new Error(`unknown mission: ${id}`);
  return record;
}

function assertOwner(record: MissionRecord, agent: MissionAgent): void {
  if (record.agentId !== agent.id)
    throw new Error(`mission ${record.id} is owned by another agent`);
}

function assertLease(record: MissionRecord, ownerId: string): void {
  if (
    record.leaseOwner !== ownerId ||
    (record.leaseExpiresAt ?? 0) <= Date.now()
  ) {
    throw new Error(`mission ${record.id} lease is not held by this runtime`);
  }
}

function isTerminal(status: MissionRecord["status"]): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}

function summarize(record: MissionRecord): MissionSummary {
  const {
    events,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = record;
  return { ...rest, eventCount: events.length };
}

function normalizeText(value: string, name: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${name} must not be empty`);
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
