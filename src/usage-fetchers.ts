import type { UsageSnapshot } from "./types.js";
import { writeDebugLog } from "./types.js";
import { fetchClaudeUsage } from "./fetchers/anthropic.js";
import { fetchCopilotUsage } from "./fetchers/copilot.js";
import { fetchGeminiUsage } from "./fetchers/gemini.js";
import { fetchAllCodexUsages } from "./fetchers/codex.js";
import { fetchAntigravityUsage } from "./fetchers/antigravity.js";
import { fetchKiroUsage } from "./fetchers/kiro.js";
import { fetchZaiUsage } from "./fetchers/zai.js";
import { loadPiAuth, PROVIDER_DISPLAY_NAMES } from "./fetchers/common.js";

/**
 * Aggregates usage data from all enabled providers.
 */
export async function fetchAllUsages(
  modelRegistry: unknown,
  disabledProviders: string[] = [],
): Promise<UsageSnapshot[]> {
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
      { provider: "zai", fetch: () => fetchZaiUsage(piAuth) },
    ],
    activeFetchers = fetchers.filter((f) => !disabled.has(f.provider)),
    results = await Promise.all(
      activeFetchers.map((f) => timeout(f.fetch(), 30000, f.provider)),
    );

  return results.flat();
}

// Re-export utility functions for backward compatibility if needed,
// though most should now come from ./fetchers/common.js
export {
  formatReset,
  loadPiAuth,
  safeDate,
  refreshGoogleToken,
} from "./fetchers/common.js";
export { fetchClaudeUsage } from "./fetchers/anthropic.js";
export { fetchCopilotUsage } from "./fetchers/copilot.js";
export { fetchGeminiUsage } from "./fetchers/gemini.js";
export { fetchAllCodexUsages } from "./fetchers/codex.js";
export { fetchAntigravityUsage } from "./fetchers/antigravity.js";
export { fetchKiroUsage } from "./fetchers/kiro.js";
export { fetchZaiUsage } from "./fetchers/zai.js";
