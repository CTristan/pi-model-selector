import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	MappingEntry,
	PriorityRule,
	LoadedConfig,
	WidgetConfig,
} from "./types.js";
import { notify, DEFAULT_PRIORITY, DEFAULT_WIDGET_CONFIG, mappingKey } from "./types.js";
import { fileURLToPath } from "node:url";

// We'll determine the config path dynamically
let cachedGlobalConfigPath: string | null = null;

function getDirname(): string {
	if (typeof __dirname !== "undefined") return __dirname;
	return path.dirname(fileURLToPath(import.meta.url));
}

function findGlobalConfigPath(): string {
	if (cachedGlobalConfigPath) return cachedGlobalConfigPath;
	
	const currentDir = getDirname();
	
	// Check common locations in order of preference
	const candidates = [
		// When installed as a package, config is in the extension directory
		path.join(currentDir, "..", "config", "model-selector.json"),
		// Fallback for development
		path.join(process.cwd(), "config", "model-selector.json"),
	];
	
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			cachedGlobalConfigPath = candidate;
			return candidate;
		}
	}
	
	// Default to the first candidate even if it doesn't exist
	cachedGlobalConfigPath = candidates[0];
	return cachedGlobalConfigPath;
}

export function getGlobalConfigPath(): string {
	return findGlobalConfigPath();
}

// ============================================================================
// Config File I/O
// ============================================================================

export async function readConfigFile(filePath: string, errors: string[]): Promise<Record<string, any> | null> {
	try {
		await fs.promises.access(filePath);
	} catch {
		return null;
	}
	try {
		const raw = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push(`Failed to read ${filePath}: expected a JSON object`);
			return null;
		}
		return parsed as Record<string, any>;
	} catch (error) {
		errors.push(`Failed to read ${filePath}: ${error}`);
		return null;
	}
}

