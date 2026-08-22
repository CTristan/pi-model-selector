import { getProviderAuthFromRegistry } from "../pi-registry.js";
import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  fetchWithTimeout,
  formatReset,
  PROVIDER_DISPLAY_NAMES,
  safeDate,
  URLS,
} from "./common.js";

interface OpenCodeGoAuth {
  key?: string;
  access?: string;
  apiKey?: string;
}

interface OpenCodeGoUsageWindow {
  status?: string;
  percent?: unknown;
  resetsAt?: string;
}

interface OpenCodeGoUsageResponse {
  usage?: {
    rolling?: OpenCodeGoUsageWindow;
    weekly?: OpenCodeGoUsageWindow;
    monthly?: OpenCodeGoUsageWindow;
  };
}

/**
 * Resolves the OpenCode Go API key from environment variables or Pi auth.json
 * fragments. The endpoint is undocumented, so we accept every historical key
 * field name to stay resilient.
 * @param piAuth The user's Pi authentication configuration.
 * @returns The resolved API key or undefined.
 */
export function resolveOpenCodeGoApiKey(
  piAuth: Record<string, unknown>,
): string | undefined {
  const envKey = process.env.OPENCODE_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return envKey.trim();
  }

  const auth = piAuth["opencode-go"] as OpenCodeGoAuth | undefined;
  for (const candidate of [auth?.key, auth?.access, auth?.apiKey]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

async function resolveOpenCodeGoApiKeyWithRegistry(
  modelRegistry: unknown,
  piAuth: Record<string, unknown>,
): Promise<string | undefined> {
  // 1. Check Pi's public provider auth, which resolves auth.json and env values.
  try {
    const resolvedAuth = await getProviderAuthFromRegistry(
      modelRegistry,
      "opencode-go",
    );
    const registryKey = resolvedAuth?.auth.apiKey?.trim();
    if (registryKey) return registryKey;
  } catch {
    // Continue through compatibility credential sources.
  }

  // 2. Check model registry authStorage (OMP uses SQLite, not auth.json)
  try {
    const mr = modelRegistry as {
      authStorage?: {
        getApiKey?: (
          id: string,
        ) => Promise<string | undefined> | string | undefined;
      };
    };
    const registryKey = await Promise.resolve(
      mr?.authStorage?.getApiKey?.("opencode-go"),
    );
    if (typeof registryKey === "string" && registryKey.trim().length > 0) {
      return registryKey.trim();
    }
  } catch {
    // Auth storage not available, continue to env and piAuth.
  }

  // 3. Check OPENCODE_API_KEY and piAuth fragments.
  return resolveOpenCodeGoApiKey(piAuth);
}

function parseUsageWindow(
  raw: OpenCodeGoUsageWindow | undefined,
  label: string,
): RateWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  // "ok" windows report live quota and "rate-limited" windows report an
  // exhausted one, so both are real data. Unknown future statuses may mean
  // something else, so we skip them because guessing risks hiding a window
  // the user mapped.
  if (raw.status !== "ok" && raw.status !== "rate-limited") return undefined;

  const rawPercent = raw.percent;
  if (typeof rawPercent !== "number" || !Number.isFinite(rawPercent)) {
    return undefined;
  }
  const usedPercent = Math.min(100, Math.max(0, rawPercent));

  const window: RateWindow = { label, usedPercent };
  const resetsAt = safeDate(raw.resetsAt);
  if (resetsAt) {
    window.resetsAt = resetsAt;
    const resetDescription = formatReset(resetsAt);
    if (resetDescription) window.resetDescription = resetDescription;
  }
  return window;
}

/**
 * Fetches the OpenCode Go subscription usage snapshot. The /zen/go/v1/usage
 * endpoint is undocumented, so we treat the schema as subject to change.
 * @param modelRegistry The registry containing authentication storage.
 * @param piAuth The user's Pi authentication configuration.
 * @returns A promise resolving to the usage snapshot.
 */
export async function fetchOpenCodeGoUsage(
  modelRegistry: unknown = {},
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  const provider = "opencode-go",
    displayName = PROVIDER_DISPLAY_NAMES[provider] || "OpenCode Go",
    apiKey = await resolveOpenCodeGoApiKeyWithRegistry(modelRegistry, piAuth);

  if (!apiKey) {
    return {
      provider,
      displayName,
      windows: [],
      error: "No API key",
    };
  }

  try {
    const { res, data } = await fetchWithTimeout(URLS.OPENCODE_GO_USAGE, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 5000,
    });

    if (!res.ok) {
      const statusText = res.statusText?.trim();
      return {
        provider,
        displayName,
        windows: [],
        error: statusText
          ? `HTTP ${res.status} ${statusText}`
          : `HTTP ${res.status}`,
      };
    }

    const json = data as OpenCodeGoUsageResponse | undefined;
    if (!json?.usage || typeof json.usage !== "object") {
      return {
        provider,
        displayName,
        windows: [],
        error: "Invalid response format: missing usage",
      };
    }

    const windows: RateWindow[] = [];
    const rolling = parseUsageWindow(json.usage.rolling, "5-hour");
    if (rolling) windows.push(rolling);
    const weekly = parseUsageWindow(json.usage.weekly, "Weekly");
    if (weekly) windows.push(weekly);
    const monthly = parseUsageWindow(json.usage.monthly, "Monthly");
    if (monthly) windows.push(monthly);

    if (windows.length === 0) {
      return {
        provider,
        displayName,
        windows: [],
        error: "No usable usage windows in response",
      };
    }

    return {
      provider,
      displayName,
      windows,
      plan: "Go",
    };
  } catch (error) {
    return {
      provider,
      displayName,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
