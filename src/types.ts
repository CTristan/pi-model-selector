import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Core Types
// ============================================================================

export interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetsAt?: Date;
}

export interface UsageSnapshot {
  provider: string;
  displayName: string;
  windows: RateWindow[];
  plan?: string;
  error?: string;
  account?: string;
}

export interface UsageMappingKey {
  provider: string;
  account?: string;
  window?: string;
  windowPattern?: string;
}

export interface ModelMappingTarget {
  provider: string;
  id: string;
}

export interface MappingEntry {
  usage: UsageMappingKey;
  model?: ModelMappingTarget;
  ignore?: boolean;
  combine?: string;
}

export type PriorityRule =
  | "fullAvailability"
  | "remainingPercent"
  | "earliestReset";

export interface ModelSelectorConfig {
  mappings: MappingEntry[];
  priority?: PriorityRule[];
  widget?: WidgetConfig;
  autoRun?: boolean;
}

export interface WidgetConfig {
  enabled?: boolean;
  placement?: "aboveEditor" | "belowEditor";
  showCount?: number; // How many top candidates to show (default: 3)
}

export interface UsageCandidate {
  provider: string;
  displayName: string;
  windowLabel: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: Date;
  account?: string;
  isSynthetic?: boolean;
}

export interface LoadedConfig {
  mappings: MappingEntry[];
  priority: PriorityRule[];
  widget: Required<WidgetConfig>;
  autoRun: boolean;
  disabledProviders: ProviderName[];
  debugLog?: {
    enabled: boolean;
    path: string;
  };
  sources: { globalPath: string; projectPath: string };
  raw: { global: Record<string, unknown>; project: Record<string, unknown> };
}

export const ALL_PROVIDERS = [
  "anthropic",
  "copilot",
  "gemini",
  "codex",
  "antigravity",
  "kiro",
  "zai",
] as const;
export type ProviderName = (typeof ALL_PROVIDERS)[number];

export const DEFAULT_DISABLED_PROVIDERS: readonly ProviderName[] = [
  "kiro",
  "zai",
];

// ============================================================================
// Utility Functions
// ============================================================================

let currentConfig: LoadedConfig | undefined,
  isWriting = false;
const logQueue: string[] = [];

export function setGlobalConfig(config: LoadedConfig | undefined): void {
  currentConfig = config;
}

export function resetGlobalState(): void {
  currentConfig = undefined;
  isWriting = false;
  logQueue.length = 0;
}

function processLogQueue(): void {
  if (isWriting || logQueue.length === 0 || !currentConfig?.debugLog?.path) {
    return;
  }

  isWriting = true;
  const batch = logQueue.join("");
  logQueue.length = 0;

  const logPath = currentConfig.debugLog.path,
    logDir = path.dirname(logPath);

  fs.mkdir(logDir, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      isWriting = false;
      console.error(
        `[model-selector] Failed to create log directory ${logDir}: ${mkdirErr}`,
      );
      if (currentConfig?.debugLog) {
        currentConfig.debugLog.enabled = false;
      }
      return;
    }

    fs.appendFile(logPath, batch, (err) => {
      isWriting = false;
      if (err) {
        console.error(
          `[model-selector] Failed to write to debug log ${logPath}: ${err}`,
        );
        // Disable logging after failure to avoid noisy loops
        if (currentConfig?.debugLog) {
          currentConfig.debugLog.enabled = false;
        }
      }
      processLogQueue();
    });
  });
}

export function writeDebugLog(message: string): void {
  if (!currentConfig?.debugLog?.enabled) return;
  try {
    const timestamp = new Date().toISOString();
    logQueue.push(`[${timestamp}] ${message}\n`);
    processLogQueue();
  } catch (error: unknown) {
    console.error(
      `[model-selector] Unexpected error in writeDebugLog: ${String(error)}`,
    );
  }
}

export function notify(
  ctx: ExtensionContext,
  level: "info" | "warning" | "error",
  message: string,
): void {
  const prefixedMessage = `[model-selector] ${message}`;
  if (ctx.hasUI) {
    ctx.ui.notify(prefixedMessage, level);
    return;
  }
  if (level === "error") {
    console.error(prefixedMessage);
  } else if (level === "warning") {
    console.warn(prefixedMessage);
  } else {
    console.log(prefixedMessage);
  }
}

export function mappingKey(entry: MappingEntry): string {
  const esc = (s: string | undefined) =>
    (s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return `${esc(entry.usage.provider)}|${esc(entry.usage.account)}|${esc(entry.usage.window)}|${esc(entry.usage.windowPattern)}`;
}

export const DEFAULT_PRIORITY: PriorityRule[] = [
  "fullAvailability",
  "earliestReset",
  "remainingPercent",
];

export const DEFAULT_WIDGET_CONFIG: Required<WidgetConfig> = {
  enabled: true,
  placement: "belowEditor",
  showCount: 3,
};

export const DEFAULT_MAPPINGS: MappingEntry[] = [
  {
    usage: { provider: "anthropic", window: "Sonnet" },
    model: { provider: "anthropic", id: "claude-3-5-sonnet-latest" },
  },
  {
    usage: { provider: "anthropic", window: "Opus" },
    model: { provider: "anthropic", id: "claude-3-opus-latest" },
  },
  {
    usage: { provider: "anthropic", window: "Shared" },
    model: { provider: "anthropic", id: "claude-3-5-sonnet-latest" },
  },
  {
    usage: { provider: "anthropic", window: "5h" },
    ignore: true,
  },
  {
    usage: { provider: "anthropic", window: "Week" },
    ignore: true,
  },
  {
    usage: { provider: "gemini", window: "Flash" },
    model: { provider: "google", id: "gemini-1.5-flash" },
  },
  {
    usage: { provider: "copilot", window: "Chat" },
    model: { provider: "github-copilot", id: "gpt-4o" },
  },
  {
    usage: { provider: "codex", window: "1w" },
    model: { provider: "openai-codex", id: "gpt-4o" },
  },
  {
    usage: { provider: "antigravity", window: "Claude" },
    model: { provider: "google", id: "claude-sonnet-4-5" },
  },
  {
    usage: { provider: "kiro" },
    model: { provider: "google", id: "gemini-1.5-flash" },
  },
  {
    usage: { provider: "zai" },
    model: { provider: "openai", id: "gpt-4o" },
  },
];
