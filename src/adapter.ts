import * as os from "node:os";
import * as path from "node:path";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type * as PiTui from "@earendil-works/pi-tui";

/** Pi TUI container component constructor for runtime-compatible UI rendering. */
export let Container: typeof PiTui.Container;
/** Dynamic border component constructor from the active Pi SDK runtime. */
export let DynamicBorder: typeof PiCodingAgent.DynamicBorder;
/** Width-aware text truncation helper from the active TUI package. */
export let truncateToWidth: typeof PiTui.truncateToWidth;
/** Select-list component constructor from the active TUI package. */
export let SelectList: typeof PiTui.SelectList;
/** Spacer component constructor from the active TUI package. */
export let Spacer: typeof PiTui.Spacer;
/** Text component constructor from the active TUI package. */
export let Text: typeof PiTui.Text;

/** Whether the extension is running under Oh My Pi compatibility mode. */
export let isOmp = false;

/**
 * Minimal OMP settings API used to preserve model role state across selection.
 */
export interface OmpSettingsLike {
  /** Returns the model id currently assigned to a role, when present. */
  getModelRole(role: string): string | undefined;
  /** Assigns a model id to a named role. */
  setModelRole(role: string, modelId: string): void;
  /** Reads structured settings values exposed by OMP. */
  get?(path: "modelRoles"): unknown;
  /** Writes structured settings values exposed by OMP. */
  set?(path: "modelRoles", value: Record<string, unknown>): void;
  /** Persists pending settings changes when the runtime requires flushing. */
  flush?(): Promise<void> | void;
}

interface CapturedDefaultModelRole {
  hadDefaultRole: boolean;
  value: unknown;
}

let ompSettingsPromise: Promise<OmpSettingsLike | undefined> | undefined;
let initializeOmpSettings: (() => Promise<OmpSettingsLike>) | undefined;
let runtimeConfigDirName = ".pi";
let runtimeAgentDir = path.join(os.homedir(), runtimeConfigDirName, "agent");

const DEBUG =
  typeof process !== "undefined" && process.env.MODEL_SELECTOR_DEBUG === "1";

function debugLog(msg: string): void {
  if (DEBUG) console.error(`[model-selector:adapter] ${msg}`);
}

debugLog(`import.meta.url = ${import.meta.url}`);

if (typeof process !== "undefined" && process.env.VITEST) {
  // Vitest can't evaluate the full package source (ENOENT on dist/package.json).
  // Mock UI components — tests mock the UI layer anyway.
  debugLog("VITEST detected — using mock components");
  DynamicBorder = class {} as unknown as typeof PiCodingAgent.DynamicBorder;

  Container = class {
    addChild() {}
    render() {
      return [];
    }
  } as unknown as typeof PiTui.Container;
  truncateToWidth = ((s: string) =>
    s) as unknown as typeof PiTui.truncateToWidth;
  SelectList = class {} as unknown as typeof PiTui.SelectList;
  Spacer = class {} as unknown as typeof PiTui.Spacer;
  Text = class {} as unknown as typeof PiTui.Text;
} else {
  // Pi resolves these current package names directly. OMP 17.2.12 rewrites
  // the literal specifiers to its canonical host modules, avoiding duplicate
  // extension registries while preserving Pi's public SDK surface.
  debugLog("loading Pi compatibility packages...");
  const agent = (await import(
    "@earendil-works/pi-coding-agent"
  )) as typeof import("@earendil-works/pi-coding-agent") & {
    settings?: OmpSettingsLike;
    Settings?: {
      init(options?: {
        cwd?: string;
        agentDir?: string;
      }): Promise<OmpSettingsLike>;
    };
  };
  const tui = await import("@earendil-works/pi-tui");

  // Detect the compatibility export by presence only. OMP's exported settings
  // proxy throws when accessed before its compatibility graph is initialized.
  isOmp = "settings" in agent;
  const ompSettingsApi = agent.Settings;
  if (isOmp && ompSettingsApi) {
    initializeOmpSettings = () =>
      ompSettingsApi.init({
        cwd: process.cwd(),
        agentDir: agent.getAgentDir(),
      });
  }
  try {
    runtimeConfigDirName = agent.CONFIG_DIR_NAME;
  } catch (error) {
    debugLog(`using default config directory: ${String(error)}`);
  }
  runtimeAgentDir = path.join(os.homedir(), runtimeConfigDirName, "agent");
  try {
    runtimeAgentDir = agent.getAgentDir();
  } catch (error) {
    debugLog(`using default agent directory: ${String(error)}`);
  }

  debugLog(`detected runtime: ${isOmp ? "OMP" : "Pi"}`);

  DynamicBorder = agent.DynamicBorder;

  Container = tui.Container;
  truncateToWidth = tui.truncateToWidth;
  SelectList = tui.SelectList;
  Spacer = tui.Spacer;
  Text = tui.Text;

  debugLog(`DynamicBorder = ${agent.DynamicBorder ? "ok" : "MISSING"}`);
  debugLog(`Container = ${tui.Container ? "ok" : "MISSING"}`);
  debugLog(`truncateToWidth = ${typeof tui.truncateToWidth}`);
  debugLog(`SelectList = ${tui.SelectList ? "ok" : "MISSING"}`);
  debugLog(`EXTENSION_DIR = ${runtimeConfigDirName}`);
}

