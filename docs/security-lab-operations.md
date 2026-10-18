# Security lab operations

This runtime is intended for authorized vulnerability research against source code and isolated laboratory targets. It is not a production scanner and does not replace network isolation, approval policy, or human review.

## Isolation checklist

1. Run the daemon in a dedicated VM or container with a dedicated low-privilege account.
2. Mount only the source checkout and a disposable evidence workspace.
3. Restrict egress with host firewall rules to the exact approved origins; `allowedTargets` is an application guard, not the security boundary.
4. Keep credentials out of the workspace. Use a provider credential scoped to this deployment.
5. Set a container memory/CPU limit and a writable-layer size limit. The runtime has no total token or round budget, but the host still needs resource limits.
6. Back up `missions.sqlite`; it contains mission state and checkpoints, not credentials.

## Mission lifecycle

`lab_mission_start` requires a goal, an authorized workspace, and explicit HTTP(S) target origins. Each round creates a fresh worker Session. The durable handoff is the mission checkpoint plus the SQLite task DAG and evidence files.

Use `continuous` for ongoing research programs. It cannot be marked complete: it continues, waits, pauses, or blocks. Use `finite` for a scoped research plan with an end condition. A finite mission can complete only when every declared task is done and the round report contains evidence.

`lab_mission_control` pauses, resumes, or permanently stops a mission. Pause and stop revoke the lease immediately; the worker is cancelled at the next heartbeat and cannot commit a stale result.

## Evidence and findings

`lab_finding` accepts only evidence files inside the authorized workspace, caps each file at 16 MiB, and records its SHA-256. Classification is deliberately explicit:

- `static`: source-level clue only.
- `lab-reproduced`: reproduced in the isolated laboratory.
- `impact-verified`: actual impact verified under the mission threat model.
- `not-reproduced`: a candidate that failed reproduction.

Do not promote a static clue to a confirmed vulnerability without an executable reproduction and a complete causal chain.

## Recovery

SQLite uses WAL and `BEGIN IMMEDIATE`; claims, heartbeats, checkpoints, findings, and round settlements are transactional. A crashed worker leaves an expiring lease. Another process may claim the mission after expiry and starts from the last committed checkpoint. A replayed round must be idempotent: check evidence before repeating external side effects.

## System prompt

The default worker prompt is `assets/security-research-system-prompt.txt`, version `V3.1-LAB`. It is injected as an agent-scoped system prompt section. Set `promptFile` only to another reviewed V3.1-LAB-compatible file; startup fails if the version marker or long-running section is absent.
