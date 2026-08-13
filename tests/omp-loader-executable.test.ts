import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Executable OMP loader compatibility test.
 *
 * Spawns `scripts/omp-compat-check.ts` under Bun so the check drives OMP's real
 * extension loader against `src/adapter.ts`. The script exits 0 both when OMP
 * resolves both imports (PASS) and when OMP is not installed (SKIP), so CI
 * without Bun or OMP stays green. We fail only on a real resolution failure.
 */

function hasBun(): boolean {
  return (
    process.env.PATH?.split(delimiter).some((dir) =>
      ["bun", "bun.exe"].some((name) => existsSync(join(dir, name))),
    ) ?? false
  );
}

function runCheck(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // The adapter switches to mock components when `VITEST` is set, so strip it
    // from the child env: this check must exercise the real runtime path.
    const env = { ...process.env };
    delete env.VITEST;
    const child = spawn("bun", ["scripts/omp-compat-check.ts"], {
      cwd: process.cwd(),
      env,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("OMP loader executable compatibility", () => {
  it.skipIf(!hasBun())(
    "resolves @earendil-works/pi-* imports through OMP's loader",
    async () => {
      const { code, output } = await runCheck();
      expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(0);
    },
    120_000,
  );
});
