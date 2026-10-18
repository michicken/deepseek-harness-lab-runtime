# Security lab operations

This runtime is intended for authorized vulnerability research against source code and isolated laboratory targets. Inside the declared mission scope, the worker has full authority to write tests, start lab services, construct state, run proof-of-concepts, and execute destructive experiments. The two hard boundaries are the macOS host and Clash/Mihomo: the worker must stay inside the mission workspace and isolated lab, and must never read, modify, control, probe, or route traffic through Clash.

The runtime adds a best-effort tool guard for host paths, host-mutating commands, GUI control, and Clash identifiers. This guard is defense in depth, not a sandbox. The real guarantee comes from running the daemon in a disposable VM/container with a separate network namespace and no host home-directory mount.

## Isolation checklist

1. Run the daemon in a dedicated VM or container with a dedicated low-privilege account.
2. Mount only the source checkout and a disposable evidence workspace; never mount the macOS home directory.
3. Give the lab its own network namespace. Do not share the host proxy, Clash ports, or control socket.
4. Keep credentials out of the workspace. Use a provider credential scoped to this deployment.
5. Set a container memory/CPU limit and a writable-layer size limit. The runtime has no total token or round budget, but the host still needs resource limits.
6. Back up `missions.sqlite`; it contains mission state and checkpoints, not credentials.

## Mission lifecycle

`lab_mission_start` requires a goal, an existing absolute workspace directory, and explicit HTTP(S) target origins. The selected directory is the mission's file-write boundary; target origins define its network testing scope. Visible missions run each round in the owner Session; explicitly selected worker mode creates a separate Session. The durable handoff is the mission checkpoint plus the SQLite task DAG and evidence files.

With `missionModePreset: lab-mission`, the first non-empty user message becomes one never-ending `continuous` mission automatically. The main Agent performs the research in that same Session, using its regular tools; each main call, result, checkpoint and follow-up round stays in the ordinary transcript and trajectory. The main Agent may create any number of subagents or child Sessions for parallel research, but it must keep working, verify their results, and communicate with the user in Simplified Chinese. The main Mission is never silently handed away to a child Session. Later user messages are corrections or guidance for the same Mission, never new Missions. The continuous Mission converts blockers and model mistakes into waits and keeps retrying; it never completes or blocks automatically. Only an explicit human pause/stop through `lab_mission_control` interrupts it. Manually started worker-mode missions continue to use `missionWorkerPreset` and a separate Session.

Each round must perform a substantive work cycle before handing off. The runtime counts successful non-control research calls and requires at least six plus one successful `lab_checkpoint` for `continue` or `complete`, and at least three plus a checkpoint for `wait`. The system prompt also requires multiple kinds of work—analysis, experiment/test, independent cross-check, evidence preservation, or subagent verification—so the counter is a floor rather than a substitute for research quality. A premature `lab_round_report` is rejected in the same Session.

The desktop deployment mounts the subagent and fork providers only. Optional workflow/Ralph tools are omitted because the desktop Host does not provide `workflowEngine`; an unavailable optional workflow service must not block Session recovery or the main Mission.

Use `continuous` for ongoing research programs. It cannot be marked complete or blocked: it continues or waits until a human pauses/stops it. Use `finite` for a scoped research plan with an end condition. A finite mission can complete only when every declared task is done and the round report contains evidence.

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

The default mission prompt is `assets/security-research-system-prompt.txt`, version `V3.1-LAB`. It is injected as an agent-scoped system prompt section. Set `promptFile` only to another reviewed V3.1-LAB-compatible file; startup fails if the version marker or long-running section is absent.
