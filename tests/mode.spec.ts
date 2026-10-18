import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vitest";

const bin =
  process.env.DSH_BIN ??
  join(
    homedir(),
    "deepseek-harness",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );

it.skipIf(!existsSync(bin))(
  "turns the first message in a Lab Mission preset session into a visible mission in the same Agent Session",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mode-"));
    const dshHome = join(dir, "dsh");
    const workspace = join(dir, "lab");
    const presetRoot = join(dshHome, ".agent-presets", "lab-mission");
    mkdirSync(workspace);
    mkdirSync(presetRoot, { recursive: true });
    writeFileSync(
      join(presetRoot, "preset.yml"),
      "name: Lab Mission (24h)\ndescription: fixture\norder: 0\n",
    );
    writeFileSync(
      join(presetRoot, "agent.cordis.yml"),
      [
        "- id: persona",
        "  name: '@deepseek-ai/dsh-persona'",
        "  config:",
        "    complete: true",
        "    includeRuntimeContext: false",
        "    prefix: |",
        "      You are the Lab Mission controller fixture.",
        "",
      ].join("\n"),
    );
    const patch = join(dir, "mode.yml");
    writeFileSync(
      patch,
      JSON.stringify([
        { id: "headless-runner", disabled: true },
        { id: "session-title-llm", disabled: true },
        {
          insert: [
            {
              id: "agent-presets",
              name: "@deepseek-ai/dsh-agent-presets",
              config: { default: "lab-mission" },
            },
            {
              id: "lab-runtime",
              name: resolve("lib/index.js"),
              config: {
                stateDir: join(dir, "state"),
                allowedTargets: ["http://127.0.0.1:9"],
                missionModePreset: "lab-mission",
                pollMs: 20,
                roundIntervalMs: 20,
                maxConsecutiveFailures: 1,
              },
            },
            {
              id: "lab-mode-fixture",
              name: resolve("tests/fixtures/dsh-mode.mjs"),
            },
          ],
        },
      ]),
    );
    try {
      const child = spawn(
        process.execPath,
        [bin, "--profile", "headless", "--patch", patch, "mode fixture"],
        {
          env: {
            ...process.env,
            DSH_HOME: dshHome,
            LAB_WORKSPACE: realpathSync(workspace),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (errors += b));
      const deadline = setTimeout(() => child.kill("SIGKILL"), 25000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      clearTimeout(deadline);
      expect(code, errors + "\n" + output).toBe(0);
      const line = output
        .split("\n")
        .find((value) => value.includes("lab-mode-result"));
      expect(line, errors + "\n" + output).toBeDefined();
      const result = JSON.parse(line!);
      expect(result.mission.goal).toContain("Audit the local lab fixture");
      expect(result.mission.executionMode).toBe("visible");
      expect(result.hasLaunchAcknowledgment).toBe(true);
      expect(result.visibleRoundInOwner).toBe(true);
      expect(
        result.events.some(
          (event: { kind: string }) => event.kind === "session",
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
