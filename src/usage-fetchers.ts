import { isOmp } from "./adapter.js";
import { fetchClaudeUsage } from "./fetchers/anthropic.js";
import { fetchAntigravityUsage } from "./fetchers/antigravity.js";
import { fetchAllCodexUsages } from "./fetchers/codex.js";
import {
  formatReset,
  loadPiAuth,
  PROVIDER_DISPLAY_NAMES,
} from "./fetchers/common.js";
import { fetchCopilotUsage } from "./fetchers/copilot.js";
import { fetchGeminiUsage } from "./fetchers/gemini.js";
import { fetchKiroUsage } from "./fetchers/kiro.js";
import { fetchMinimaxUsage } from "./fetchers/minimax.js";
import { fetchZaiUsage } from "./fetchers/zai.js";
import type { ProviderSettings, UsageSnapshot } from "./types.js";
import { writeDebugLog } from "./types.js";

// ============================================================================
// OMP Provider Name Normalization
// ============================================================================

/** Maps OMP provider IDs to extension provider names. */
const OMP_PROVIDER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  "github-copilot": "copilot",
  "google-gemini-cli": "gemini",
  "openai-codex": "codex",
  "google-antigravity": "antigravity",
  zai: "zai",
  "minimax-code": "minimax",
  "kimi-code": "kimi",
};

// ============================================================================
// OMP Usage Report Conversion
// ============================================================================

/**
 * Structural types for OMP UsageReport data (typed inline to avoid hard
 * dependency on @oh-my-pi/pi-ai). These match the interfaces defined in
 * pi-ai/src/usage.ts and the provider implementations.
 */
interface OmpUsageWindow {
  id?: string;
  label?: string;
  durationMs?: number;
  resetsAt?: number;
}

interface OmpUsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit?: string;
}

interface OmpUsageScope {
  provider?: string;
  accountId?: string;
  tier?: string;
  windowId?: string;
  modelId?: string;
  shared?: boolean;
}

interface OmpUsageLimit {
  id: string;
  label: string;
  scope?: OmpUsageScope;
  window?: OmpUsageWindow;
  amount: OmpUsageAmount;
  notes?: string[];
}

interface OmpUsageReport {
  provider: string;
  fetchedAt: number;
  limits: OmpUsageLimit[];
  metadata?: Record<string, unknown>;
}

/**
 * Converts OMP UsageReport[] to extension UsageSnapshot[].
 * Normalizes provider names and extracts account info from report metadata.
 */
