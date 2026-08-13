#!/usr/bin/env bun
/**
 * Executable OMP loader compatibility check.
 *
 * Loads the real `src/adapter.ts` through OMP's extension loader
 * (`installLegacyPiSpecifierShim` plus `loadLegacyPiModule`) and asserts that the
 * literal `@earendil-works/pi-*` dynamic imports resolve to OMP's canonical
 * host modules and that OMP mode is detected. Run with Bun:
 * `bun scripts/omp-compat-check.ts`.
 *
 * Exit codes:
 *   0  PASS — OMP resolved both imports and the adapter detected OMP mode.
 *   0  SKIP — OMP is not installed, so there is nothing to verify (CI-safe).
 *   1  FAIL — OMP is installed but a resolution or detection assertion failed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function ompRootCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.OMP_ROOT) candidates.push(process.env.OMP_ROOT);

  const ompBin = Bun.which("omp");
  if (ompBin) {
    try {
      // `omp` is a symlink into the package, for example
      // `<root>/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`. Resolve it
      // and walk up to the package root.
      const real = fs.realpathSync(ompBin);
      const pkgRoot = path.dirname(path.dirname(real));
      candidates.push(pkgRoot);
    } catch {
      // Fall through to the conventional global locations.
    }
  }

  const home = os.homedir();
  candidates.push(
    path.join(home, "node_modules", "@oh-my-pi", "pi-coding-agent"),
    path.join(
      home,
      ".bun",
      "install",
      "global",
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
    ),
  );
  return candidates;
}

function findOmpCompatModule(): string | null {
  for (const root of ompRootCandidates()) {
    const candidate = path.join(
      root,
      "src",
      "extensibility",
      "plugins",
      "legacy-pi-compat.ts",
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const compatModule = findOmpCompatModule();
if (!compatModule) {
  console.log("SKIP: OMP is not installed; nothing to verify");
  process.exit(0);
}

console.log(`OMP compat module: ${compatModule}`);
const { installLegacyPiSpecifierShim, loadLegacyPiModule } = await import(
  compatModule
);
installLegacyPiSpecifierShim();

const adapterPath = path.join(repoRoot, "src", "adapter.ts");
const mod = await loadLegacyPiModule(adapterPath);

const checks: Array<[string, boolean, string]> = [
  ["OMP mode detected", mod.isOmp === true, String(mod.isOmp)],
  [
    "CONFIG_DIR_NAME resolves to OMP's .omp",
    mod.EXTENSION_DIR === ".omp",
    String(mod.EXTENSION_DIR),
  ],
  [
    "agent directory resolves under OMP's .omp",
    typeof mod.AGENT_DIR === "string" &&
      mod.AGENT_DIR.split(path.sep).includes(".omp"),
    String(mod.AGENT_DIR),
  ],
  [
    "pi-coding-agent import resolved (DynamicBorder present)",
    typeof mod.DynamicBorder !== "undefined",
    typeof mod.DynamicBorder,
  ],
  [
    "pi-tui import resolved (Container present)",
    typeof mod.Container === "function",
    typeof mod.Container,
  ],
  [
    "pi-tui import resolved (truncateToWidth present)",
    typeof mod.truncateToWidth === "function",
    typeof mod.truncateToWidth,
  ],
  [
    "pi-tui import resolved (SelectList present)",
    typeof mod.SelectList === "function",
    typeof mod.SelectList,
  ],
  [
    "pi-tui import resolved (Spacer present)",
    typeof mod.Spacer === "function",
    typeof mod.Spacer,
  ],
  [
    "pi-tui import resolved (Text present)",
    typeof mod.Text === "function",
    typeof mod.Text,
  ],
];

let failed = 0;
for (const [label, ok, actual] of checks) {
  console.log(`${ok ? "ok" : "NOT OK"}  ${label}  (${actual})`);
  if (!ok) failed++;
}
if (failed > 0) {
  fail(`${failed} of ${checks.length} OMP compatibility assertions failed`);
}
console.log("PASS: OMP loader resolved both @earendil-works/pi-* imports");
