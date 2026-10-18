# DeepSeek Harness Lab Runtime

Durable mission scheduler for authorized, isolated security research. The worker identity is `assets/security-research-system-prompt.txt` (V3.1-LAB): the supplied vulnerability-research prompt plus long-running checkpoints, idempotent replay, target authorization, and evidence-hash rules.

A durable long-running mission plugin for DeepSeek Harness. A controller starts a mission; a scheduler then runs successive rounds in fresh worker Sessions, commits a checkpoint and task-board state after each round, and continues until a finite objective completes or a human pauses/stops it.

Mission state deliberately lives outside `dsh-jobs-local`, because that registry is process-local. SQLite WAL plus `BEGIN IMMEDIATE` gives transactional claims, fenced leases, heartbeat renewal, and crash recovery across daemon processes.

## What it provides

- `lab_mission_start`: create and start a durable mission on an authorized workspace and target list.
- `lab_mission_status`: inspect checkpoints, failure state, task board, and findings.
- `lab_mission_control`: pause, resume, or permanently stop an owned mission.
- Worker tools: `lab_checkpoint`, `lab_tasks`, `lab_finding`, and `lab_round_report`.
- Automatic round scheduling with a fresh worker Session per round.
- Fresh worker Session per round; durable checkpoint and SQLite task DAG are the handoff.
- SQLite WAL state, `BEGIN IMMEDIATE` claims, fenced leases, heartbeat renewal, crash recovery.
- Evidence-bound findings: workspace path, SHA-256, and static/lab/impact classification.
- Explicit allowed workspaces and target origins; loopback-only by default.
- Bounded event history and checkpoint size; replay-safe external work guidance.
- Stagnation detection and a failure circuit breaker instead of an infinite blind retry loop.

The plugin does not claim infinite tokens. Each model request remains bounded by the provider and context window; the mission continues across finite turns using checkpoints and the workspace as durable working memory.

## Development

```sh
npm install
npm test
npm run typecheck
```

`examples/github-actions-ci.yml` is the CI definition. Copy it to `.github/workflows/ci.yml` after granting the GitHub token `workflow` scope.

## Load into dsh

Build the package, then add an absolute path to `lib/index.js` in a profile patch:

```yaml
- insert:
    - id: lab-runtime
      name: /absolute/path/to/deepseek-harness-lab-runtime/lib/index.js
      config:
        stateDir: /absolute/path/to/durable/lab-state
        allowedWorkspaces: [/absolute/path/to/isolated/workspace]
        allowedTargets: ["http://127.0.0.1:8080"]
        promptFile: /absolute/path/to/deepseek-harness-lab-runtime/assets/security-research-system-prompt.txt
```

Run the profile under an external supervisor such as launchd, systemd, or a container manager. After a daemon restart the new process claims expired leases automatically; no human re-entry is needed. The persisted lease prevents a second runtime from taking over while the previous owner is healthy.

The default worker prompt is version `V3.1-LAB`, loaded from `assets/security-research-system-prompt.txt` and injected as an agent-scoped system prompt section. See `docs/security-lab-operations.md` for isolation and lifecycle requirements.

## Operational boundary

Run with least privilege and an isolated workspace. The runtime persists mission metadata, not credentials. A provider account, rate limit, and context window remain real limits even when no application-level token cap is configured.
