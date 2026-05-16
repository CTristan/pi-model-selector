import type * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type * as PiTui from "@mariozechner/pi-tui";

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

let ompSettings: OmpSettingsLike | undefined;

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
  DynamicBorder = class {} as any;

  Container = class {
    addChild() {}
    render() {
      return [];
    }
  } as any;
  truncateToWidth = ((s: string) => s) as any;
  SelectList = class {} as any;
  Spacer = class {} as any;
  Text = class {} as any;
} else {
  // Always import the legacy Pi package names. OMP's extension loader rewrites
  // these literal specifiers to @oh-my-pi while mirroring the extension; probing
  // @oh-my-pi directly re-enters OMP's SDK import during extension resolution.
  debugLog("loading Pi compatibility packages...");
  const agent = (await import(
    "@mariozechner/pi-coding-agent"
  )) as typeof import("@mariozechner/pi-coding-agent") & {
    settings?: OmpSettingsLike;
  };
  const tui = await import("@mariozechner/pi-tui");

  ompSettings = agent.settings as OmpSettingsLike | undefined;
  isOmp = ompSettings !== undefined;

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
  debugLog(`EXTENSION_DIR = ${isOmp ? ".omp" : ".pi"}`);
}

/** Per-runtime directory name used for model-selector state files. */
export const EXTENSION_DIR = isOmp ? ".omp" : ".pi";

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

/**
 * Runs an action while restoring OMP's default model role afterward when enabled.
 */
export async function withPreservedOmpDefaultModelRole<T>(
  preserveDefaultModel: boolean | undefined,
  action: () => Promise<T>,
  settings: OmpSettingsLike | undefined = ompSettings,
): Promise<T> {
  if (preserveDefaultModel === false || !settings) {
    return await action();
  }

  const captured = captureDefaultModelRole(settings);
  let actionError: unknown, result: T | undefined;

  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  try {
    await restoreDefaultModelRole(settings, captured);
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
