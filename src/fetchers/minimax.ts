import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  fetchWithTimeout,
  formatReset,
  PROVIDER_DISPLAY_NAMES,
  safeDate,
  URLS,
} from "./common.js";

interface MinimaxAuth {
  type?: string;
  key?: string;
  access?: string;
}

interface MinimaxModelRemain {
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  model_name: string;
}

interface MinimaxResponse {
  model_remains?: MinimaxModelRemain[];
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

export function resolveMinimaxApiKey(
  piAuth: Record<string, unknown>,
): string | undefined {
  if (process.env.MINIMAX_API_KEY) {
    return process.env.MINIMAX_API_KEY;
  }
  const auth = piAuth.minimax as MinimaxAuth | undefined;
  if (!auth) return undefined;
  if (typeof auth.key === "string" && auth.key) return auth.key;
  if (typeof auth.access === "string" && auth.access) return auth.access;
  return undefined;
}

export function resolveMinimaxGroupId(
  configGroupId?: string,
): string | undefined {
  if (process.env.MINIMAX_GROUP_ID) {
    return process.env.MINIMAX_GROUP_ID;
  }
  return configGroupId;
}

export async function fetchMinimaxUsage(
  piAuth: Record<string, unknown>,
  configGroupId?: string,
): Promise<UsageSnapshot> {
  const provider = "minimax",
    displayName = PROVIDER_DISPLAY_NAMES[provider] || "Minimax",
    apiKey = resolveMinimaxApiKey(piAuth),
    groupId = resolveMinimaxGroupId(configGroupId);

  if (!apiKey) {
    const snapshot: UsageSnapshot = {
      provider,
      displayName,
      windows: [],
      error: "No API key found in MINIMAX_API_KEY or piAuth.",
    };
    return snapshot;
  }

  if (!groupId) {
    const snapshot: UsageSnapshot = {
      provider,
      displayName,
      windows: [],
      error:
        "No GroupId found. Configure MINIMAX_GROUP_ID or providerSettings.minimax.groupId.",
    };
    return snapshot;
  }

  try {
    const url = new URL(URLS.MINIMAX_CODING_PLAN);
    url.searchParams.set("GroupId", groupId);

    const { res, data } = await fetchWithTimeout(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const snapshot: UsageSnapshot = {
        provider,
        displayName,
        windows: [],
        error: `HTTP ${res.status} ${res.statusText || ""}`,
      };
      return snapshot;
    }

    const json = data as MinimaxResponse | undefined;
    if (!json?.base_resp || json.base_resp.status_code !== 0) {
      const msg = json?.base_resp?.status_msg || "Unknown error";
      const code = String(json?.base_resp?.status_code || "Unknown code");
      const snapshot: UsageSnapshot = {
        provider,
        displayName,
        windows: [],
        error: `API Error: ${msg} (code: ${code})`,
      };
      return snapshot;
    }

    if (!json.model_remains || !Array.isArray(json.model_remains)) {
      const snapshot: UsageSnapshot = {
        provider,
        displayName,
        windows: [],
        error: "Invalid response format: missing model_remains",
      };
      return snapshot;
    }

    const windows: RateWindow[] = [];

    for (const remain of json.model_remains) {
      if (!remain.model_name) continue;

      const total = remain.current_interval_total_count || 0;
      const usage = remain.current_interval_usage_count || 0;
      let usedPercent = 0;
      if (total > 0) {
        usedPercent = Math.min(100, Math.max(0, (usage / total) * 100));
      }

      const resetsAt = safeDate(remain.end_time);
      const resetDescription = resetsAt ? formatReset(resetsAt) : undefined;

      const window: RateWindow = {
        label: remain.model_name,
        usedPercent,
      };
      if (resetsAt) window.resetsAt = resetsAt;
      if (resetDescription) window.resetDescription = resetDescription;

      windows.push(window);
    }

    const snapshot: UsageSnapshot = {
      provider,
      displayName,
      windows,
      plan: "Coding Plan",
    };
    return snapshot;
  } catch (error) {
    const snapshot: UsageSnapshot = {
      provider,
      displayName,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
    return snapshot;
  }
}
