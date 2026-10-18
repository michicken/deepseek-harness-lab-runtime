export type MissionStatus =
  "running" | "paused" | "stopped" | "completed" | "failed";
export type MissionEventKind =
  | "created"
  | "claimed"
  | "continued"
  | "checkpoint"
  | "paused"
  | "resumed"
  | "stopped"
  | "completed"
  | "failed"
  | "recovered";

export interface MissionEvent {
  readonly at: number;
  readonly kind: MissionEventKind;
  readonly detail?: string;
}

export interface MissionRecord {
  readonly id: string;
  readonly goal: string;
  readonly status: MissionStatus;
  readonly agentId?: string;
  readonly cwd?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastTurnAt?: number;
  readonly turnCount: number;
  readonly checkpoint: string;
  readonly lastError?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly events: readonly MissionEvent[];
}

export interface MissionState {
  readonly version: 1;
  readonly missions: Record<string, MissionRecord>;
}

export interface MissionSummary extends Omit<
  MissionRecord,
  "events" | "leaseOwner" | "leaseExpiresAt"
> {
  readonly eventCount: number;
}

export interface MissionStartInput {
  readonly goal: string;
  readonly cwd?: string;
  readonly agent: MissionAgent;
}

export interface MissionRuntimeConfig {
  readonly stateDir?: string;
  readonly lockTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly maxEventHistory?: number;
  readonly maxCheckpointChars?: number;
  readonly continuationDelayMs?: number;
}

export interface MissionStore {
  read(): Promise<MissionState>;
  transact<T>(
    fn: (
      state: MissionState,
    ) =>
      | Promise<{ state: MissionState; result: T }>
      | { state: MissionState; result: T },
  ): Promise<T>;
}

export interface MissionAgent {
  readonly id: string;
  followup(message: unknown): void;
  steer(message: unknown): void;
}

export type MissionMessageFactory = (text: string) => unknown;
