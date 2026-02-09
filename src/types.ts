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
}

export interface UsageMappingKey {
	provider: string;
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
}

export interface LoadedConfig {
	mappings: MappingEntry[];
	priority: PriorityRule[];
	widget: Required<WidgetConfig>;
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

export function setGlobalConfig(config: LoadedConfig | undefined): void {
	currentConfig = config;
}

export function writeDebugLog(message: string): void {
	if (!currentConfig?.debugLog?.enabled) return;
	try {
		const fs = require("node:fs");
		const timestamp = new Date().toISOString();
		fs.appendFileSync(currentConfig.debugLog.path, `[${timestamp}] ${message}\n`);
	} catch {}
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
	return `${entry.usage.provider}|${entry.usage.window ?? ""}|${entry.usage.windowPattern ?? ""}`;
}

export const DEFAULT_PRIORITY: PriorityRule[] = ["fullAvailability", "remainingPercent", "earliestReset"];

export const DEFAULT_WIDGET_CONFIG: Required<WidgetConfig> = {
	enabled: true,
	placement: "belowEditor",
	showCount: 3,
};
