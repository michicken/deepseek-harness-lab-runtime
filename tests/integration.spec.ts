import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
  "loads the built plugin in real dsh and reproduces a loopback lab issue across two fresh Agent Sessions",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-real-plugin-"));
    const workspace = join(dir, "lab");
    mkdirSync(workspace);
    const target = createServer((req, res) => {
      const id = new URL(req.url!, "http://localhost").searchParams.get("id");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ owner: id, record: `synthetic-canary-${id}` }));
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const address = target.address();
    if (!address || typeof address === "string")
      throw new Error("No loopback address");
    const origin = `http://127.0.0.1:${address.port}`;
    const patch = join(dir, "integration.yml");
    writeFileSync(
      patch,
      JSON.stringify([
        { id: "headless-runner", disabled: true },
        { id: "session-title-llm", disabled: true },
        {
          insert: [
            {
              id: "lab-runtime",
              name: resolve("lib/index.js"),
              config: {
                stateDir: join(dir, "state"),
                allowedWorkspaces: [workspace],
                allowedTargets: [origin],
                pollMs: 20,
                roundIntervalMs: 20,
                maxConsecutiveFailures: 1,
              },
            },
            {
              id: "lab-fixture",
              name: resolve("tests/fixtures/dsh-smoke.mjs"),
            },
          ],
        },
      ]),
    );
    try {
      const child = spawn(
        process.execPath,
        [bin, "--profile", "headless", "--patch", patch, "integration fixture"],
        {
          env: {
            ...process.env,
            DSH_HOME: join(dir, "dsh"),
            LAB_TARGET: origin,
            LAB_WORKSPACE: workspace,
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
        .find((l) => l.includes("lab-smoke-result"));
      expect(line, errors).toBeDefined();
      const result = JSON.parse(line!);
      expect(result.mission.status, JSON.stringify(result)).toBe("completed");
      expect(result.mission.round, JSON.stringify(result)).toBe(2);
      expect(result.findings, JSON.stringify(result)).toHaveLength(2);
      expect(
        result.events.filter((e: { kind: string }) => e.kind === "session"),
      ).toHaveLength(2);
      expect(
        JSON.parse(readFileSync(join(workspace, "proof.json"), "utf8")).response
          .body.owner,
      ).toBe("alice");
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
