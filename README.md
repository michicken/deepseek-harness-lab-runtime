# DeepSeek Harness Lab Runtime

A durable long-running mission plugin for DeepSeek Harness. It turns one Agent Session into a resumable autonomous mission: after each completed turn the plugin queues the next turn, persists checkpoints atomically, and exposes explicit pause, resume, complete, stop, and status controls.

This package deliberately keeps mission state outside `dsh-jobs-local`, because that registry is process-local. The state store uses an atomic JSON rename plus an inter-process lock, so a supervisor can restart the Harness process without losing the mission record.

## What it provides

- `lab_mission_start`: create and start a durable mission.
- `lab_mission_checkpoint`: save concise progress for recovery and context rollover.
- `lab_mission_status`: inspect one or all missions.
- `lab_mission_pause`, `lab_mission_complete`, `lab_mission_stop`: explicit lifecycle controls.
- Automatic continuation from `agent/turn-stopping` through `agent.followup()`.
- Bounded event history and checkpoint size.
- Atomic persistence and stale-lock recovery.

The plugin does not claim infinite tokens. Each model request remains bounded by the provider and context window; the mission continues across finite turns using checkpoints and the workspace as durable working memory.

## Development

```sh
npm install
npm test
npm run typecheck
```

## Load into dsh

Build the package, then add an absolute path to `lib/plugin.js` in a profile patch:

```yaml
- insert:
    - id: long-running-runtime
      name: /absolute/path/to/deepseek-harness-lab-runtime/lib/plugin.js
      config:
        stateDir: /absolute/path/to/durable/lab-state
```

Run the profile under an external supervisor such as launchd, systemd, or a container manager. Use a persistent dsh Session when recovering an Agent after restart, then call `lab_mission_resume` in the resumed Session. The persisted lease prevents a second runtime from taking over while the previous owner is still healthy; an expired lease can be claimed by the recovery process.

## Operational boundary

Run with least privilege and an isolated workspace. The runtime persists mission metadata, not credentials. A provider account, rate limit, and context window remain real limits even when no application-level token cap is configured.
