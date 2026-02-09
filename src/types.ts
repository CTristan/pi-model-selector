import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

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
}

export type PriorityRule = "fullAvailability" | "remainingPercent" | "earliestReset";

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
}

export interface LoadedConfig {
	mappings: MappingEntry[];
	priority: PriorityRule[];
	widget: Required<WidgetConfig>;
	autoRun: boolean;
	disabledProviders: string[];
	debugLog?: {
		enabled: boolean;
		path: string;
	};
	sources: { globalPath: string; projectPath: string };
	raw: { global: Record<string, any>; project: Record<string, any> };
}

export const ALL_PROVIDERS = ["anthropic", "copilot", "gemini", "codex", "antigravity", "kiro", "zai"] as const;
export type ProviderName = typeof ALL_PROVIDERS[number];

// ============================================================================
// Utility Functions
// ============================================================================

let currentConfig: LoadedConfig | undefined;
let isWriting = false;
const logQueue: string[] = [];

export function setGlobalConfig(config: LoadedConfig | undefined): void {
	currentConfig = config;
}

function processLogQueue(): void {
	if (isWriting || logQueue.length === 0 || !currentConfig?.debugLog?.path) {
		return;
	}

	isWriting = true;
	const batch = logQueue.join("");
	logQueue.length = 0;

	const logPath = currentConfig.debugLog.path;
	const logDir = path.dirname(logPath);

	fs.mkdir(logDir, { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			isWriting = false;
			console.error(`[model-selector] Failed to create log directory ${logDir}: ${mkdirErr}`);
			if (currentConfig?.debugLog) {
				currentConfig.debugLog.enabled = false;
			}
			return;
		}

		fs.appendFile(logPath, batch, (err) => {
			isWriting = false;
			if (err) {
				console.error(`[model-selector] Failed to write to debug log ${logPath}: ${err}`);
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
	} catch (error) {
		console.error(`[model-selector] Unexpected error in writeDebugLog: ${error}`);
	}
}

export function notify(
	ctx: ExtensionContext,
	level: "info" | "warning" | "error",
	message: string
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
	return `${entry.usage.provider}|${entry.usage.account ?? ""}|${entry.usage.window ?? ""}|${entry.usage.windowPattern ?? ""}`;
}

export const DEFAULT_PRIORITY: PriorityRule[] = ["fullAvailability", "remainingPercent", "earliestReset"];

export const DEFAULT_WIDGET_CONFIG: Required<WidgetConfig> = {
	enabled: true,
	placement: "belowEditor",
	showCount: 3,
};
