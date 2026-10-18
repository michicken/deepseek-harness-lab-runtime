import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { MissionStore } from "./store.js";
import {
  PermanentError,
  type RoundContext,
  type RoundExecutor,
  type RoundReport,
} from "./types.js";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-system-prompt";

/** Uses actual public dsh Agent APIs. Fresh sessions bound per-round context growth. */
export class DshExecutor implements RoundExecutor {
  readonly workers = new Set<string>();
  constructor(
    private readonly ctx: Context,
    private readonly store: MissionStore,
    private readonly systemPrompt: string,
  ) {}
  async run(context: RoundContext): Promise<RoundReport> {
    let report: RoundReport | undefined;
    let turnError: Error | undefined;
    let handle: AgentHandle | undefined;
    const store = this.store;
    const id = SessionId(
      `lab-${context.lease.mission.id}-${context.lease.fence}-${randomUUID()}`,
    );
    store.recordSession(context.lease, id);
    const onAbort = () =>
      handle?.agent.cancel({
        kind: "hook",
        reason: "Lab round cancelled or lease revoked",
      });
    this.workers.add(id);
    try {
      handle = await this.ctx.agents.create({
        sessionId: id,
        agentOptions: {
          provider: context.lease.mission.provider,
          model: context.lease.mission.model,
        },
        meta: { cwd: context.lease.mission.cwd },
        signal: context.signal,
        setup: (agentCtx) => {
          agentCtx.systemPrompt.section({
            name: "lab-security-research-system-prompt-v3.1",
            order:
              agentCtx.systemPrompt.getSectionOrder(
                "DEPLOYMENT_PERSONA_SUFFIX",
              ) + 1,
            text: this.systemPrompt,
          });
          agentCtx.on("tools/pre-execute", async (exec, next) => {
            const reason = hostGuard(
              exec.name,
              exec.arguments,
              context.lease.mission.cwd,
            );
            return reason === undefined ? next() : { kind: "deny", reason };
          });
          agentCtx.on("agent/pre-step", async (_payload, next) => {
            context.signal.throwIfAborted();
            this.store.assertLease(context.lease);
            return next();
          });
          agentCtx.on("agent/error", ({ error }) => {
            turnError =
              error instanceof Error ? error : new Error(String(error));
          });
          agentCtx.tools.register(
            defineTool({
              name: "lab_checkpoint",
              description:
                "Persist progress now. Include completed work, experiment outcomes, file paths, unresolved questions, and the exact next action. Survives a crash before the round ends.",
              parameters: { checkpoint: { type: "string", required: true } },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                context.checkpoint(args.checkpoint);
                return JSON.stringify({ saved: true });
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_tasks",
              description:
                "Persistent task DAG for this mission. List first. Create a task with existing dependency IDs. Update uses revision compare-and-set; done requires evidence.",
              parameters: {
                action: {
                  type: "string",
                  enum: ["list", "create", "update"],
                  required: true,
                },
                title: { type: "string" },
                depends_on: { type: "array", items: { type: "string" } },
                task_id: { type: "string" },
                revision: { type: "integer" },
                status: { type: "string", enum: ["pending", "doing", "done"] },
                evidence: { type: "array", items: { type: "string" } },
              },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                if (args.action === "list")
                  return JSON.stringify(context.tasks.list());
                if (args.action === "create") {
                  if (!args.title) throw new Error("title required");
                  return JSON.stringify(
                    context.tasks.create(args.title, args.depends_on ?? []),
                  );
                }
                if (
                  !args.task_id ||
                  args.revision === undefined ||
                  !args.status
                )
                  throw new Error("task_id, revision and status required");
                return JSON.stringify(
                  context.tasks.update(
                    args.task_id,
                    args.revision,
                    args.status,
                    args.evidence ?? [],
                  ),
                );
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_finding",
              description:
                "Record a vulnerability finding with prerequisites and reproducible evidence. Distinguish static clues, lab reproduction, verified impact, and failed reproduction. Evidence files must exist inside this workspace and are SHA-256 hashed.",
              parameters: {
                title: { type: "string", required: true },
                target: { type: "string", required: true },
                classification: {
                  type: "string",
                  enum: [
                    "static",
                    "lab-reproduced",
                    "impact-verified",
                    "not-reproduced",
                  ],
                  required: true,
                },
                prerequisites: { type: "string", required: true },
                evidence_paths: {
                  type: "array",
                  items: { type: "string" },
                  required: true,
                },
              },
              output: jsonOutput,
              async execute(args) {
                context.signal.throwIfAborted();
                const origin = new URL(args.target).origin;
                if (!context.lease.mission.targets.includes(origin))
                  throw new Error("Finding target outside mission scope");
                if (
                  !args.title.trim() ||
                  args.title.length > 2000 ||
                  !args.prerequisites.trim() ||
                  args.prerequisites.length > 4000
                )
                  throw new Error(
                    "Title/prerequisites required within size limits",
                  );
                if (
                  args.classification !== "static" &&
                  !args.evidence_paths.length
                )
                  throw new Error("Validation requires saved evidence");
                if (args.evidence_paths.length > 16)
                  throw new Error("At most 16 evidence files per finding");
                const root = realpathSync(context.lease.mission.cwd);
                const evidence = args.evidence_paths.map((path) => {
                  const full = realpathSync(resolve(root, path));
                  const rel = relative(root, full);
                  if (rel.startsWith("..") || isAbsolute(rel))
                    throw new Error("Evidence file outside workspace");
                  const stat = statSync(full);
                  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
                    throw new Error("Evidence must be a file under 16 MiB");
                  return {
                    path: rel,
                    sha256: createHash("sha256")
                      .update(readFileSync(full))
                      .digest("hex"),
                  };
                });
                return JSON.stringify(
                  store.addFinding(context.lease, {
                    title: args.title,
                    target: origin,
                    classification: args.classification,
                    prerequisites: args.prerequisites,
                    evidence,
                  }),
                );
              },
            }),
          );
          agentCtx.tools.register(
            defineTool({
              name: "lab_round_report",
              description:
                "Conclude this round with a durable handoff. continue for next work; wait for an external event; blocked for human input; complete only for a verified finite objective. Evidence must name actual results. This ends the current turn.",
              parameters: {
                action: {
                  type: "string",
                  enum: ["continue", "wait", "complete", "blocked"],
                  required: true,
                },
                checkpoint: { type: "string", required: true },
                evidence: {
                  type: "array",
                  items: { type: "string" },
                  required: true,
                },
                progress: { type: "boolean", required: true },
                wait_ms: { type: "integer" },
              },
              output: jsonOutput,
              async execute(args, exec) {
                context.signal.throwIfAborted();
                store.assertLease(context.lease);
                if (!args.checkpoint.trim() || args.checkpoint.length > 16000)
                  throw new Error(
                    "checkpoint must contain 1..16000 characters",
                  );
                if (
                  args.action === "complete" &&
                  context.lease.mission.mode === "continuous"
                )
                  throw new Error("Continuous mission: use wait or blocked");
                if (
                  args.action === "complete" &&
                  (!args.evidence.some((e) => e.trim()) ||
                    context.tasks.list().some((t) => t.status !== "done"))
                )
                  throw new Error(
                    "Completion needs evidence and all declared tasks done",
                  );
                const waitMs = args.wait_ms ?? 60000;
                if (
                  !Number.isSafeInteger(waitMs) ||
                  waitMs < 1000 ||
                  waitMs > 7 * 86400000
                )
                  throw new Error("wait_ms must be between 1000 and 604800000");
                if (
                  args.evidence.length > 32 ||
                  args.evidence.some((e) => e.length > 2000)
                )
                  throw new Error("Evidence exceeds size limit");
                report = {
                  action: args.action,
                  checkpoint: args.checkpoint,
                  evidence: args.evidence,
                  progress: args.progress,
                  waitMs,
                };
                exec.concludeTurn();
                return JSON.stringify({ accepted: true });
              },
            }),
          );
        },
      });
      context.signal.addEventListener("abort", onAbort, { once: true });
      context.signal.throwIfAborted();
      const m = context.lease.mission;
      handle.agent.followup(
        createUserMessage({
          source: { kind: "plugin", plugin: "lab-runtime" },
          content: [{ type: "text", text: buildPrompt(context) }],
        }),
      );
      await handle.agent.whenIdle();
      context.signal.throwIfAborted();
      if (turnError) {
        const message = turnError.message;
        if (
          /(?:401|403|AUTH|INVALID_CREDENTIAL|NO_ADAPTER|UNKNOWN_MODEL|insufficient.*(?:balance|quota))/i.test(
            message,
          )
        )
          throw new PermanentError(message);
        throw turnError;
      }
      const end = handle.agent.session
        .snapshotEvents()
        .findLast((event) => event.type === "turn/end");
      if (end?.type === "turn/end" && end.data.reason.kind !== "completed")
        throw new Error(
          `dsh turn did not complete: ${JSON.stringify(end.data.reason)}`,
        );
      if (!report)
        throw new Error(
          `Round ended without lab_round_report (${m.id}); no success inferred`,
        );
      return report;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (handle) await handle.dispose();
      this.workers.delete(id);
    }
  }
}
const jsonOutput = {
  schema: { type: "string" } satisfies ValueSchemaSpec,
  render: (_args: unknown, value: string) => [
    { type: "text" as const, text: value },
  ],
} as const;
function buildPrompt(context: RoundContext): string {
  const m = context.lease.mission;
  const tasks = context.tasks.list();
  return `You are carrying out round ${m.round + 1} of a durable autonomous mission.
Goal: ${m.goal}
Mode: ${m.mode}. ${m.mode === "continuous" ? "This objective persists. When no work is actionable, report wait with a sensible delay." : "Finish when evidence proves the requested outcome."}
Workspace: ${m.cwd}
Explicit authorized target origins: ${JSON.stringify(m.targets)}
Stay within these targets. Do not test other hosts, exfiltrate real user data, or perform destructive validation. Use minimal synthetic canaries and save exact requests/responses. lab_finding records the evidence hashes and distinguishes static hints, lab reproduction, and verified impact; do not conflate these classes. Target declarations guide tools and reporting, but OS/container network isolation must be configured by deployment.
Latest checkpoint (verify facts against actual files):
${m.checkpoint || "(no checkpoint yet)"}
Task board summary: ${JSON.stringify(tasks.slice(-20).map((t) => ({ id: t.id, title: t.title, status: t.status, revision: t.revision })))}

Make concrete progress using tools and verifiable experiments. You may delegate with installed dsh tools when useful; coordinate shared files. Maintain a durable task DAG with lab_tasks. Prefer external artifacts for detailed notes. Call lab_checkpoint during meaningful work so a crash does not discard the handoff. This round uses a fresh Session; inspect workspace and checkpoint instead of assuming earlier conversation is available.
You MUST finish with lab_round_report. Include exact completed work, failed approaches, evidence paths/results, and the next useful action. Use blocked when human input or authorization is needed. Use wait for unavailable external work; do not loop or invent activity. Never claim commands ran without tool evidence. A crash can replay this round: make external changes idempotent and check existing results before repeating them. There is no total token/round budget; provider context limits and per-round operational timeouts still apply.`;
}