export async function saveConfigFile(filePath: string, raw: Record<string, any>): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.tmp.${Math.random().toString(36).slice(2)}`;
	try {
		await fs.promises.writeFile(tempPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
		await fs.promises.rename(tempPath, filePath);
	} catch (error) {
		try {
			await fs.promises.access(tempPath);
			await fs.promises.unlink(tempPath);
		} catch {}
		throw error;
	}
}

// ============================================================================
// Config Normalization
// ============================================================================

function asConfigShape(raw: Record<string, any>): {
	mappings?: unknown[];
	priority?: unknown;
	widget?: unknown;
	autoRun?: unknown;
	debugLog?: unknown;
	disabledProviders?: unknown;
} {
	return {
		mappings: Array.isArray(raw.mappings) ? raw.mappings : undefined,
		priority: Array.isArray(raw.priority) ? (raw.priority as PriorityRule[]) : undefined,
		widget: raw.widget && typeof raw.widget === "object" ? raw.widget : undefined,
		autoRun: raw.autoRun,
		debugLog: raw.debugLog && typeof raw.debugLog === "object" ? raw.debugLog : undefined,
		disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders : undefined,
	};
}

function normalizeDebugLog(
	raw: ReturnType<typeof asConfigShape>,
	basePath: string
): { enabled: boolean; path: string } {
	const debug = (raw.debugLog as any) || {};
	const enabled = debug.enabled === true;
	let logPath = debug.path || "model-selector.log";

	if (!path.isAbsolute(logPath)) {
		logPath = path.resolve(basePath, logPath);
	}

	return { enabled, path: logPath };
}

function normalizeDisabledProviders(
	raw: ReturnType<typeof asConfigShape>,
	_sourceLabel: string,
	_errors: string[]
): string[] {
	if (!raw.disabledProviders || !Array.isArray(raw.disabledProviders)) return [];
	return raw.disabledProviders.filter((p): p is string => typeof p === "string");
}

function normalizePriority(
	raw: ReturnType<typeof asConfigShape>,
	sourceLabel: string,
	errors: string[]
): PriorityRule[] | undefined {
	if (!raw || raw.priority === undefined) return undefined;
	if (!Array.isArray(raw.priority) || raw.priority.length === 0) {
		errors.push(`[${sourceLabel}] priority must be a non-empty array`);
		return undefined;
	}

	const validRules = new Set<PriorityRule>(["fullAvailability", "remainingPercent", "earliestReset"]);
	const priority: PriorityRule[] = [];

	for (const value of raw.priority) {
		if (!validRules.has(value as PriorityRule)) {
			errors.push(`[${sourceLabel}] priority contains invalid value: ${value}`);
			return undefined;
		}
		priority.push(value as PriorityRule);
	}

	const hasTieBreaker = priority.includes("remainingPercent") || priority.includes("earliestReset");
	if (!hasTieBreaker) {
		errors.push(`[${sourceLabel}] priority must include at least one of remainingPercent or earliestReset`);
		return undefined;
	}

	return priority;
}

function normalizeWidget(
	raw: ReturnType<typeof asConfigShape>,
	_sourceLabel: string,
	_errors: string[]
): Partial<WidgetConfig> | undefined {
	if (!raw.widget || typeof raw.widget !== "object") return undefined;

	const widget = raw.widget as Record<string, unknown>;
	const result: Partial<WidgetConfig> = {};

	if (typeof widget.enabled === "boolean") {
		result.enabled = widget.enabled;
	}
	if (widget.placement === "aboveEditor" || widget.placement === "belowEditor") {
		result.placement = widget.placement;
	}
	if (typeof widget.showCount === "number" && widget.showCount > 0) {
		result.showCount = widget.showCount;
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeAutoRun(
	raw: ReturnType<typeof asConfigShape>,
	_sourceLabel: string,
	_errors: string[]
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
	errors: string[]
): MappingEntry[] {
	if (!raw.mappings) return [];

	const mappings: MappingEntry[] = [];
	for (const rawItem of raw.mappings) {
		const item = rawItem as RawMappingItem;
		if (!item || typeof item !== "object" || !item.usage) {
			errors.push(`[${sourceLabel}] invalid mapping entry: ${JSON.stringify(item)}`);
			continue;
		}

		const usage = item.usage;
		if (typeof usage.provider !== "string") {
			errors.push(`[${sourceLabel}] mapping.usage.provider must be a string`);
			continue;
		}

		if (usage.windowPattern !== undefined && typeof usage.windowPattern === "string") {
			try {
				new RegExp(usage.windowPattern);
			} catch (e) {
				errors.push(`[${sourceLabel}] invalid windowPattern "${usage.windowPattern}": ${e}`);
				continue;
			}
		}

		const model = item.model;
		const ignore = item.ignore === true;

		if (!model && !ignore) {
			continue; // Skip entries without model or ignore
		}

		if (model && (typeof model.provider !== "string" || typeof model.id !== "string")) {
			errors.push(`[${sourceLabel}] mapping.model must have provider and id strings`);
			continue;
		}

		mappings.push({
			usage: {
				provider: usage.provider,
				account: typeof usage.account === "string" ? usage.account : undefined,
				window: typeof usage.window === "string" ? usage.window : undefined,
				windowPattern: typeof usage.windowPattern === "string" ? usage.windowPattern : undefined,
			},
			model: model ? { provider: model.provider as string, id: model.id as string } : undefined,
			ignore,
		});
	}

	return mappings;
}

function mergeMappings(globalMappings: MappingEntry[], projectMappings: MappingEntry[]): MappingEntry[] {
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
	projectWidget: Partial<WidgetConfig> | undefined
): Required<WidgetConfig> {
	return {
		enabled: projectWidget?.enabled ?? globalWidget?.enabled ?? DEFAULT_WIDGET_CONFIG.enabled,
		placement: projectWidget?.placement ?? globalWidget?.placement ?? DEFAULT_WIDGET_CONFIG.placement,
		showCount: projectWidget?.showCount ?? globalWidget?.showCount ?? DEFAULT_WIDGET_CONFIG.showCount,
	};
}

// ============================================================================
// Config Loading
// ============================================================================

export async function loadConfig(
	ctx: ExtensionContext,
	options: { requireMappings?: boolean } = {}
): Promise<LoadedConfig | null> {
	const errors: string[] = [];
	const requireMappings = options.requireMappings ?? true;
	const projectPath = path.join(ctx.cwd, ".pi", "model-selector.json");
	const globalConfigPath = getGlobalConfigPath();

	const globalRaw = (await readConfigFile(globalConfigPath, errors)) ?? { mappings: [] };
	const projectRaw = (await readConfigFile(projectPath, errors)) ?? { mappings: [] };

	const globalConfig = asConfigShape(globalRaw);
	const projectConfig = asConfigShape(projectRaw);

	const globalMappings = normalizeMappings(globalConfig, globalConfigPath, errors);
	const projectMappings = normalizeMappings(projectConfig, projectPath, errors);
	const globalPriority = normalizePriority(globalConfig, globalConfigPath, errors);
	const projectPriority = normalizePriority(projectConfig, projectPath, errors);
	const globalWidget = normalizeWidget(globalConfig, globalConfigPath, errors);
	const projectWidget = normalizeWidget(projectConfig, projectPath, errors);
	const globalAutoRun = normalizeAutoRun(globalConfig, globalConfigPath, errors);
	const projectAutoRun = normalizeAutoRun(projectConfig, projectPath, errors);
	const globalDebugLog = normalizeDebugLog(globalConfig, path.dirname(globalConfigPath));
	const projectDebugLog = normalizeDebugLog(projectConfig, ctx.cwd);
	const globalDisabled = normalizeDisabledProviders(globalConfig, globalConfigPath, errors);
	const projectDisabled = normalizeDisabledProviders(projectConfig, projectPath, errors);

	if (errors.length > 0) {
		notify(ctx, "error", errors.join("\n"));
		return null;
	}

	const mappings = mergeMappings(globalMappings, projectMappings);
	if (requireMappings && mappings.length === 0) {
		notify(
			ctx,
			"error",
			`No model selector mappings found. Add mappings to ${globalConfigPath} or ${projectPath}, or run /model-select-config.`
		);
		return null;
	}

	return {
		mappings,
		priority: projectPriority ?? globalPriority ?? DEFAULT_PRIORITY,
		widget: mergeWidgetConfig(globalWidget, projectWidget),
		autoRun: projectAutoRun ?? globalAutoRun ?? false,
		disabledProviders: [...new Set([...globalDisabled, ...projectDisabled])],
		debugLog: (projectRaw.debugLog ? projectDebugLog : globalDebugLog),
		sources: { globalPath: globalConfigPath, projectPath },
		raw: { global: globalRaw, project: projectRaw },
	};
}

// ============================================================================
// Config Mutation
// ============================================================================

export function upsertMapping(raw: Record<string, any>, mapping: MappingEntry): void {
	const existing = Array.isArray(raw.mappings) ? raw.mappings : [];
	const targetKey = mappingKey(mapping);
	const filtered = existing.filter((entry: any) => {
		const usage = entry?.usage ?? {};
		// Reconstruct a mapping-like object to use mappingKey for consistent comparison
		const entryKey = mappingKey({
			usage: {
				provider: usage.provider ?? "",
				account: usage.account ?? "",
				window: usage.window ?? "",
				windowPattern: usage.windowPattern ?? "",
			},
		} as MappingEntry);
		return entryKey !== targetKey;
	});
	raw.mappings = [...filtered, mapping];
}

export function updateWidgetConfig(raw: Record<string, any>, widgetUpdate: Partial<WidgetConfig>): void {
	const existing = raw.widget && typeof raw.widget === "object" ? raw.widget : {};
	raw.widget = { ...existing, ...widgetUpdate };
}
