import type * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type * as PiTui from "@mariozechner/pi-tui";

export let Container: typeof PiTui.Container;
export let DynamicBorder: typeof PiCodingAgent.DynamicBorder;
export let truncateToWidth: typeof PiTui.truncateToWidth;
export let SelectList: typeof PiTui.SelectList;
export let Spacer: typeof PiTui.Spacer;
export let Text: typeof PiTui.Text;

export let isOmp = false;

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
