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
 * OMP ships in two layouts, and discovery treats them differently:
 * a package install (bun global or node_modules, reached through the `omp`
 * symlink) exposes `src/extensibility/plugins/legacy-pi-compat.ts` on disk,
 * while the prebuilt standalone binary at `~/.local/bin/omp` bundles the
 * compat module inside the executable where an external process cannot
 * import it.
 *
 * Exit codes:
 *   0  PASS — OMP resolved both imports and the adapter detected OMP mode.
 *   0  SKIP — nothing to verify: OMP is absent, or `omp` is a prebuilt
 *             standalone binary whose bundled internals cannot be imported
 *             from this process (CI-safe).
 *   1  FAIL — OMP is installed but a resolution or detection assertion
 *             failed, or a detected install cannot be verified.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ompDetectedByEnv = process.env.OMP_ROOT !== undefined;
const ompBinary = Bun.which("omp");
const ompDetectedByBinary = ompBinary !== null;

// Relative location of OMP's extension loader entry inside a package install.
const compatModuleRelative = path.join(
  "src",
  "extensibility",
  "plugins",
  "legacy-pi-compat.ts",
);

// Conventional install roots probed when neither OMP_ROOT nor an `omp`
// executable names the installation.
function conventionalOmpRoots(): string[] {
  const home = os.homedir();
  return [
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
  ];
}

const ompDetectedByConventionalRoot = conventionalOmpRoots().some((root) =>
  fs.existsSync(root),
);

function isOmpPackageRoot(dir: string): boolean {
  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    return (
      typeof pkg === "object" &&
      pkg !== null &&
      (pkg as { name?: unknown }).name === "@oh-my-pi/pi-coding-agent"
    );
  } catch {
    return false;
  }
}

// Walk the ancestors of the resolved binary until a directory holds either
// the compat module itself or an @oh-my-pi/pi-coding-agent package.json.
// A fixed two-parent walk assumed dist/cli.js inside the package, which
// mis-derives the root for OMP's prebuilt binary install at ~/.local/bin.
function packageRootFromBinary(binary: string): string | null {
  let dir = path.dirname(binary);
  for (;;) {
    if (fs.existsSync(path.join(dir, compatModuleRelative))) return dir;
    if (isOmpPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type BinaryInstall =
  | { kind: "broken-symlink" }
  | { kind: "standalone-binary" }
  | { kind: "package"; root: string };

function discoverBinaryInstall(): BinaryInstall | null {
  if (!ompBinary) return null;
  let real: string;
  try {
    real = fs.realpathSync(ompBinary);
  } catch {
    return { kind: "broken-symlink" };
  }
  const root = packageRootFromBinary(real);
  return root ? { kind: "package", root } : { kind: "standalone-binary" };
}

const binaryInstall = discoverBinaryInstall();

function ompRootCandidates(): string[] {
  // An explicit OMP_ROOT or a resolved omp binary names the exact installation
  // to verify. Falling through to other installs would let a broken explicit
  // root pass by testing a different one, so return only the explicit source.
  if (ompDetectedByEnv) return [process.env.OMP_ROOT!];

  if (binaryInstall?.kind === "package") return [binaryInstall.root];
  if (binaryInstall) return [];

  return conventionalOmpRoots();
}

function findOmpCompatModule(): string | null {
  for (const root of ompRootCandidates()) {
    const candidate = path.join(root, compatModuleRelative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// OMP's prebuilt binary bundles the compat module inside the executable, so
// this external process cannot import it for a source-level check. Verify the
// binary at least starts, then skip with an explicit reason instead of
// failing or claiming PASS. An explicit OMP_ROOT still takes precedence and
// must not fall through to the binary install.
if (!ompDetectedByEnv && binaryInstall?.kind === "standalone-binary") {
  const version = Bun.spawnSync([ompBinary ?? "omp", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (version.exitCode !== 0) {
    fail(`omp binary at ${ompBinary} exited ${version.exitCode} on --version`);
  }
  console.log(
    "SKIP: omp is a prebuilt standalone binary; its compat module is " +
      "bundled inside the executable and cannot be loaded for a " +
      "source-level check",
  );
  process.exit(0);
}

// SKIP only when nothing indicates OMP is present: no explicit OMP_ROOT, no
// `omp` executable on PATH, and no conventional install root on disk. When a
// detection source succeeds but the compat module is missing, that is a real
// failure (wrong layout or version), not a skip.
const compatModule = findOmpCompatModule();
const ompDetected =
  ompDetectedByEnv || ompDetectedByBinary || ompDetectedByConventionalRoot;
if (!compatModule && ompDetected) {
  fail(
    "OMP detected but legacy-pi-compat.ts not found under any candidate root",
  );
}
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
