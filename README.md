# DeepSeek Harness Lab Runtime

Durable mission runtime for authorized security research. The V3.1-LAB research prompt adds long-running checkpoints, idempotent replay, target authorization, and evidence-hash rules. `Lab Mission (24h)` runs the research directly inside the visible owner Session: normal tools, calls, outputs, checkpoints, and later rounds stay in its transcript and trajectory. Missions explicitly started in worker mode remain available for separate worker Sessions.

Mission state deliberately lives outside `dsh-jobs-local`, because that registry is process-local. SQLite WAL plus `BEGIN IMMEDIATE` gives transactional claims, fenced leases, heartbeat renewal, and crash recovery across daemon processes.

## What it provides

- `lab_mission_start`: create and start a durable mission in a selected existing workspace and within the configured target list.
- `lab_mission_status`: inspect checkpoints, failure state, task board, and findings.
- `lab_mission_control`: pause, resume, or permanently stop an owned mission.
- `Lab Mission (24h)` mode: the first user message becomes one never-ending `continuous` mission; the same Agent performs the research with its ordinary session tools. Later user messages are corrections and guidance for that Mission, never new Missions.
- Visible mission tools: `lab_checkpoint`, `lab_tasks`, `lab_finding`, and `lab_round_report` run in the owner Session and appear in its trajectory.
- Automatic round scheduling resumes in the same Session. A visible mission waits unclaimed until its owner Session is loaded; it is never silently moved to a child Session.
- Explicit worker-mode missions remain available for users who choose a separate Session.
- Durable checkpoints and a SQLite task DAG carry mission state across rounds.
- SQLite WAL state, `BEGIN IMMEDIATE` claims, fenced leases, heartbeat renewal, crash recovery.
- Evidence-bound findings: workspace path, SHA-256, and static/lab/impact classification.
- Session-selected workspace and explicit target origins; loopback-only by default.
- Bounded event history and checkpoint size; replay-safe external work guidance.
- Stagnation detection and a failure circuit breaker for `finite` missions; `continuous` missions convert blockers and failures into waits and keep retrying until human control.

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

`missionModePreset` is optional. When set, the first non-empty user message creates one never-ending `continuous` mission and the same Agent executes it with the ordinary session tools. Bash, file, web and Lab Runtime calls, results, checkpoints and follow-up rounds appear in that Session's transcript and trajectory. It does not create or hand work to a child Session. Later messages refine or correct the same Mission; they do not create another task. The continuous Mission never completes or blocks automatically and only an explicit human pause/stop can interrupt it.

`missionWorkerPreset` selects the Agent preset for missions explicitly run in background worker mode. It does not affect the visible `missionModePreset` Session, which uses its own preset and tools.

The selected session's working directory is the mission workspace. It must be an existing absolute directory, but the runtime does not restrict it to a configured workspace allowlist. File writes remain limited to that mission workspace by the host guard. Target origins are still restricted by `allowedTargets`.

For dsh 0.1.x, create a preset directory such as `~/.dsh/.agent-presets/lab-mission/` with `preset.yml` and `agent.cordis.yml`. For dsh 0.2.x, the preset is a declarative profile row:

```yaml
- insert:
    - id: preset-lab-mission
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: lab-mission
        name: Lab Mission (24h)
        order: 0
        plugins:
          - id: persona
            name: "@deepseek-ai/dsh-persona"
            config:
              complete: true
              includeRuntimeContext: false
              prefix: |
                你直接在当前会话执行用户的实验室任务。
                持久任务模式会在同一 Agent 和 Session 中持续运行；展示常规工具调用与结果，不要创建子会话或委托研究。
```

The desktop app may require an explicit exact-version compatibility approval when the plugin was built for a different dsh release. The approval is stored in the profile's `compatibility.json`; only grant it for an exact plugin version and dsh version you have tested.

Run the profile under an external supervisor such as launchd, systemd, or a container manager. After a daemon restart the new process claims expired leases automatically; no human re-entry is needed. The persisted lease prevents a second runtime from taking over while the previous owner is healthy.

The default mission prompt is version `V3.1-LAB`, loaded from `assets/security-research-system-prompt.txt` and injected as an agent-scoped system prompt section. See `docs/security-lab-operations.md` for isolation and lifecycle requirements.

## Operational boundary

Run with least privilege and an isolated workspace. The runtime persists mission metadata, not credentials. A provider account, rate limit, and context window remain real limits even when no application-level token cap is configured.
