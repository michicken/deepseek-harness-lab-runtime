import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LeaseLostError,
  type Mission,
  type Lease,
  type RoundReport,
  type LabTask,
  type Finding,
} from "./types.js";

export interface NewMission {
  owner: string;
  goal: string;
  cwd: string;
  provider: string;
  model: string;
  mode?: "finite" | "continuous";
  targets?: string[];
}
/** SQLite WAL + BEGIN IMMEDIATE: claims, checkpoints and reports share a fenced transaction. */
export class MissionStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    readonly path: string,
    private readonly eventRetention = 2000,
  ) {
    if (!isAbsolute(path)) throw new Error("database path must be absolute");
    if (!Number.isSafeInteger(eventRetention) || eventRetention < 10)
      throw new Error("eventRetention must be at least 10");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error(`Unsupported database version ${String(version)}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL,
        due INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        fence INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS missions_ready ON missions(status,due);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_mission ON tasks(mission_id);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES missions(id),
        at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_mission ON events(mission_id,seq);
      PRAGMA user_version=1;
    `);
  }
  create(input: NewMission, now = Date.now()): Mission {
    for (const [key, value] of Object.entries(input))
      if (key !== "targets" && (typeof value !== "string" || !value.trim()))
        throw new Error(`Invalid ${key}`);
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
    if (input.goal.length > 32000)
      throw new Error("Goal exceeds 32000 characters");
    return this.tx(() => {
      // One active objective per controller/workspace; model retries cannot create duplicate missions.
      const duplicate = this.list(input.owner).find(
        (m) =>
          m.cwd === input.cwd && !["stopped", "completed"].includes(m.status),
      );
      if (duplicate)
        throw new Error(
          `An unfinished mission already owns this workspace: ${duplicate.id}`,
        );
      const mission: Mission = {
        ...input,
        mode: input.mode ?? "finite",
        targets: input.targets ?? [],
        id: `mission-${randomUUID()}`,
        status: "ready",
        checkpoint: "",
        round: 0,
        failures: 0,
        stagnantRounds: 0,
        revision: 1,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
        lastError: "",
        leaseOwner: null,
        leaseUntil: 0,
        fence: 0,
      };
      this.save(mission);
      this.event(mission.id, "created", { goal: input.goal });
      return mission;
    });
  }
  get(id: string, owner?: string): Mission {
    const row = this.db.prepare("SELECT data FROM missions WHERE id=?").get(id);
    if (!row || typeof row.data !== "string")
      throw new Error("Unknown mission");
    const mission = JSON.parse(row.data) as Mission;
    if (owner !== undefined && mission.owner !== owner)
      throw new Error("Mission belongs to another controller");
    return mission;
  }
  list(owner?: string): Mission[] {
    const rows =
      owner === undefined
        ? this.db.prepare("SELECT data FROM missions ORDER BY rowid").all()
        : this.db
            .prepare("SELECT data FROM missions WHERE owner=? ORDER BY rowid")
            .all(owner);
    return rows.map((row) => JSON.parse(String(row.data)) as Mission);
  }
  claim(worker: string, leaseMs: number, now = Date.now()): Lease | undefined {
    return this.tx(() => {
      // Workspace exclusion also covers separate daemon processes sharing this database.
      const row = this.db
        .prepare(
          `SELECT id FROM missions m WHERE
        ((m.status IN ('ready','waiting') AND m.due<=?) OR (m.status='running' AND m.lease_until<=?))
        AND NOT EXISTS (SELECT 1 FROM missions other WHERE other.id!=m.id AND other.cwd=m.cwd AND other.status='running' AND other.lease_until>?)
        ORDER BY m.due,m.rowid LIMIT 1`,
        )
        .get(now, now, now);
      if (!row) return undefined;
      const m = this.get(String(row.id));
      const recovered = m.status === "running";
      m.status = "running";
      m.leaseOwner = worker;
      m.leaseUntil = now + leaseMs;
      m.fence++;
      m.updatedAt = now;
      m.revision++;
      this.save(m);
      this.event(m.id, recovered ? "recovered" : "claimed", {
        worker,
        fence: m.fence,
      });
      return { mission: m, worker, fence: m.fence };
    });
  }
  assertLease(lease: Lease, now = Date.now()): Mission {
    const m = this.get(lease.mission.id);
    if (
      m.status !== "running" ||
      m.leaseOwner !== lease.worker ||
      m.fence !== lease.fence ||
      m.leaseUntil <= now
    )
      throw new LeaseLostError();
    return m;
  }
  renew(lease: Lease, leaseMs: number, now = Date.now()): void {
    this.tx(() => {
      const m = this.assertLease(lease, now);
      m.leaseUntil = now + leaseMs;
      this.save(m);
    });
  }
  checkpoint(lease: Lease, text: string): void {
    checkText(text, "checkpoint", 16000);
    this.tx(() => {
      const m = this.assertLease(lease);
      m.checkpoint = text;
      m.updatedAt = Date.now();
      m.revision++;
      this.save(m);
      this.event(m.id, "checkpoint", {});
    });
  }
  settle(
    lease: Lease,
    report: RoundReport,
    intervalMs: number,
    maxStagnant: number,
    now = Date.now(),
  ): Mission {
    checkText(report.checkpoint, "checkpoint", 16000);
    return this.tx(() => {
      const m = this.assertLease(lease, now);
      if (report.action === "complete" && m.mode === "continuous")
        throw new Error(
          "Continuous missions must wait, pause or stop; completion is disabled",
        );
      if (
        report.action === "complete" &&
        (!report.evidence.length ||
          this.tasks(m.id).some((t) => t.status !== "done"))
      )
        throw new Error(
          "Completion requires evidence and all declared tasks done",
        );
      m.checkpoint = report.checkpoint;
      m.round++;
      m.failures = 0;
      m.lastError = "";
      m.stagnantRounds = report.progress ? 0 : m.stagnantRounds + 1;
      m.status =
        report.action === "complete"
          ? "completed"
          : report.action === "blocked"
            ? "blocked"
            : "waiting";
      if (m.stagnantRounds >= maxStagnant && report.action === "continue") {
        m.status = "blocked";
        m.lastError = "No measurable progress across consecutive rounds";
      }
      m.nextRunAt =
        now + (report.action === "wait" ? report.waitMs : intervalMs);
      m.updatedAt = now;
      m.revision++;
      m.leaseOwner = null;
      m.leaseUntil = 0;
      this.save(m);
      this.event(m.id, "round-settled", report);
      return m;
    });
  }
  fail(
    lease: Lease,
    error: string,
    retryMs: number,
    maxFailures: number,
    permanent = false,
    now = Date.now(),
  ): Mission {
    return this.tx(() => {
      const m = this.assertLease(lease, now);
      m.failures++;
      m.lastError = redact(error).slice(0, 4000);
      m.status = permanent || m.failures >= maxFailures ? "blocked" : "waiting";
      m.nextRunAt = now + retryMs;
      m.updatedAt = now;
      m.revision++;
      m.leaseOwner = null;
      m.leaseUntil = 0;
      this.save(m);
      this.event(m.id, "round-failed", {
        error: m.lastError,
        failures: m.failures,
      });
      return m;
    });
  }
  release(lease: Lease): void {
    this.tx(() => {
      const m = this.assertLease(lease);
      m.status = "ready";
      m.nextRunAt = Date.now();
      m.leaseOwner = null;
      m.leaseUntil = 0;
      m.fence++;
      m.revision++;
      this.save(m);
      this.event(m.id, "released", {});
    });
  }
  control(
    id: string,
    action: "pause" | "resume" | "stop",
    owner?: string,
  ): Mission {
    return this.tx(() => {
      const m = this.get(id, owner);
      if (["completed", "stopped"].includes(m.status)) {
        if (action === "stop" && m.status === "stopped") return m;
        throw new Error(`Mission is terminal: ${m.status}`);
      }
      if (action === "resume" && !["paused", "blocked"].includes(m.status))
        throw new Error("Only paused or blocked missions can resume");
      m.status =
        action === "resume"
          ? "ready"
          : action === "stop"
            ? "stopped"
            : "paused";
      m.nextRunAt = Date.now();
      m.updatedAt = Date.now();
      m.revision++;
      m.fence++;
      m.leaseOwner = null;
      m.leaseUntil = 0;
      if (action === "resume") {
        m.failures = 0;
        m.stagnantRounds = 0;
        m.lastError = "";
      }
      this.save(m);
      this.event(id, action, {});
      return m;
    });
  }
  tasks(missionId: string): LabTask[] {
    return this.db
      .prepare("SELECT data FROM tasks WHERE mission_id=? ORDER BY rowid")
      .all(missionId)
      .map((row) => JSON.parse(String(row.data)) as LabTask);
  }
  createTask(lease: Lease, title: string, dependsOn: string[]): LabTask {
    checkText(title, "task title", 4000);
    return this.tx(() => {
      this.assertLease(lease);
      const tasks = this.tasks(lease.mission.id);
      if (tasks.length >= 256)
        throw new Error("Task board full; revise existing tasks instead");
      for (const id of dependsOn)
        if (!tasks.some((t) => t.id === id))
          throw new Error("Dependency must belong to this mission");
      const task: LabTask = {
        id: `task-${randomUUID()}`,
        missionId: lease.mission.id,
        title,
        status: "pending",
        dependsOn: [...new Set(dependsOn)],
        evidence: [],
        revision: 1,
      };
      this.saveTask(task);
      this.event(task.missionId, "task-created", { id: task.id });
      return task;
    });
  }
  updateTask(
    lease: Lease,
    id: string,
    revision: number,
    status: LabTask["status"],
    evidence: string[],
  ): LabTask {
    return this.tx(() => {
      this.assertLease(lease);
      const tasks = this.tasks(lease.mission.id);
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error("Task not found in this mission");
      if (task.revision !== revision)
        throw new Error("Task revision conflict; reread board");
      if (
        status !== "pending" &&
        task.dependsOn.some(
          (dep) => tasks.find((t) => t.id === dep)?.status !== "done",
        )
      )
        throw new Error("Task dependencies unfinished");
      if (status === "done" && !evidence.some((e) => e.trim()))
        throw new Error("Task completion requires evidence");
      if (
        task.status === "done" &&
        status !== "done" &&
        tasks.some((t) => t.dependsOn.includes(id) && t.status !== "pending")
      )
        throw new Error("Cannot reopen a dependency of active/done tasks");
      const next = { ...task, status, evidence, revision: revision + 1 };
      this.saveTask(next);
      this.event(task.missionId, "task-updated", { id, status });
      return next;
    });
  }
  addFinding(
    lease: Lease,
    finding: Omit<Finding, "id" | "missionId" | "at">,
  ): Finding {
    return this.tx(() => {
      this.assertLease(lease);
      const value: Finding = {
        ...finding,
        id: `finding-${randomUUID()}`,
        missionId: lease.mission.id,
        at: Date.now(),
      };
      this.db
        .prepare("INSERT INTO findings(id,mission_id,data) VALUES(?,?,?)")
        .run(value.id, value.missionId, JSON.stringify(value));
      this.event(value.missionId, "finding", {
        id: value.id,
        classification: value.classification,
      });
      return value;
    });
  }
  findings(id: string): Finding[] {
    return this.db
      .prepare("SELECT data FROM findings WHERE mission_id=? ORDER BY rowid")
      .all(id)
      .map((row) => JSON.parse(String(row.data)) as Finding);
  }
  recordSession(lease: Lease, sessionId: string): void {
    this.tx(() => {
      this.assertLease(lease);
      this.event(lease.mission.id, "session", {
        sessionId,
        fence: lease.fence,
      });
    });
  }
  events(id: string, limit = 50): Record<string, unknown>[] {
    return this.db
      .prepare(
        "SELECT seq,at,kind,data FROM events WHERE mission_id=? ORDER BY seq DESC LIMIT ?",
      )
      .all(id, limit);
  }
  health(): { ok: boolean; missions: number } {
    const row = this.db.prepare("PRAGMA quick_check").get();
    return { ok: row?.quick_check === "ok", missions: this.list().length };
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private save(m: Mission): void {
    this.db
      .prepare(
        `INSERT INTO missions(id,owner,cwd,status,due,lease_owner,lease_until,fence,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,due=excluded.due,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,fence=excluded.fence,data=excluded.data`,
      )
      .run(
        m.id,
        m.owner,
        m.cwd,
        m.status,
        m.nextRunAt,
        m.leaseOwner,
        m.leaseUntil,
        m.fence,
        JSON.stringify(m),
      );
  }
  private saveTask(t: LabTask): void {
    this.db
      .prepare(
        "INSERT INTO tasks(id,mission_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(t.id, t.missionId, JSON.stringify(t));
  }
  private event(id: string, kind: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO events(mission_id,at,kind,data) VALUES(?,?,?,?)")
      .run(id, Date.now(), kind, JSON.stringify(data));
    this.db
      .prepare(
        "DELETE FROM events WHERE mission_id=? AND seq NOT IN (SELECT seq FROM events WHERE mission_id=? ORDER BY seq DESC LIMIT ?)",
      )
      .run(id, id, this.eventRetention);
  }
}
function checkText(value: string, name: string, max: number): void {
  if (!value.trim() || value.length > max)
    throw new Error(`${name} must contain 1..${max} characters`);
}
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/sk-[\w-]+/g, "[REDACTED]")
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
}
