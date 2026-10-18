# DeepSeek Harness Lab Runtime

Durable mission scheduler for authorized, isolated security research. The worker identity is `assets/security-research-system-prompt.txt` (V3.1-LAB): the supplied vulnerability-research prompt plus long-running checkpoints, idempotent replay, target authorization, and evidence-hash rules.

A durable long-running mission plugin for DeepSeek Harness. A controller starts a mission; a scheduler then runs successive rounds in fresh worker Sessions, commits a checkpoint and task-board state after each round, and continues until a finite objective completes or a human pauses/stops it.

Mission state deliberately lives outside `dsh-jobs-local`, because that registry is process-local. SQLite WAL plus `BEGIN IMMEDIATE` gives transactional claims, fenced leases, heartbeat renewal, and crash recovery across daemon processes.

## What it provides

- `lab_mission_start`: create and start a durable mission in a selected existing workspace and within the configured target list.
- `lab_mission_status`: inspect checkpoints, failure state, task board, and findings.
- `lab_mission_control`: pause, resume, or permanently stop an owned mission.
- `Lab Mission (24h)` controller mode: the first user message in a session created with the configured preset becomes a continuous mission automatically. The controller never performs the research itself.
- Worker Sessions are created as child Sessions of the controller (`origin: subagent`, `parentSession` = controller Session), so every round is visible and can be opened from the session list.
- Worker tools: `lab_checkpoint`, `lab_tasks`, `lab_finding`, and `lab_round_report`.
- Automatic round scheduling with a fresh worker Session per round.
- Fresh worker Session per round; durable checkpoint and SQLite task DAG are the handoff.
- SQLite WAL state, `BEGIN IMMEDIATE` claims, fenced leases, heartbeat renewal, crash recovery.
- Evidence-bound findings: workspace path, SHA-256, and static/lab/impact classification.
- Session-selected workspace and explicit target origins; loopback-only by default.
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
        allowedTargets: ["http://127.0.0.1:8080"]
        promptFile: /absolute/path/to/deepseek-harness-lab-runtime/assets/security-research-system-prompt.txt
        missionModePreset: lab-mission
        missionWorkerPreset: standard
```

### Lab Mission (24h) mode

`missionModePreset` is optional. When set, a session created with that agent preset gets a controller-only composition: the first non-empty user message is turned into a `continuous` mission before the model sees it. The controller receives a launch-card instruction and must not execute research itself. Every worker round is a fresh child Session, so the UI shows the real execution trace instead of a black box.

`missionWorkerPreset` selects the Agent preset mounted into each Worker Session. Set it to a preset that includes the tools the worker needs; desktop dsh 0.2.x deployments normally use `standard`. The worker Session records that preset and remains a child of its controller. If this option is omitted, the Worker joins its controller's current preset when the runtime can resolve that composition.

The selected session's working directory is the mission workspace. It must be an existing absolute directory, but the runtime does not restrict it to a configured workspace allowlist. File writes remain limited to that mission workspace by the host guard. Target origins are still restricted by `allowedTargets`.

For dsh 0.1.x, create a preset directory such as `~/.dsh/.agent-presets/lab-mission/` with `preset.yml` and `agent.cordis.yml`. For dsh 0.2.x, the preset is a declarative profile row:

```yaml
- insert:
    - id: preset-lab-mission
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: lab-mission
        name: Lab Mission (24h)
        order: 0
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              complete: true
              includeRuntimeContext: false
              prefix: |
                你是 Lab Mission 控制器，不是研究员。
                第一条用户消息会自动变成持久任务；不要自己执行研究。
```

The desktop app may require an explicit exact-version compatibility approval when the plugin was built for a different dsh release. The approval is stored in the profile's `compatibility.json`; only grant it for an exact plugin version and dsh version you have tested.

Run the profile under an external supervisor such as launchd, systemd, or a container manager. After a daemon restart the new process claims expired leases automatically; no human re-entry is needed. The persisted lease prevents a second runtime from taking over while the previous owner is healthy.

The default worker prompt is version `V3.1-LAB`, loaded from `assets/security-research-system-prompt.txt` and injected as an agent-scoped system prompt section. See `docs/security-lab-operations.md` for isolation and lifecycle requirements.

## Operational boundary

Run with least privilege and an isolated workspace. The runtime persists mission metadata, not credentials. A provider account, rate limit, and context window remain real limits even when no application-level token cap is configured.
