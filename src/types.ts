/** Durable mission vocabulary; no application-wide token or round budget. */
export type MissionStatus =
  | "ready"
  | "running"
  | "waiting"
  | "paused"
  | "blocked"
  | "stopped"
  | "completed";
export interface Mission {
  id: string;
  owner: string;
  goal: string;
  cwd: string;
  provider: string;
  model: string;
  mode: "finite" | "continuous";
  executionMode: "worker" | "visible";
  targets: string[];
  status: MissionStatus;
  checkpoint: string;
  round: number;
  failures: number;
  stagnantRounds: number;
  revision: number;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: string;
  leaseOwner: string | null;
  leaseUntil: number;
  fence: number;
}
export interface Lease {
  mission: Mission;
  worker: string;
  fence: number;
}
export interface RoundReport {
  action: "continue" | "wait" | "complete" | "blocked";
  checkpoint: string;
  evidence: string[];
  progress: boolean;
  waitMs: number;
}
export interface LabTask {
  id: string;
  missionId: string;
  title: string;
  status: "pending" | "doing" | "done";
  dependsOn: string[];
  evidence: string[];
  revision: number;
}
export interface Finding {
  id: string;
  missionId: string;
  title: string;
  target: string;
  classification:
    "static" | "lab-reproduced" | "impact-verified" | "not-reproduced";
  prerequisites: string;
  evidence: { path: string; sha256: string }[];
  at: number;
}
export interface RoundContext {
  lease: Lease;
  signal: AbortSignal;
  checkpoint(text: string): void;
  tasks: {
    list(): LabTask[];
    create(title: string, dependsOn: string[]): LabTask;
    update(
      id: string,
      revision: number,
      status: LabTask["status"],
      evidence: string[],
    ): LabTask;
  };
}
export interface RoundExecutor {
  run(context: RoundContext): Promise<RoundReport>;
  /** Whether the owner execution context exists now; unavailable visible missions stay unclaimed. */
  canRun?(mission: Mission): boolean;
}
export interface RuntimeOptions {
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  heartbeatMs: number;
  roundTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxConsecutiveFailures: number;
  maxStagnantRounds: number;
  roundIntervalMs: number;
}
export const defaults: RuntimeOptions = {
  concurrency: 1,
  pollMs: 1000,
  leaseMs: 30000,
  heartbeatMs: 5000,
  roundTimeoutMs: 60 * 60 * 1000,
  retryBaseMs: 5000,
  retryMaxMs: 5 * 60 * 1000,
  maxConsecutiveFailures: 8,
  maxStagnantRounds: 6,
  roundIntervalMs: 2000,
};
export class LeaseLostError extends Error {
  constructor() {
    super("Mission lease lost or revoked");
    this.name = "LeaseLostError";
  }
}
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
