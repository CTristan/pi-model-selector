import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { UsageCandidate, LoadedConfig, MappingEntry } from "./types.js";
import { formatReset } from "./usage-fetchers.js";
import { findModelMapping, findIgnoreMapping } from "./candidates.js";

// ============================================================================
// Progress Bar Rendering
// ============================================================================

function renderProgressBar(
	percent: number,
	width: number,
	theme: Theme
): string {
	const clampedPercent = Math.max(0, Math.min(100, percent));
	const filledWidth = Math.round((clampedPercent / 100) * width);
	const emptyWidth = width - filledWidth;

	// Color based on usage level
	let color: "success" | "warning" | "error";
	if (clampedPercent >= 80) {
		color = "error";
	} else if (clampedPercent >= 50) {
		color = "warning";
	} else {
		color = "success";
	}

	const filled = "█".repeat(filledWidth);
	const empty = "░".repeat(emptyWidth);

	return theme.fg(color, filled) + theme.fg("dim", empty);
}

// ============================================================================
// Candidate Formatting
// ============================================================================

function formatCandidate(
	candidate: UsageCandidate,
	mappings: MappingEntry[],
	theme: Theme,
	barWidth: number = 8
): string {
	const mapping = findModelMapping(candidate, mappings);
	const ignored = findIgnoreMapping(candidate, mappings);

	// Status indicator
	let statusIcon: string;
	if (ignored) {
		statusIcon = theme.fg("dim", "○"); // Ignored
	} else if (mapping?.model) {
		statusIcon = theme.fg("success", "●"); // Mapped
	} else {
		statusIcon = theme.fg("warning", "◐"); // Unmapped
	}

	// Provider and window (compact)
	const providerWindow = theme.fg("accent", candidate.displayName) + 
		theme.fg("dim", "/") + 
		candidate.windowLabel;

	// Progress bar
	const bar = renderProgressBar(candidate.usedPercent, barWidth, theme);

	// Percentage (remaining)
	const remainingStr = `${candidate.remainingPercent.toFixed(0)}%`;
	const percentColor = candidate.remainingPercent <= 20 ? "error" : 
		candidate.remainingPercent <= 50 ? "warning" : "success";
	const percentStr = theme.fg(percentColor, remainingStr);

	// Time left
	let resetStr = "";
	if (candidate.resetsAt) {
		resetStr = " " + theme.fg("dim", `(${formatReset(candidate.resetsAt)})`);
	}

	return `${statusIcon} ${providerWindow} ${bar} ${percentStr}${resetStr}`;
}

// ============================================================================
// Widget Rendering
// ============================================================================

export interface WidgetState {
	candidates: UsageCandidate[];
	config: LoadedConfig;
}

let currentWidgetState: WidgetState | null = null;

export function updateWidgetState(state: WidgetState | null): void {
	currentWidgetState = state;
}

export function getWidgetState(): WidgetState | null {
	return currentWidgetState;
}

export function renderUsageWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const ui = ctx.ui as any;
	if (typeof ui?.setWidget !== "function") return;

	const state = currentWidgetState;
	if (!state || !state.config.widget.enabled) {
		// Clear widget if disabled or no state
		ui.setWidget("model-selector", undefined);
		return;
	}

	const { candidates, config } = state;
	const showCount = config.widget.showCount;

	if (candidates.length === 0) {
		ui.setWidget("model-selector", undefined);
		return;
	}

	// Group and consolidate redundant candidates for the widget while preserving ranked order
	const topCandidates: UsageCandidate[] = [];
	const seenModels = new Set<string>();
	const seenBuckets = new Set<string>();

	for (const candidate of candidates) {
		if (topCandidates.length >= showCount) break;

		const mapping = findModelMapping(candidate, config.mappings);
		if (mapping?.model) {
			const modelKey = `${mapping.model.provider}/${mapping.model.id}`;
			if (seenModels.has(modelKey)) continue;
			seenModels.add(modelKey);
		} else {
			const bucketKey = `${candidate.displayName}|${candidate.account || ""}`;
			if (seenBuckets.has(bucketKey)) continue;
			seenBuckets.add(bucketKey);
		}
		topCandidates.push(candidate);
	}

	ui.setWidget(
		"model-selector",
		(_: unknown, theme: Theme) => ({
			render(width: number) {
				const safeWidth = Math.max(1, width);
				const paddingLeft = 1;

				// Compact horizontal format
				const separator = theme.fg("dim", " │ ");
				const barWidth = 6;

				const formattedCandidates = topCandidates.map((c) =>
					formatCandidate(c, config.mappings, theme, barWidth)
				);

				const contentLine = formattedCandidates.join(separator);

				const lines: string[] = [];
				lines.push(theme.fg("dim", "─".repeat(safeWidth)));
				lines.push(truncateToWidth(" ".repeat(paddingLeft) + contentLine, safeWidth));
				lines.push(theme.fg("dim", "─".repeat(safeWidth)));

				return lines;
			},
			invalidate() {},
		}),
		{ placement: config.widget.placement }
	);
}

export function clearWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as any;
	if (typeof ui?.setWidget === "function") {
		ui.setWidget("model-selector", undefined);
	}
	currentWidgetState = null;
}
