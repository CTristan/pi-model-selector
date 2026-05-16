import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Core Types
// ============================================================================

/**
 * Reset window reported by a provider usage endpoint.
 */
export interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetsAt?: Date;
}

/**
 * Provider usage payload normalized for candidate selection.
 */
export interface UsageSnapshot {
  provider: string;
  displayName: string;
  windows: RateWindow[];
  plan?: string;
  error?: string;
  account?: string;
}

/**
 * Configured selector key that matches a provider usage window.
 */
export interface UsageMappingKey {
  provider: string;
  account?: string;
  window?: string;
  windowPattern?: string;
}

/**
 * Pi model identifier selected when a usage mapping wins.
 */
export interface ModelMappingTarget {
  provider: string;
  id: string;
}

/**
 * Configuration rule connecting usage windows to model targets or ignores.
 */
export interface MappingEntry {
  usage: UsageMappingKey;
  model?: ModelMappingTarget;
  ignore?: boolean;
  combine?: string;
  reserve?: number; // Minimum remaining percentage (0-99) to preserve; candidate excluded if remainingPercent <= reserve
}

/**
 * Candidate sorting rule used to rank available usage windows.
 */
export type PriorityRule =
  | "fullAvailability"
  | "remainingPercent"
  | "earliestReset";

/**
 * Model to select when all mapped candidates are exhausted.
 */
export interface FallbackConfig {
  provider: string;
  id: string;
  lock?: boolean; // default: true
}

/**
 * User-facing model selector configuration loaded from global and project files.
 */
export interface ModelSelectorConfig {
  mappings: MappingEntry[];
  priority?: PriorityRule[];
  widget?: WidgetConfig;
  autoRun?: boolean;
  enableModelLocking?: boolean;
  fallback?: FallbackConfig;
  preserveDefaultModel?: boolean;
}

/**
 * Widget display options for usage candidates in the Pi UI.
 */
export interface WidgetConfig {
  enabled?: boolean;
  placement?: "aboveEditor" | "belowEditor";
  showCount?: number; // How many top candidates to show (default: 3)
}

/**
 * Selectable usage bucket after applying mappings and derived availability.
 */
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

/**
 * Provider-specific Minimax credentials and account settings.
 */
export interface MinimaxSettings {
  groupId?: string;
}

/**
 * Per-provider settings consumed by usage fetchers.
 */
export interface ProviderSettings {
  minimax?: MinimaxSettings;
}

/**
 * Fully resolved selector configuration used at runtime.
 */
export interface LoadedConfig {
  mappings: MappingEntry[];
  priority: PriorityRule[];
  widget: Required<WidgetConfig>;
  autoRun: boolean;
  enableModelLocking: boolean;
  preserveDefaultModel?: boolean;
  disabledProviders: ProviderName[];
  providerSettings?: ProviderSettings;
  debugLog?: {
    enabled: boolean;
    path: string;
  };
  fallback?: FallbackConfig;
  sources: { globalPath: string; projectPath: string };
  raw: { global: Record<string, unknown>; project: Record<string, unknown> };
}

/**
 * Provider names known to the selector.
 */
export const ALL_PROVIDERS = [
  "anthropic",
  "copilot",
  "gemini",
  "codex",
  "antigravity",
  "kiro",
  "zai",
  "minimax",
] as const;
/**
 * Union of provider names supported by selector configuration.
 */
export type ProviderName = (typeof ALL_PROVIDERS)[number];

/**
 * Providers skipped unless the user explicitly maps them.
 */
export const DEFAULT_DISABLED_PROVIDERS: readonly ProviderName[] = [
  "kiro",
  "zai",
  "minimax",
];

// ============================================================================
// Utility Functions
// ============================================================================

let currentConfig: LoadedConfig | undefined,
  isWriting = false;
const logQueue: string[] = [];

/**
 * Stores the loaded config for shared utilities such as debug logging.
 */
export function setGlobalConfig(config: LoadedConfig | undefined): void {
  currentConfig = config;
}

/**
 * Clears process-local selector state between extension runs or tests.
 */
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

/**
 * Appends a timestamped line to the configured debug log when enabled.
 */
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

/**
 * Sends a model-selector message through the Pi UI or console fallback.
 */
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

/**
 * Builds the stable identity key used to group compatible mapping entries.
 */
export function mappingKey(entry: MappingEntry): string {
  const esc = (s: string | undefined) =>
    (s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return `${esc(entry.usage.provider)}|${esc(entry.usage.account)}|${esc(entry.usage.window)}|${esc(entry.usage.windowPattern)}`;
}

/**
 * Default priority order for selecting between eligible candidates.
 */
export const DEFAULT_PRIORITY: PriorityRule[] = [
  "fullAvailability",
  "earliestReset",
  "remainingPercent",
];

/**
 * Default widget settings used when config omits widget options.
 */
export const DEFAULT_WIDGET_CONFIG: Required<WidgetConfig> = {
  enabled: true,
  placement: "belowEditor",
  showCount: 3,
};

/**
 * Built-in mappings for common provider usage windows and models.
 */
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
];
