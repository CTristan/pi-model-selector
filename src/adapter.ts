import type * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type * as PiTui from "@mariozechner/pi-tui";

export let Container: typeof PiTui.Container;
export let DynamicBorder: typeof PiCodingAgent.DynamicBorder;
export let truncateToWidth: typeof PiTui.truncateToWidth;
export let SelectList: typeof PiTui.SelectList;
export let Spacer: typeof PiTui.Spacer;
export let Text: typeof PiTui.Text;

export let isOmp = false;

export interface OmpSettingsLike {
  getModelRole(role: string): string | undefined;
  setModelRole(role: string, modelId: string): void;
  get?(path: "modelRoles"): unknown;
  set?(path: "modelRoles", value: Record<string, unknown>): void;
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
  // Detection: try importing @oh-my-pi first.
  // Bun's createRequire.resolve does NOT walk far enough up the directory tree
  // to find globally-installed packages, so we use dynamic import() instead,
  // which uses Bun's native ESM resolver that handles this correctly.
  let agent: any;
  let tui: any;

  try {
    debugLog("probing @oh-my-pi/pi-coding-agent...");
    const ompAgent = "@oh-my-pi/pi-coding-agent";
    agent = (await import(ompAgent)) as any;
    debugLog("probing @oh-my-pi/pi-tui...");
    const ompTui = "@oh-my-pi/pi-tui";
    tui = (await import(ompTui)) as any;
    isOmp = true;
    ompSettings = agent.settings as OmpSettingsLike | undefined;
    debugLog("OMP packages resolved successfully");
  } catch (e: any) {
    debugLog(`OMP probe failed: ${e.message}`);
    debugLog("falling back to @mariozechner packages");
    const piAgent = "@mariozechner/pi-coding-agent";
    agent = await import(piAgent);
    const piTui = "@mariozechner/pi-tui";
    tui = await import(piTui);
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
  debugLog(`EXTENSION_DIR = ${isOmp ? ".omp" : ".pi"}`);
}

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