/** Per-runtime directory name used for model-selector state files. */
export const EXTENSION_DIR = runtimeConfigDirName;
/** Configured agent directory supplied by the active host. */
export const AGENT_DIR = runtimeAgentDir;

function readModelRoles(settings: OmpSettingsLike): Record<string, unknown> {
  if (typeof settings.get !== "function") {
    const fallback = settings.getModelRole("default");
    return fallback === undefined ? {} : { default: fallback };
  }
  const roles = settings.get("modelRoles");
  return roles && typeof roles === "object" && !Array.isArray(roles)
    ? { ...(roles as Record<string, unknown>) }
    : {};
}

function captureDefaultModelRole(
  settings: OmpSettingsLike,
): CapturedDefaultModelRole {
  const roles = readModelRoles(settings);
  if (Object.hasOwn(roles, "default")) {
    return { hadDefaultRole: true, value: roles.default };
  }
  return { hadDefaultRole: false, value: undefined };
}

async function restoreDefaultModelRole(
  settings: OmpSettingsLike,
  captured: CapturedDefaultModelRole,
): Promise<void> {
  if (captured.hadDefaultRole && typeof captured.value === "string") {
    settings.setModelRole("default", captured.value);
  } else {
    if (typeof settings.set !== "function") {
      throw new Error(
        "OMP settings API cannot restore an absent default model role",
      );
    }
    const roles = readModelRoles(settings);
    if (captured.hadDefaultRole) {
      roles.default = captured.value;
    } else {
      delete roles.default;
    }
    settings.set("modelRoles", roles);
  }

  await settings.flush?.();
}

async function getOmpSettings(): Promise<OmpSettingsLike | undefined> {
  if (!initializeOmpSettings) return undefined;
  ompSettingsPromise ??= initializeOmpSettings().catch((error) => {
    ompSettingsPromise = undefined;
    debugLog(`OMP settings initialization failed: ${String(error)}`);
    return undefined;
  });
  return ompSettingsPromise;
}

/**
 * Runs an action while restoring OMP's default model role afterward when enabled.
 */
export async function withPreservedOmpDefaultModelRole<T>(
  preserveDefaultModel: boolean | undefined,
  action: () => Promise<T>,
  settings?: OmpSettingsLike,
): Promise<T> {
  if (preserveDefaultModel === false) return await action();
  const activeSettings = settings ?? (await getOmpSettings());
  if (!activeSettings) return await action();

  const captured = captureDefaultModelRole(activeSettings);
  let actionError: unknown, result: T | undefined;

  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  try {
    await restoreDefaultModelRole(activeSettings, captured);
  } catch (error) {
    if (actionError === undefined) {
      throw error;
    }
    debugLog(
      `failed to restore OMP default model role after failed setModel: ${String(
        error,
      )}`,
    );
  }

  if (actionError !== undefined) {
    throw actionError;
  }

  return result as T;
}
