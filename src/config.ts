import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type {
  LoadedConfig,
  MappingEntry,
  PriorityRule,
  WidgetConfig,
} from "./types.js";
import {
  ALL_PROVIDERS,
  DEFAULT_DISABLED_PROVIDERS,
  DEFAULT_MAPPINGS,
  DEFAULT_PRIORITY,
  DEFAULT_WIDGET_CONFIG,
  mappingKey,
  notify,
  type ProviderName,
} from "./types.js";

// We'll determine the config path dynamically
let cachedGlobalConfigPath: string | null = null;

function findGlobalConfigPath(): string {
  if (cachedGlobalConfigPath) return cachedGlobalConfigPath;

  // The global config is now stored in the user's home directory
  // to avoid conflicts with the extension source or project files.
  cachedGlobalConfigPath = path.join(
    os.homedir(),
    ".pi",
    "model-selector.json",
  );
  return cachedGlobalConfigPath;
}

export function getGlobalConfigPath(): Promise<string> {
  return Promise.resolve(findGlobalConfigPath());
}

// ============================================================================
// Config File I/O
// ============================================================================

export async function readConfigFile(
  filePath: string,
  errors: string[],
): Promise<Record<string, unknown> | null> {
  try {
    await fs.promises.access(filePath);
  } catch (err) {
    const error = err as { code?: string; message?: string };
    if (error.code === "ENOENT") {
      return null;
    }
    errors.push(
      `Could not access ${filePath}: ${error.message ?? String(err)}`,
    );
    return null;
  }
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8"),
      parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`Failed to read ${filePath}: expected a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    errors.push(`Failed to read ${filePath}: ${String(error)}`);
    return null;
  }
}

export async function saveConfigFile(
  filePath: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.promises.writeFile(
      tempPath,
      `${JSON.stringify(raw, null, 2)}\n`,
      "utf-8",
    );
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.promises.access(tempPath);
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw error;
  }
}

// ============================================================================
// Config Normalization
// ============================================================================

function asConfigShape(raw: Record<string, unknown>): {
  mappings?: unknown[];
  priority?: unknown;
  widget?: unknown;
  autoRun?: unknown;
  debugLog?: unknown;
  disabledProviders?: unknown;
} {
  return {
    mappings: Array.isArray(raw.mappings) ? raw.mappings : undefined,
    priority: Array.isArray(raw.priority)
      ? (raw.priority as PriorityRule[])
      : undefined,
    widget:
      raw.widget && typeof raw.widget === "object" ? raw.widget : undefined,
    autoRun: raw.autoRun,
    debugLog: raw.debugLog,
    disabledProviders: Array.isArray(raw.disabledProviders)
      ? raw.disabledProviders
      : undefined,
  };
}

function normalizeDebugLog(
  raw: { debugLog?: unknown },
  basePath: string,
): { enabled: boolean; path: string } {
  const debug = (raw.debugLog as Record<string, unknown>) || {},
    enabled = debug.enabled === true;
  let logPath = (debug.path as string) || "model-selector.log";

  if (typeof logPath === "string" && !path.isAbsolute(logPath)) {
    logPath = path.resolve(basePath, logPath);
  }

  return { enabled, path: String(logPath) };
}

function normalizeDisabledProviders(
  raw: ReturnType<typeof asConfigShape>,
): ProviderName[] {
  if (!raw.disabledProviders || !Array.isArray(raw.disabledProviders))
    return [];
  const validProviders = new Set<string>(ALL_PROVIDERS);
  return raw.disabledProviders.filter(
    (p): p is ProviderName => typeof p === "string" && validProviders.has(p),
  );
}

function normalizePriority(
  raw: ReturnType<typeof asConfigShape>,
  sourceLabel: string,
  errors: string[],
): PriorityRule[] | undefined {
  if (!raw || raw.priority === undefined) return undefined;
  if (!Array.isArray(raw.priority) || raw.priority.length === 0) {
    errors.push(`[${sourceLabel}] priority must be a non-empty array`);
    return undefined;
  }

  const validRules = new Set<PriorityRule>([
      "fullAvailability",
      "remainingPercent",
      "earliestReset",
    ]),
    priority: PriorityRule[] = [];

  for (const value of raw.priority) {
    if (!validRules.has(value as PriorityRule)) {
      errors.push(`[${sourceLabel}] priority contains invalid value: ${value}`);
      return undefined;
    }
    priority.push(value as PriorityRule);
  }

  const hasTieBreaker =
    priority.includes("remainingPercent") || priority.includes("earliestReset");
  if (!hasTieBreaker) {
    errors.push(
      `[${sourceLabel}] priority must include at least one of remainingPercent or earliestReset`,
    );
    return undefined;
  }

  return priority;
}

function normalizeWidget(
  raw: ReturnType<typeof asConfigShape>,
): Partial<WidgetConfig> | undefined {
  if (!raw.widget || typeof raw.widget !== "object") return undefined;

  const widget = raw.widget as Record<string, unknown>,
    result: Partial<WidgetConfig> = {};

  if (typeof widget.enabled === "boolean") {
    result.enabled = widget.enabled;
  }
  if (
    widget.placement === "aboveEditor" ||
    widget.placement === "belowEditor"
  ) {
    result.placement = widget.placement;
  }
  if (typeof widget.showCount === "number" && widget.showCount > 0) {
    result.showCount = widget.showCount;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeAutoRun(
  raw: ReturnType<typeof asConfigShape>,
): boolean | undefined {
  if (typeof raw.autoRun === "boolean") {
    return raw.autoRun;
  }
  return undefined;
}

interface RawMappingItem {
  usage?: {
    provider?: unknown;
    account?: unknown;
    window?: unknown;
    windowPattern?: unknown;
  };
  model?: {
    provider?: unknown;
    id?: unknown;
  };
  ignore?: unknown;
}

function normalizeMappings(
  raw: ReturnType<typeof asConfigShape>,
  sourceLabel: string,
  errors: string[],
): MappingEntry[] {
  if (!raw.mappings) return [];

  const mappings: MappingEntry[] = [];
  for (const rawItem of raw.mappings) {
    const item = rawItem as RawMappingItem;
    if (!item || typeof item !== "object" || !item.usage) {
      errors.push(
        `[${sourceLabel}] invalid mapping entry: ${JSON.stringify(item)}`,
      );
      continue;
    }

    const { usage } = item;
    if (typeof usage.provider !== "string") {
      errors.push(`[${sourceLabel}] mapping.usage.provider must be a string`);
      continue;
    }

    if (
      usage.windowPattern !== undefined &&
      typeof usage.windowPattern === "string"
    ) {
      try {
        new RegExp(usage.windowPattern);
      } catch {
        errors.push(
          `[${sourceLabel}] invalid windowPattern "${usage.windowPattern}"`,
        );
        continue;
      }
    }

    const { model } = item,
      ignore = item.ignore === true;

    if (ignore && model) {
      errors.push(
        `[${sourceLabel}] invalid mapping entry: cannot specify both "ignore: true" and a "model"`,
      );
      continue;
    }

    if (!model && !ignore) {
      continue; // Skip entries without model or ignore
    }

    if (
      model &&
      (typeof model.provider !== "string" || typeof model.id !== "string")
    ) {
      errors.push(
        `[${sourceLabel}] mapping.model must have provider and id strings`,
      );
      continue;
    }

    mappings.push({
      usage: {
        provider: usage.provider,
        account: typeof usage.account === "string" ? usage.account : undefined,
        window: typeof usage.window === "string" ? usage.window : undefined,
        windowPattern:
          typeof usage.windowPattern === "string"
            ? usage.windowPattern
            : undefined,
      },
      model: model
        ? { provider: model.provider as string, id: model.id as string }
        : undefined,
      ignore,
    });
  }

  return mappings;
}

function mergeMappings(
  globalMappings: MappingEntry[],
  projectMappings: MappingEntry[],
): MappingEntry[] {
  const merged = new Map<string, MappingEntry>();
  for (const mapping of globalMappings) {
    merged.set(mappingKey(mapping), mapping);
  }
  for (const mapping of projectMappings) {
    merged.set(mappingKey(mapping), mapping);
  }
  return Array.from(merged.values());
}

function mergeWidgetConfig(
  globalWidget: Partial<WidgetConfig> | undefined,
  projectWidget: Partial<WidgetConfig> | undefined,
): Required<WidgetConfig> {
  return {
    enabled:
      projectWidget?.enabled ??
      globalWidget?.enabled ??
      DEFAULT_WIDGET_CONFIG.enabled,
    placement:
      projectWidget?.placement ??
      globalWidget?.placement ??
      DEFAULT_WIDGET_CONFIG.placement,
    showCount:
      projectWidget?.showCount ??
      globalWidget?.showCount ??
      DEFAULT_WIDGET_CONFIG.showCount,
  };
}

// ============================================================================
// Config Loading
// ============================================================================

export async function loadConfig(
  ctx: ExtensionContext,
  options: { requireMappings?: boolean } = {},
): Promise<LoadedConfig | null> {
  const errors: string[] = [],
    requireMappings = options.requireMappings ?? true,
    projectPath = path.join(ctx.cwd, ".pi", "model-selector.json"),
    globalConfigPath = await getGlobalConfigPath();

  let globalRaw = await readConfigFile(globalConfigPath, errors),
    shouldSeedGlobal = false;

  if (globalRaw === null && errors.length === 0) {
    // We only seed if globalRaw is null AND errors is empty, which
    // indicates the file was missing.
    shouldSeedGlobal = true;
    globalRaw = {
      priority: DEFAULT_PRIORITY,
      widget: DEFAULT_WIDGET_CONFIG,
      mappings: DEFAULT_MAPPINGS,
      disabledProviders: DEFAULT_DISABLED_PROVIDERS,
    };
  }

  const projectRaw = (await readConfigFile(projectPath, errors)) ?? {
    mappings: [],
  };

  if (errors.length > 0) {
    notify(ctx, "error", errors.join("\n"));
    return null;
  }

  const globalConfig = asConfigShape(globalRaw ?? {}),
    projectConfig = asConfigShape(projectRaw),
    globalMappings = normalizeMappings(globalConfig, globalConfigPath, errors),
    projectMappings = normalizeMappings(projectConfig, projectPath, errors),
    globalPriority = normalizePriority(globalConfig, globalConfigPath, errors),
    projectPriority = normalizePriority(projectConfig, projectPath, errors),
    globalWidget = normalizeWidget(globalConfig),
    projectWidget = normalizeWidget(projectConfig),
    globalAutoRun = normalizeAutoRun(globalConfig),
    projectAutoRun = normalizeAutoRun(projectConfig),
    globalDebugLog = normalizeDebugLog(
      globalConfig,
      path.dirname(globalConfigPath),
    ),
    projectDebugLog = normalizeDebugLog(projectConfig, ctx.cwd),
    globalDisabled = normalizeDisabledProviders(globalConfig),
    projectDisabled = normalizeDisabledProviders(projectConfig);

  if (errors.length > 0) {
    notify(ctx, "error", errors.join("\n"));
    return null;
  }

  const mappings = mergeMappings(globalMappings, projectMappings);
  // Ensure we have mappings before proceeding
  if (requireMappings && mappings.length === 0) {
    notify(
      ctx,
      "error",
      `No model selector mappings found. Add mappings to ${globalConfigPath} or ${projectPath}. See config/model-selector.example.json for a reference, or run /model-select-config.`,
    );
    return null;
  }

  // Final check: only seed the global config if everything is valid
  // and we actually reached this point without errors.
  if (shouldSeedGlobal && globalRaw) {
    try {
      await saveConfigFile(globalConfigPath, globalRaw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(
        ctx,
        "error",
        `Failed to seed global config to ${globalConfigPath}: ${message}`,
      );
    }
  }

  return {
    mappings,
    priority: projectPriority ?? globalPriority ?? DEFAULT_PRIORITY,
    widget: mergeWidgetConfig(globalWidget, projectWidget),
    autoRun: projectAutoRun ?? globalAutoRun ?? false,
    disabledProviders: [...new Set([...globalDisabled, ...projectDisabled])],
    debugLog: projectConfig.debugLog ? projectDebugLog : globalDebugLog,
    sources: { globalPath: globalConfigPath, projectPath },
    raw: { global: globalRaw ?? {}, project: projectRaw },
  };
}

// ============================================================================
// Config Mutation
// ============================================================================

export function upsertMapping(
  raw: Record<string, unknown>,
  mapping: MappingEntry,
): void {
  const existing: unknown[] = Array.isArray(raw.mappings) ? raw.mappings : [],
    targetKey = mappingKey(mapping),
    filtered = existing.filter((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("usage" in entry))
        return true;
      try {
        return mappingKey(entry as MappingEntry) !== targetKey;
      } catch {
        return true;
      }
    });
  raw.mappings = [...filtered, mapping];
}

export function removeMapping(
  raw: Record<string, unknown>,
  mapping: MappingEntry,
  options: { onlyIgnore?: boolean } = {},
): { removed: boolean } {
  const existing: unknown[] = Array.isArray(raw.mappings) ? raw.mappings : [],
    targetKey = mappingKey(mapping),
    filtered = existing.filter((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("usage" in entry))
        return true;
      try {
        const key = mappingKey(entry as MappingEntry);
        if (key !== targetKey) return true;
        if (options.onlyIgnore) {
          // If onlyIgnore is true, keep entries that are not ignore entries
          const e = entry as MappingEntry;
          return !(e.ignore === true);
        }
        // Otherwise, remove any matching entry (regardless of model/ignore)
        return false;
      } catch {
        return true;
      }
    });
  raw.mappings = filtered;
  return { removed: filtered.length !== existing.length };
}

export function updateWidgetConfig(
  raw: Record<string, unknown>,
  widgetUpdate: Partial<WidgetConfig>,
): void {
  const existing =
    raw.widget && typeof raw.widget === "object"
      ? (raw.widget as Record<string, unknown>)
      : {};
  raw.widget = { ...existing, ...widgetUpdate };
}

// Utility: return normalized mapping entries from a raw config object
export function getRawMappings(raw: Record<string, unknown>): MappingEntry[] {
  try {
    const errors: string[] = [];
    const shape = asConfigShape(raw);
    return normalizeMappings(shape, "<raw>", errors);
  } catch {
    return [];
  }
}