export function convertOmpUsageReports(
  reports: OmpUsageReport[],
): UsageSnapshot[] {
  // Group limits by normalized provider + account
  const groups = new Map<
    string,
    {
      provider: string;
      displayName: string;
      account?: string;
      limits: OmpUsageLimit[];
    }
  >();

  for (const report of reports) {
    const provider = OMP_PROVIDER_MAP[report.provider] ?? report.provider;
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    // Extract account identifier from metadata
    const account =
      (report.metadata?.email as string) ??
      (report.metadata?.accountId as string) ??
      (report.metadata?.account as string) ??
      (report.metadata?.username as string) ??
      report.limits[0]?.scope?.accountId;

    const key = `${provider}|${account ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider, displayName, account, limits: [] };
      groups.set(key, group);
    }
    group.limits.push(...report.limits);
  }

  const snapshots: UsageSnapshot[] = [];

  for (const [, group] of groups) {
    const windows = convertLimitsToWindows(group.limits, group.provider);
    const snapshot: UsageSnapshot = {
      provider: group.provider,
      displayName: group.displayName,
      windows,
    };
    if (group.account !== undefined) {
      snapshot.account = group.account;
    }
    snapshots.push(snapshot);
  }

  return snapshots;
}

/**
 * Converts OMP UsageLimit[] to extension RateWindow[].
 * Extracts usedPercent and reset time from each limit entry.
 */
function convertLimitsToWindows(
  limits: OmpUsageLimit[],
  _provider: string,
): UsageSnapshot["windows"] {
  const windows: UsageSnapshot["windows"] = [];

  for (const limit of limits) {
    const usedPercent =
      limit.amount.usedFraction !== undefined
        ? limit.amount.usedFraction * 100
        : limit.amount.used;

    if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;

    const window: UsageSnapshot["windows"][number] = {
      label: limit.label,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
    };

    if (
      limit.window?.resetsAt !== undefined &&
      Number.isFinite(limit.window.resetsAt)
    ) {
      const resetsAtDate = new Date(limit.window.resetsAt);
      if (!Number.isNaN(resetsAtDate.getTime())) {
        window.resetsAt = resetsAtDate;
        window.resetDescription = formatReset(resetsAtDate);
      }
    }

    windows.push(window);
  }

  return windows;
}

// ============================================================================
// OMP Usage Fetch Orchestration
// ============================================================================

/**
 * Fetches usage via OMP's built-in AuthStorage.fetchUsageReports().
 * Falls back to the extension's own fetchers for providers OMP doesn't cover.
 */
async function fetchOmpUsages(
  authStorage: {
    fetchUsageReports?: (options?: {
      baseUrlResolver?: (provider: string) => string | undefined;
    }) => Promise<OmpUsageReport[] | null>;
  },
  disabledProviders: string[] = [],
): Promise<UsageSnapshot[]> {
  writeDebugLog("Fetching usage via OMP authStorage.fetchUsageReports()");

  const disabled = new Set(disabledProviders.map((p) => p.toLowerCase()));
  let ompSnapshots: UsageSnapshot[] = [];

  try {
    const reports = await authStorage.fetchUsageReports?.();
    if (reports && reports.length > 0) {
      ompSnapshots = convertOmpUsageReports(reports);
      writeDebugLog(
        `OMP returned ${reports.length} reports -> ${ompSnapshots.length} snapshots`,
      );
    }
  } catch (err) {
    writeDebugLog(`OMP fetchUsageReports failed: ${String(err)}`);
  }

  // Filter out disabled providers from OMP results
  ompSnapshots = ompSnapshots.filter((s) => !disabled.has(s.provider));

  // Determine which providers OMP covered
  const ompCoveredProviders = new Set(ompSnapshots.map((s) => s.provider));

  // Collect fallback fetchers for providers OMP didn't cover
  // (e.g. kiro uses CLI subprocess, which OMP doesn't have)
  const fallbackFetchers: {
    provider: string;
    fetch: () => Promise<UsageSnapshot | UsageSnapshot[]>;
  }[] = [];

  // Kiro: not covered by OMP, always use extension fetcher if not disabled
  if (!disabled.has("kiro") && !ompCoveredProviders.has("kiro")) {
    fallbackFetchers.push({
      provider: "kiro",
      fetch: () => fetchKiroUsage(),
    });
  }

  // Run fallback fetchers with timeout
  if (fallbackFetchers.length > 0) {
    const results = await Promise.all(
      fallbackFetchers.map((f) => {
        const displayName = PROVIDER_DISPLAY_NAMES[f.provider] || f.provider;
        const getFallback = (error: string): UsageSnapshot => ({
          provider: f.provider,
          displayName,
          windows: [],
          error,
        });

        let timer: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<UsageSnapshot>((resolve) => {
          timer = setTimeout(() => resolve(getFallback("Timeout")), 30000);
        });
        const safePromise = f.fetch().catch((err) => {
          writeDebugLog(
            `Fallback fetcher error (${f.provider}): ${String(err)}`,
          );
          return getFallback(String(err));
        });

        // Handle fetchers that return arrays (e.g. codex returns UsageSnapshot[])
        const normalizedPromise = safePromise.then((result) =>
          Array.isArray(result)
            ? (result[0] ?? getFallback("Empty result"))
            : result,
        );

        return Promise.race([normalizedPromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      }),
    );
    ompSnapshots.push(...results);
  }

  return ompSnapshots;
}

// ============================================================================
// Main Fetch Entry Point
// ============================================================================

/**
 * Aggregates usage data from all enabled providers.
 * When running under OMP, delegates to authStorage.fetchUsageReports().
 * Falls back to extension-managed HTTP fetchers for legacy Pi.
 */
export async function fetchAllUsages(
  modelRegistry: unknown,
  disabledProviders: string[] = [],
  providerSettings?: ProviderSettings,
): Promise<UsageSnapshot[]> {
  // OMP path: use built-in usage reports
  if (isOmp) {
    const mr = modelRegistry as {
      authStorage?: {
        fetchUsageReports?: (options?: {
          baseUrlResolver?: (provider: string) => string | undefined;
        }) => Promise<OmpUsageReport[] | null>;
      };
    };
    if (mr?.authStorage?.fetchUsageReports) {
      return fetchOmpUsages(mr.authStorage, disabledProviders);
    }
    writeDebugLog(
      "OMP detected but authStorage.fetchUsageReports unavailable, falling back to extension fetchers",
    );
  }

  // Legacy Pi path: extension-managed HTTP fetchers
  const disabled = new Set(disabledProviders.map((p) => p.toLowerCase())),
    piAuth = await loadPiAuth(),
    timeout = <T extends UsageSnapshot | UsageSnapshot[]>(
      promise: Promise<T>,
      ms: number,
      provider: string,
    ) => {
      let timer: ReturnType<typeof setTimeout>;
      const displayName = PROVIDER_DISPLAY_NAMES[provider] || provider;
      const getFallback = (error: string): T => {
        const snapshot: UsageSnapshot = {
          provider,
          displayName,
          windows: [],
          error,
        };
        return (["codex", "copilot", "gemini"].includes(provider)
          ? [snapshot]
          : snapshot) as unknown as T;
      };

      const timeoutPromise = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(getFallback("Timeout")), ms);
      });

      const safePromise = promise.catch((err) => {
        writeDebugLog(`Fetcher error (${provider}): ${String(err)}`);
        return getFallback(String(err));
      });

      return Promise.race([safePromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    },
    fetchers: {
      provider: string;
      fetch: () => Promise<UsageSnapshot | UsageSnapshot[]>;
    }[] = [
      {
        provider: "anthropic",
        fetch: () => fetchClaudeUsage(modelRegistry, piAuth),
      },
      {
        provider: "copilot",
        fetch: () => fetchCopilotUsage(modelRegistry, piAuth),
      },
      {
        provider: "gemini",
        fetch: () => fetchGeminiUsage(modelRegistry, piAuth),
      },
      {
        provider: "codex",
        fetch: () => fetchAllCodexUsages(modelRegistry, piAuth),
      },
      {
        provider: "antigravity",
        fetch: () => fetchAntigravityUsage(modelRegistry, piAuth),
      },
      { provider: "kiro", fetch: () => fetchKiroUsage() },
      { provider: "zai", fetch: () => fetchZaiUsage(modelRegistry, piAuth) },
      {
        provider: "minimax",
        fetch: () =>
          fetchMinimaxUsage(piAuth, providerSettings?.minimax?.groupId),
      },
    ],
    activeFetchers = fetchers.filter((f) => !disabled.has(f.provider)),
    results = await Promise.all(
      activeFetchers.map((f) => timeout(f.fetch(), 30000, f.provider)),
    );

  return results.flat();
}

export { fetchClaudeUsage } from "./fetchers/anthropic.js";
export { fetchAntigravityUsage } from "./fetchers/antigravity.js";
export { fetchAllCodexUsages } from "./fetchers/codex.js";
// Re-export utility functions for backward compatibility if needed,
// though most should now come from ./fetchers/common.js
export {
  formatReset,
  loadPiAuth,
  refreshGoogleToken,
  safeDate,
} from "./fetchers/common.js";
export { fetchCopilotUsage } from "./fetchers/copilot.js";
export { fetchGeminiUsage } from "./fetchers/gemini.js";
export { fetchKiroUsage } from "./fetchers/kiro.js";
export { fetchMinimaxUsage } from "./fetchers/minimax.js";
export { fetchZaiUsage } from "./fetchers/zai.js";
