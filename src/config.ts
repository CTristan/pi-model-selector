import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { EXTENSION_DIR, isOmp } from "./adapter.js";

import type {
  FallbackConfig,
  LoadedConfig,
  MappingEntry,
  MinimaxSettings,
  PriorityRule,
  ProviderSettings,
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
    EXTENSION_DIR,
    "model-selector.json",
  );
  return cachedGlobalConfigPath;
}

/**
 * Resolves the path to the global configuration file.
 */
export function getGlobalConfigPath(): Promise<string> {
  return Promise.resolve(findGlobalConfigPath());
}

// ============================================================================
// Config File I/O
// ============================================================================

/**
 * Reads and parses a JSON configuration file from disk.
 */
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

/**
 * Saves a configuration object to disk as formatted JSON.
 */
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
  enableModelLocking?: unknown;
  fallback?: unknown;
  debugLog?: unknown;
  disabledProviders?: unknown;
  providerSettings?: unknown;
  preserveDefaultModel?: unknown;
} {
  const shape: {
    mappings?: unknown[];
    priority?: unknown;
    widget?: unknown;
    autoRun?: unknown;
    enableModelLocking?: unknown;
    fallback?: unknown;
    debugLog?: unknown;
    disabledProviders?: unknown;
    providerSettings?: unknown;
    preserveDefaultModel?: unknown;
  } = {};

  if (Array.isArray(raw.mappings)) {
    shape.mappings = raw.mappings;
  }
  if (Array.isArray(raw.priority)) {
    shape.priority = raw.priority as PriorityRule[];
  }
  if (raw.widget && typeof raw.widget === "object") {
    shape.widget = raw.widget;
  }
  if (Object.hasOwn(raw, "autoRun")) {
    shape.autoRun = raw.autoRun;
  }
  if (Object.hasOwn(raw, "enableModelLocking")) {
    shape.enableModelLocking = raw.enableModelLocking;
  }
  if (Object.hasOwn(raw, "preserveDefaultModel")) {
    shape.preserveDefaultModel = raw.preserveDefaultModel;
  }
  if (Object.hasOwn(raw, "fallback")) {
    shape.fallback = raw.fallback;
  }
  if (Object.hasOwn(raw, "debugLog")) {
    shape.debugLog = raw.debugLog;
  }
  if (Array.isArray(raw.disabledProviders)) {
    shape.disabledProviders = raw.disabledProviders;
  }
  if (raw.providerSettings && typeof raw.providerSettings === "object") {
    shape.providerSettings = raw.providerSettings;
  }

  return shape;
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

function normalizeProviderSettings(
  raw: ReturnType<typeof asConfigShape>,
): ProviderSettings {
  if (!raw.providerSettings || typeof raw.providerSettings !== "object") {
    return {};
  }
  const settings = raw.providerSettings as Record<string, unknown>;
  const result: ProviderSettings = {};

  if (settings.minimax && typeof settings.minimax === "object") {
    const minimax = settings.minimax as Record<string, unknown>;
    const minimaxSettings: MinimaxSettings = {};
    if (typeof minimax.groupId === "string") {
      const trimmedGroupId = minimax.groupId.trim();
      if (trimmedGroupId.length > 0) {
        minimaxSettings.groupId = trimmedGroupId;
      }
    }
    result.minimax = minimaxSettings;
  }

  return result;
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

function normalizeEnableModelLocking(
  raw: ReturnType<typeof asConfigShape>,
  sourceLabel: string,
  errors: string[],
): boolean | undefined {
  if (!Object.hasOwn(raw, "enableModelLocking")) {
    return undefined;
  }
  if (typeof raw.enableModelLocking !== "boolean") {
    errors.push(
      `[${sourceLabel}] enableModelLocking must be a boolean if present`,
    );
    return undefined;
  }
  return raw.enableModelLocking;
}

function normalizePreserveDefaultModel(
  raw: ReturnType<typeof asConfigShape>,
  sourceLabel: string,
  errors: string[],
): boolean | undefined {
  if (!Object.hasOwn(raw, "preserveDefaultModel")) {
    return undefined;
  }
  if (typeof raw.preserveDefaultModel !== "boolean") {
    errors.push(
      `[${sourceLabel}] preserveDefaultModel must be a boolean if present`,
    );
    return undefined;
  }
  return raw.preserveDefaultModel;
}

function normalizeFallback(
  raw: ReturnType<typeof asConfigShape>,
  sourceLabel: string,
  errors: string[],
): FallbackConfig | undefined {
  if (!raw.fallback || typeof raw.fallback !== "object") {
    return undefined;
  }

  const fallback = raw.fallback as Record<string, unknown>;

  // Validate required fields
  if (
    typeof fallback.provider !== "string" ||
    fallback.provider.trim() === ""
  ) {
    errors.push(
      `[${sourceLabel}] fallback.provider must be a non-empty string`,
    );
    return undefined;
  }

  if (typeof fallback.id !== "string" || fallback.id.trim() === "") {
    errors.push(`[${sourceLabel}] fallback.id must be a non-empty string`);
    return undefined;
  }

  // Validate lock field if present
  if (fallback.lock !== undefined && typeof fallback.lock !== "boolean") {
    errors.push(`[${sourceLabel}] fallback.lock must be a boolean if present`);
    return undefined;
  }

  return {
    provider: fallback.provider.trim(),
    id: fallback.id.trim(),
    lock: fallback.lock === undefined ? true : fallback.lock,
  };
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
  combine?: unknown;
  reserve?: unknown;
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
    let combine =
      typeof item.combine === "string" ? item.combine.trim() : undefined;
    if (combine === "") {
      combine = undefined;
    }

    if ((ignore && model) || (ignore && combine) || (model && combine)) {
      errors.push(
        `[${sourceLabel}] invalid mapping entry: "model", "ignore: true", and "combine" are mutually exclusive`,
      );
      continue;
    }

    // Validate reserve field before early skip
    let reserve: number | undefined;
    if (item.reserve !== undefined) {
      if (typeof item.reserve !== "number") {
        errors.push(
          `[${sourceLabel}] mapping.reserve must be a number if provided`,
        );
        continue;
      }
      if (!Number.isInteger(item.reserve)) {
        errors.push(
          `[${sourceLabel}] mapping.reserve must be an integer (got ${item.reserve})`,
        );
        continue;
      }
      if (item.reserve < 0 || item.reserve >= 100) {
        errors.push(
          `[${sourceLabel}] mapping.reserve must be >= 0 and < 100 (got ${item.reserve})`,
        );
        continue;
      }
      if (!model) {
        errors.push(
          `[${sourceLabel}] mapping.reserve is only valid on mappings with a model target`,
        );
        continue;
      }
      reserve = item.reserve;
    }

    if (!model && !ignore && !combine) {
      continue; // Skip entries without model, ignore, or combine
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

    const normalizedUsage: MappingEntry["usage"] = {
      provider: usage.provider,
    };

    if (typeof usage.account === "string") {
      normalizedUsage.account = usage.account;
    }
    if (typeof usage.window === "string") {
      normalizedUsage.window = usage.window;
    }
    if (typeof usage.windowPattern === "string") {
      normalizedUsage.windowPattern = usage.windowPattern;
    }

    const normalizedMapping: MappingEntry = {
      usage: normalizedUsage,
      ignore,
    };

    if (model) {
      normalizedMapping.model = {
        provider: model.provider as string,
        id: model.id as string,
      };
    }
    if (combine !== undefined) {
      normalizedMapping.combine = combine;
    }
    if (reserve !== undefined) {
      normalizedMapping.reserve = reserve;
    }

    mappings.push(normalizedMapping);
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

/**
 * Loads and merges the global and project configurations.
 */
export async function loadConfig(
  ctx: ExtensionContext,
  options: { requireMappings?: boolean; seedGlobal?: boolean } = {},
): Promise<LoadedConfig | null> {
  const errors: string[] = [],
    requireMappings = options.requireMappings ?? true,
    seedGlobal = options.seedGlobal ?? true,
    projectPath = path.join(ctx.cwd, EXTENSION_DIR, "model-selector.json"),
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
    globalEnableModelLocking = normalizeEnableModelLocking(
      globalConfig,
      globalConfigPath,
      errors,
    ),
    projectEnableModelLocking = normalizeEnableModelLocking(
      projectConfig,
      projectPath,
      errors,
    ),
    globalPreserveDefaultModel = normalizePreserveDefaultModel(
      globalConfig,
      globalConfigPath,
      errors,
    ),
    projectPreserveDefaultModel = normalizePreserveDefaultModel(
      projectConfig,
      projectPath,
      errors,
    ),
    globalFallback = normalizeFallback(globalConfig, globalConfigPath, errors),
    projectFallback = normalizeFallback(projectConfig, projectPath, errors),
    globalDebugLog = normalizeDebugLog(
      globalConfig,
      path.dirname(globalConfigPath),
    ),
    projectDebugLog = normalizeDebugLog(projectConfig, ctx.cwd),
    globalDisabled = normalizeDisabledProviders(globalConfig),
    projectDisabled = normalizeDisabledProviders(projectConfig),
    globalProviderSettings = normalizeProviderSettings(globalConfig),
    projectProviderSettings = normalizeProviderSettings(projectConfig);

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
  if (seedGlobal && shouldSeedGlobal && globalRaw) {
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

  const mergedFallback = projectFallback ?? globalFallback;

  const providerSettings: ProviderSettings = {
    ...globalProviderSettings,
    ...projectProviderSettings,
    minimax: {
      ...(globalProviderSettings.minimax ?? {}),
      ...(projectProviderSettings.minimax ?? {}),
    },
  };

  return {
    mappings,
    priority: projectPriority ?? globalPriority ?? DEFAULT_PRIORITY,
    widget: mergeWidgetConfig(globalWidget, projectWidget),
    autoRun: projectAutoRun ?? globalAutoRun ?? false,
    enableModelLocking:
      projectEnableModelLocking ?? globalEnableModelLocking ?? true,
    preserveDefaultModel:
      projectPreserveDefaultModel ?? globalPreserveDefaultModel ?? isOmp,
    disabledProviders: [...new Set([...globalDisabled, ...projectDisabled])],
    providerSettings,
    ...(mergedFallback !== undefined ? { fallback: mergedFallback } : {}),
    debugLog: projectConfig.debugLog ? projectDebugLog : globalDebugLog,
    sources: { globalPath: globalConfigPath, projectPath },
    raw: { global: globalRaw ?? {}, project: projectRaw },
  };
}

// ============================================================================
// Config Cleanup
// ============================================================================

/**
 * The result of a configuration cleanup operation.
 */
export interface CleanupConfigResult {
  changed: boolean;
  summary: string[];
  removedExamples: boolean;
  fixedDebugLogPath: boolean;
  removedInvalidMappings: number;
  removedDuplicateMappings: number;
  removedUnavailableModelMappings: number;
}

/**
 * Options for the configuration cleanup operation.
 */
export interface CleanupConfigOptions {
  scope?: "global" | "project";
  /** Optional predicate used to drop mappings whose target model is unavailable. */
  modelExists?: (provider: string, id: string) => boolean;
}

/**
 * Cleans up raw configuration by removing unreferenced mappings and preserving valid state.
 */
export function cleanupConfigRaw(
  raw: Record<string, unknown>,
  options: CleanupConfigOptions = {},
): CleanupConfigResult {
  const summary: string[] = [];
  let removedExamples = false,
    fixedDebugLogPath = false,
    removedInvalidMappings = 0,
    removedDuplicateMappings = 0,
    removedUnavailableModelMappings = 0,
    changed = false;

  if (Object.hasOwn(raw, "examples")) {
    delete raw.examples;
    removedExamples = true;
    changed = true;
    summary.push('Removed unused top-level "examples" block.');
  }

  if (raw.debugLog && typeof raw.debugLog === "object") {
    const debug = raw.debugLog as Record<string, unknown>;
    if (options.scope === "global" && typeof debug.path === "string") {
      const originalPath = debug.path.trim(),
        escapedExtensionDir = EXTENSION_DIR.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
        correctedPath = originalPath.replace(
          new RegExp(`^(?:\\.\\/)?${escapedExtensionDir}\\/`),
          "",
        );
      if (correctedPath.length > 0 && correctedPath !== originalPath) {
        debug.path = correctedPath;
        fixedDebugLogPath = true;
        changed = true;
        summary.push(
          `Fixed global debug log path from "${originalPath}" to "${correctedPath}".`,
        );
      }
    }
  }

  // Validate fallback model against registry if modelExists is provided
  if (raw.fallback && typeof raw.fallback === "object" && options.modelExists) {
    const fallback = raw.fallback as Record<string, unknown>;
    const provider = fallback.provider;
    const id = fallback.id;

    if (typeof provider === "string" && typeof id === "string") {
      const providerTrimmed = provider.trim();
      const idTrimmed = id.trim();
      try {
        if (!options.modelExists(providerTrimmed, idTrimmed)) {
          delete raw.fallback;
          changed = true;
          summary.push(
            `Removed fallback model "${providerTrimmed}/${idTrimmed}" because the Pi model provider/id combination is unavailable.`,
          );
        }
      } catch (err) {
        summary.push(
          `Could not verify availability of fallback model "${providerTrimmed}/${idTrimmed}" due to an error; keeping the fallback. Error: ${String(err)}`,
        );
      }
    }
  }

  if (Array.isArray(raw.mappings)) {
    const originalMappings = raw.mappings,
      shape = asConfigShape({ mappings: originalMappings }),
      errors: string[] = [],
      normalizedMappings = normalizeMappings(shape, "<cleanup>", errors),
      modelFilteredMappings = normalizedMappings.filter((mapping) => {
        if (!mapping.model || !options.modelExists) return true;
        try {
          return options.modelExists(mapping.model.provider, mapping.model.id);
        } catch (err) {
          summary.push(
            `Could not verify availability of model "${mapping.model.provider}/${mapping.model.id}" due to an error; keeping the mapping. Error: ${String(err)}`,
          );
          return true;
        }
      });

    removedInvalidMappings = Math.max(
      0,
      originalMappings.length - normalizedMappings.length,
    );

    removedUnavailableModelMappings = Math.max(
      0,
      normalizedMappings.length - modelFilteredMappings.length,
    );

    const dedupedByKey = new Map<string, MappingEntry>();
    for (const mapping of modelFilteredMappings) {
      const key = mappingKey(mapping);
      dedupedByKey.set(key, mapping);
    }

    const dedupedMappings = Array.from(dedupedByKey.values());
    removedDuplicateMappings = Math.max(
      0,
      modelFilteredMappings.length - dedupedMappings.length,
    );

    if (
      removedInvalidMappings > 0 ||
      removedUnavailableModelMappings > 0 ||
      removedDuplicateMappings > 0
    ) {
      raw.mappings = dedupedMappings;
      changed = true;
    }

    if (removedInvalidMappings > 0) {
      summary.push(
        `Removed ${removedInvalidMappings} invalid mapping entr${removedInvalidMappings === 1 ? "y" : "ies"}.`,
      );
    }

    if (removedUnavailableModelMappings > 0) {
      summary.push(
        `Removed ${removedUnavailableModelMappings} mapping entr${removedUnavailableModelMappings === 1 ? "y" : "ies"} with unavailable Pi model provider/id combinations.`,
      );
    }

    if (removedDuplicateMappings > 0) {
      summary.push(
        `Removed ${removedDuplicateMappings} duplicate mapping entr${removedDuplicateMappings === 1 ? "y" : "ies"}.`,
      );
    }
  }

  return {
    changed,
    summary,
    removedExamples,
    fixedDebugLogPath,
    removedInvalidMappings,
    removedDuplicateMappings,
    removedUnavailableModelMappings,
  };
}

// ============================================================================
// Config Mutation
// ============================================================================

/**
 * Options for clearing bucket mappings.
 */
export interface ClearBucketMappingsOptions {
  provider: string;
  account?: string;
  window: string;
}

/**
 * Clears mapping entries for specific buckets.
 */
export function clearBucketMappings(
  raw: Record<string, unknown>,
  options: ClearBucketMappingsOptions,
): number {
  const existing: unknown[] = Array.isArray(raw.mappings) ? raw.mappings : [];
  let removed = 0;

  const filtered = existing.filter((entry: unknown) => {
    if (!entry || typeof entry !== "object") return true;

    const item = entry as RawMappingItem;
    if (!item.usage || typeof item.usage !== "object") return true;
    if (typeof item.usage.provider !== "string") return true;
    if (item.usage.provider !== options.provider) return true;

    const entryAccount =
      typeof item.usage.account === "string" ? item.usage.account : undefined;

    const accountMatches =
      options.account === undefined
        ? entryAccount === undefined
        : entryAccount === undefined || entryAccount === options.account;
    if (!accountMatches) return true;

    const entryWindow =
      typeof item.usage.window === "string" ? item.usage.window : undefined;
    if (entryWindow !== options.window) return true;

    const hasAction =
      item.ignore === true ||
      (typeof item.combine === "string" && item.combine.trim() !== "") ||
      (item.model !== undefined && typeof item.model === "object");
    if (!hasAction) return true;

    removed += 1;
    return false;
  });

  raw.mappings = filtered;
  return removed;
}

/**
 * Inserts or updates a mapping entry in the configuration.
 */
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

/**
 * Removes a specific mapping entry from the configuration.
 */
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

/**
 * Updates the widget configuration settings.
 */
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

/**
 * Updates provider-specific settings in the configuration.
 */
export function updateProviderSettings(
  raw: Record<string, unknown>,
  provider: string,
  settingsUpdate: Record<string, unknown>,
): void {
  const existingSettings =
    raw.providerSettings && typeof raw.providerSettings === "object"
      ? (raw.providerSettings as Record<string, unknown>)
      : {};
  const providerSettings =
    existingSettings[provider] && typeof existingSettings[provider] === "object"
      ? (existingSettings[provider] as Record<string, unknown>)
      : {};

  raw.providerSettings = {
    ...existingSettings,
    [provider]: { ...providerSettings, ...settingsUpdate },
  };
}

// Utility: return normalized mapping entries from a raw config object
/**
 * Extracts and normalizes mapping entries from a raw configuration object.
 */
export function getRawMappings(raw: Record<string, unknown>): MappingEntry[] {
  try {
    const errors: string[] = [];
    const shape = asConfigShape(raw);
    return normalizeMappings(shape, "<raw>", errors);
  } catch {
    return [];
  }
}
