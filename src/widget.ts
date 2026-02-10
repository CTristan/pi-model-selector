import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { LoadedConfig, MappingEntry, UsageCandidate } from "./types.js";
import { formatReset } from "./usage-fetchers.js";
import { findIgnoreMapping, findModelMapping } from "./candidates.js";

// ============================================================================
// Progress Bar Rendering
// ============================================================================

function renderProgressBar(
  percent: number,
  width: number,
  theme: Theme,
): string {
  const clampedPercent = Math.max(0, Math.min(100, percent)),
    filledWidth = Math.round((clampedPercent / 100) * width),
    emptyWidth = width - filledWidth;

  // Color based on usage level
  let color: "success" | "warning" | "error";
  if (clampedPercent >= 80) {
    color = "error";
  } else if (clampedPercent >= 50) {
    color = "warning";
  } else {
    color = "success";
  }

  const filled = "█".repeat(filledWidth),
    empty = "░".repeat(emptyWidth);

  return theme.fg(color, filled) + theme.fg("dim", empty);
}

// ============================================================================
// Candidate Formatting
// ============================================================================

function formatCandidate(
  candidate: UsageCandidate,
  mappings: MappingEntry[],
  theme: Theme,
  barWidth: number = 8,
): string {
  const mapping = findModelMapping(candidate, mappings),
    ignored = findIgnoreMapping(candidate, mappings);

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
  const providerWindow =
      theme.fg("accent", candidate.displayName) +
      theme.fg("dim", "/") +
      candidate.windowLabel,
    // Progress bar
    bar = renderProgressBar(candidate.usedPercent, barWidth, theme),
    // Percentage (remaining)
    remainingStr = `${candidate.remainingPercent.toFixed(0)}%`,
    percentColor =
      candidate.remainingPercent <= 20
        ? "error"
        : candidate.remainingPercent <= 50
          ? "warning"
          : "success",
    percentStr = theme.fg(percentColor, remainingStr);

  // Time left
  let resetStr = "";
  if (candidate.resetsAt) {
    resetStr = ` ${theme.fg("dim", `(${formatReset(candidate.resetsAt)})`)}`;
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

  const ui = ctx.ui as {
    setWidget?: (
      id: string,
      component: unknown,
      options?: { placement: string },
    ) => void;
  };
  if (typeof ui?.setWidget !== "function") return;

  const state = currentWidgetState;
  if (!state || !state.config.widget.enabled) {
    // Clear widget if disabled or no state
    ui.setWidget("model-selector", undefined);
    return;
  }

  const { candidates, config } = state,
    { showCount } = config.widget;

  if (candidates.length === 0) {
    ui.setWidget("model-selector", undefined);
    return;
  }

  // Group and consolidate redundant candidates for the widget while preserving ranked order
  const topCandidates: UsageCandidate[] = [],
    seenModels = new Set<string>(),
    seenBuckets = new Set<string>();

  for (const candidate of candidates) {
    if (topCandidates.length >= showCount) break;

    const mapping = findModelMapping(candidate, config.mappings);
    if (mapping?.model) {
      const modelKey = `${mapping.model.provider}/${mapping.model.id}`;
      if (seenModels.has(modelKey)) continue;
      seenModels.add(modelKey);
    } else {
      const bucketKey = `${candidate.provider}|${candidate.displayName}|${candidate.account || ""}`;
      if (seenBuckets.has(bucketKey)) continue;
      seenBuckets.add(bucketKey);
    }
    topCandidates.push(candidate);
  }

  ui.setWidget(
    "model-selector",
    (_: unknown, theme: Theme) => ({
      render(width: number) {
        const safeWidth = Math.max(1, width),
          paddingLeft = 1,
          // Compact horizontal format
          separator = theme.fg("dim", " │ "),
          barWidth = 6,
          formattedCandidates = topCandidates.map((c) =>
            formatCandidate(c, config.mappings, theme, barWidth),
          ),
          contentLine = formattedCandidates.join(separator),
          lines: string[] = [];
        lines.push(theme.fg("dim", "─".repeat(safeWidth)));
        lines.push(
          truncateToWidth(" ".repeat(paddingLeft) + contentLine, safeWidth),
        );
        lines.push(theme.fg("dim", "─".repeat(safeWidth)));

        return lines;
      },
      invalidate() {},
    }),
    { placement: config.widget.placement },
  );
}

export function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const ui = ctx.ui as {
    setWidget?: (id: string, component: undefined) => void;
  };
  if (typeof ui?.setWidget === "function") {
    ui.setWidget("model-selector", undefined);
  }
  currentWidgetState = null;
}