const CLASH_PATTERN = /\b(clashx?|mihomo|clash[- ]?verge)\b/i;
const HOST_COMMAND_PATTERN =
  /\b(osascript|launchctl|systemsetup|networksetup|diskutil|csrutil|nvram|tmutil|shutdown|reboot|killall|pkill|sudo|defaults\s+write)\b/i;
const HOST_PATH_PATTERN =
  /(?:^|[\s"'=:])(?:~|\$HOME|\/Users\/|\/System\/|\/Library\/|\/Applications\/|\/private\/|\/etc\/)/;

/** Best-effort process guard. Container/VM isolation remains the real boundary. */
export function hostGuard(
  name: string,
  args: unknown,
  workspace: string,
): string | undefined {
  const serialized = JSON.stringify(args);
  if (CLASH_PATTERN.test(serialized)) {
    return "Clash/Mihomo is explicitly out of scope: do not read, modify, control, probe, or route traffic through it.";
  }
  if (/computer|cua|osascript|applescript/i.test(name)) {
    return "Host GUI and system control are outside the lab boundary.";
  }
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const filePath = record.file_path ?? record.path;
  if (typeof filePath === "string" && (name === "write" || name === "edit")) {
    const target = resolve(workspace, filePath);
    const rel = relative(workspace, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return "File writes are restricted to the mission workspace; the macOS host is out of scope.";
    }
  }
  const command = record.command ?? record.cmd;
  if (typeof command === "string") {
    const guardedCommand = command.split(workspace).join("<workspace>");
    if (HOST_COMMAND_PATTERN.test(guardedCommand)) {
      return "This command can modify the macOS host; run the equivalent inside the isolated lab instead.";
    }
    if (HOST_PATH_PATTERN.test(guardedCommand)) {
      return "Commands referencing host home/system paths are blocked; use paths inside the mission workspace or the isolated lab.";
    }
  }
  return undefined;
}
