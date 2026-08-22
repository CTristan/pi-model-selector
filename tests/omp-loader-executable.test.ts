import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Executable OMP loader compatibility test.
 *
 * Spawns `scripts/omp-compat-check.ts` under Bun so the check drives OMP's real
 * extension loader against `src/adapter.ts`. The script exits 0 both when OMP
 * resolves both imports (PASS) and when OMP is not installed (SKIP), so CI
 * without Bun or OMP stays green. We fail only on a real resolution failure.
 *
 * The synthetic-layout cases pin the discovery contract with a temporary
 * HOME and PATH: the prebuilt standalone binary skips with an explicit
 * reason, a conventional root without the compat module fails, and an omp
 * symlink into a package tree is classified as a package install rather
 * than a standalone binary.
 */

function findBun(): string | null {
  for (const dir of process.env.PATH?.split(delimiter) ?? []) {
    for (const name of ["bun", "bun.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const BUN = findBun();

// The synthetic executables are POSIX shell scripts with a shebang, so the
// two fixture tests that spawn them cannot run on Windows. The remaining
// synthetic cases exercise directory layout only and stay platform-neutral.
const WINDOWS = process.platform === "win32";

type CheckResult = { code: number | null; output: string };

function spawnCheck(env: Record<string, string>): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    if (!BUN) {
      reject(new Error("bun not found"));
      return;
    }
    // The adapter switches to mock components when `VITEST` is set, so the
    // synthetic env deliberately omits it: this check must exercise the real
    // runtime path.
    const child = spawn(BUN, ["scripts/omp-compat-check.ts"], {
      cwd: process.cwd(),
      env,
    });
    // Terminate a hung loader instead of leaking a process past the vitest
    // timeout; OMP module evaluation can block on host-side IO.
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("omp-compat-check timed out"));
    }, 60_000);
    timeout.unref();
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

function runCheck(): Promise<CheckResult> {
  const env = { ...process.env };
  delete env.VITEST;
  return spawnCheck(env as Record<string, string>);
}

/** Minimal child env pinned to a temporary HOME and PATH. */
function syntheticEnv(home: string, pathDir: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, PATH: pathDir };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

describe("OMP loader executable compatibility", () => {
  it.skipIf(!BUN)(
    "resolves @earendil-works/pi-* imports through OMP's loader",
    async () => {
      const { code, output } = await runCheck();
      expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(0);
    },
    120_000,
  );

  it.skipIf(!BUN || WINDOWS)(
    "skips with an explicit reason for a prebuilt standalone omp binary",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omp-standalone-"));
      try {
        const binDir = join(dir, "bin");
        const home = join(dir, "home");
        mkdirSync(binDir);
        mkdirSync(home);
        writeExecutable(
          join(binDir, "omp"),
          '#!/bin/sh\necho "omp/17.2.12"\nexit 0\n',
        );
        const { code, output } = await spawnCheck(syntheticEnv(home, binDir));
        expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(0);
        expect(output).toContain("SKIP");
        expect(output).toContain("standalone binary");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!BUN)(
    "fails when a conventional OMP root exists without the compat module",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omp-conventional-"));
      try {
        const home = join(dir, "home");
        const emptyBin = join(dir, "empty-bin");
        const pkgRoot = join(
          home,
          "node_modules",
          "@oh-my-pi",
          "pi-coding-agent",
        );
        mkdirSync(emptyBin);
        mkdirSync(pkgRoot, { recursive: true });
        writeFileSync(
          join(pkgRoot, "package.json"),
          JSON.stringify({
            name: "@oh-my-pi/pi-coding-agent",
            version: "17.2.12",
          }),
        );
        const { code, output } = await spawnCheck(syntheticEnv(home, emptyBin));
        expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(1);
        expect(output).toContain("FAIL");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!BUN)(
    "fails when an explicit OMP_ROOT is not an OMP package root",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omp-fake-root-"));
      try {
        const home = join(dir, "home");
        const emptyBin = join(dir, "empty-bin");
        const fakeRoot = join(dir, "fake-omp");
        const pluginDir = join(fakeRoot, "src", "extensibility", "plugins");
        mkdirSync(home);
        mkdirSync(emptyBin);
        mkdirSync(pluginDir, { recursive: true });
        // The stub satisfies every assertion the check makes, so without root
        // validation this directory fabricates a PASS for an install that is
        // not OMP at all.
        writeFileSync(
          join(pluginDir, "legacy-pi-compat.ts"),
          [
            "export function installLegacyPiSpecifierShim(): void {}",
            "export async function loadLegacyPiModule(_adapterPath: string) {",
            "  return {",
            "    isOmp: true,",
            '    EXTENSION_DIR: ".omp",',
            `    AGENT_DIR: ${JSON.stringify(join(home, ".omp", "agent"))},`,
            "    DynamicBorder: class DynamicBorder {},",
            "    Container: function Container() {},",
            "    truncateToWidth: function truncateToWidth() {},",
            "    SelectList: function SelectList() {},",
            "    Spacer: function Spacer() {},",
            "    Text: function Text() {},",
            "  };",
            "}",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(fakeRoot, "package.json"),
          JSON.stringify({ name: "definitely-not-omp" }),
        );
        const env = syntheticEnv(home, emptyBin);
        env.OMP_ROOT = fakeRoot;
        const { code, output } = await spawnCheck(env);
        expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(1);
        expect(output).toContain("FAIL");
        expect(output).not.toContain("PASS");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!BUN || WINDOWS)(
    "classifies an omp symlink into a package tree as a package install",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omp-symlink-"));
      try {
        const home = join(dir, "home");
        const binDir = join(dir, "bin");
        const pkgRoot = join(
          home,
          "node_modules",
          "@oh-my-pi",
          "pi-coding-agent",
        );
        mkdirSync(binDir);
        mkdirSync(join(pkgRoot, "dist"), { recursive: true });
        writeFileSync(
          join(pkgRoot, "package.json"),
          JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
        );
        // The compat module is intentionally absent: discovery must still
        // recognize the package layout and fail, not treat the symlink as a
        // standalone binary and skip.
        writeExecutable(join(pkgRoot, "dist", "cli.js"), "#!/bin/sh\n");
        symlinkSync(join(pkgRoot, "dist", "cli.js"), join(binDir, "omp"));
        const { code, output } = await spawnCheck(syntheticEnv(home, binDir));
        expect(code, `omp-compat-check exited ${code}:\n${output}`).toBe(1);
        expect(output).toContain("FAIL");
        expect(output).not.toContain("standalone");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
