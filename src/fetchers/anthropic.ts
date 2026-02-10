import * as os from "node:os";
import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  execAsync,
  fetchWithTimeout,
  formatReset,
  safeDate,
  URLS,
} from "./common.js";

type ClaudeCredential = {
  token: string;
  source: string;
  expiresAt?: number;
};

function parseEpochMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const parsedDate = Date.parse(value);
    return Number.isNaN(parsedDate) ? undefined : parsedDate;
  }
  return undefined;
}

function extractClaudeCredential(
  data: unknown,
  source: string,
): ClaudeCredential | undefined {
  if (!data || typeof data !== "object") return undefined;

  const record = data as Record<string, unknown>;
  const token =
    typeof record.access === "string"
      ? record.access
      : typeof record.accessToken === "string"
        ? record.accessToken
        : typeof record.token === "string"
          ? record.token
          : undefined;

  if (!token) return undefined;

  return {
    token,
    source,
    expiresAt:
      parseEpochMillis(record.expires) ??
      parseEpochMillis(record.expiresAt) ??
      parseEpochMillis(record.expiry_date),
  };
}

function buildClaudeWindows(data: unknown): RateWindow[] {
  const dataTyped = data as {
      five_hour?: { utilization: number; resets_at?: string };
      seven_day?: { utilization: number; resets_at?: string };
      seven_day_sonnet?: { utilization: number; resets_at?: string };
      seven_day_opus?: { utilization: number; resets_at?: string };
    },
    windows: RateWindow[] = [],
    fiveHourUtil = dataTyped.five_hour?.utilization ?? 0,
    sevenDayUtil = dataTyped.seven_day?.utilization ?? 0,
    globalUtilization = Math.max(fiveHourUtil, sevenDayUtil),
    globalResetsAt = (
      fiveHourUtil > sevenDayUtil
        ? [dataTyped.five_hour?.resets_at]
        : sevenDayUtil > fiveHourUtil
          ? [dataTyped.seven_day?.resets_at]
          : [dataTyped.five_hour?.resets_at, dataTyped.seven_day?.resets_at]
    )
      .map(safeDate)
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0],
    addPessimisticWindow = (
      label: string,
      utilization: number,
      resetsAtStr?: string,
    ) => {
      const finalUtilization = Math.max(globalUtilization, utilization);
      let finalResetsAt = safeDate(resetsAtStr);

      if (globalUtilization > utilization && globalResetsAt) {
        if (!finalResetsAt || globalResetsAt > finalResetsAt) {
          finalResetsAt = globalResetsAt;
        }
      }

      windows.push({
        label,
        usedPercent: finalUtilization * 100,
        resetDescription: finalResetsAt
          ? formatReset(finalResetsAt)
          : undefined,
        resetsAt: finalResetsAt,
      });
    };

  if (dataTyped.seven_day_sonnet?.utilization !== undefined) {
    addPessimisticWindow(
      "Sonnet",
      dataTyped.seven_day_sonnet.utilization,
      dataTyped.seven_day_sonnet.resets_at,
    );
  }

  if (dataTyped.seven_day_opus?.utilization !== undefined) {
    addPessimisticWindow(
      "Opus",
      dataTyped.seven_day_opus.utilization,
      dataTyped.seven_day_opus.resets_at,
    );
  }

  // Always add the raw global windows with their true utilization and reset times
  // to avoid misleading users about the status of these specific windows.
  if (dataTyped.five_hour) {
    const resetsAt = safeDate(dataTyped.five_hour.resets_at);
    windows.push({
      label: "5h",
      usedPercent: (dataTyped.five_hour.utilization ?? 0) * 100,
      resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
      resetsAt,
    });
  }

  if (dataTyped.seven_day) {
    const resetsAt = safeDate(dataTyped.seven_day.resets_at);
    windows.push({
      label: "Week",
      usedPercent: (dataTyped.seven_day.utilization ?? 0) * 100,
      resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
      resetsAt,
    });
  }

  // If no model-specific windows were found, add a pessimistic "Shared" window
  // that the selector can use as a reliable bottleneck.
  if (!windows.some((w) => w.label === "Sonnet" || w.label === "Opus")) {
    windows.push({
      label: "Shared",
      usedPercent: globalUtilization * 100,
      resetDescription: globalResetsAt
        ? formatReset(globalResetsAt)
        : undefined,
      resetsAt: globalResetsAt,
    });
  }

  return windows;
}

async function loadClaudeKeychainToken(): Promise<string | undefined> {
  if (os.platform() !== "darwin") return undefined;
  try {
    const { stdout } = await execAsync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", timeout: 5000 },
      ),
      keychainData = stdout.trim();

    if (!keychainData) return undefined;

    // Most installations store a JSON payload, but some may store the token directly.
    if (keychainData.startsWith("{")) {
      const parsed = JSON.parse(keychainData) as {
          claudeAiOauth?: {
            scopes?: string[];
            accessToken?: string;
          };
        },
        scopes = parsed.claudeAiOauth?.scopes || [];
      if (
        scopes.includes("user:profile") &&
        parsed.claudeAiOauth?.accessToken
      ) {
        return parsed.claudeAiOauth.accessToken;
      }
      return undefined;
    }

    return keychainData;
  } catch {
    // Keychain might not be available or entry missing.
    return undefined;
  }
}

async function loadClaudeCredentials(
  modelRegistry: unknown,
  piAuth: Record<string, unknown>,
): Promise<ClaudeCredential[]> {
  const credentials: ClaudeCredential[] = [],
    seenTokens = new Set<string>(),
    addCredential = (credential: ClaudeCredential | undefined) => {
      if (!credential?.token || seenTokens.has(credential.token)) return;
      seenTokens.add(credential.token);
      credentials.push(credential);
    };

  try {
    const mr = modelRegistry as {
      authStorage?: {
        getApiKey?: (
          id: string,
        ) => Promise<string | undefined> | string | undefined;
        get?: (
          id: string,
        ) =>
          | Promise<Record<string, unknown> | undefined>
          | Record<string, unknown>
          | undefined;
      };
    };

    const registryApiKey = await Promise.resolve(
      mr?.authStorage?.getApiKey?.("anthropic"),
    );
    addCredential(
      registryApiKey
        ? {
            token: registryApiKey,
            source: "registry:anthropic:apiKey",
          }
        : undefined,
    );

    const registryData = await Promise.resolve(
      mr?.authStorage?.get?.("anthropic"),
    );
    addCredential(
      extractClaudeCredential(registryData, "registry:anthropic:data"),
    );
  } catch {
    // Ignore registry access errors.
  }

  addCredential(extractClaudeCredential(piAuth.anthropic, "auth.json"));

  const now = Date.now();
  return credentials.sort((a, b) => {
    const aExpired = (a.expiresAt ?? Number.MAX_SAFE_INTEGER) <= now;
    const bExpired = (b.expiresAt ?? Number.MAX_SAFE_INTEGER) <= now;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return 0;
  });
}

export async function fetchClaudeUsage(
  piAuth: Record<string, unknown> = {},
  modelRegistry?: unknown,
): Promise<UsageSnapshot> {
  const credentials = await loadClaudeCredentials(modelRegistry, piAuth),
    attemptedTokens = new Set<string>();

  if (credentials.length === 0) {
    const keychainToken = await loadClaudeKeychainToken();
    if (keychainToken) {
      credentials.push({ token: keychainToken, source: "keychain" });
    }
  }

  if (credentials.length === 0) {
    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "No credentials",
    };
  }

  const doFetch = (accessToken: string) =>
    fetchWithTimeout(URLS.ANTHROPIC_USAGE, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      timeout: 10000,
    });

  try {
    let lastAuthFailure: { status: number; source: string } | undefined;

    for (const credential of credentials) {
      if (attemptedTokens.has(credential.token)) continue;
      attemptedTokens.add(credential.token);

      const { res, data } = await doFetch(credential.token);

      if (res.ok) {
        return {
          provider: "anthropic",
          displayName: "Claude",
          windows: buildClaudeWindows(data),
          account: credential.source,
        };
      }

      if (res.status === 401 || res.status === 403) {
        lastAuthFailure = {
          status: res.status,
          source: credential.source,
        };
        continue;
      }

      return {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: `HTTP ${res.status}`,
        account: credential.source,
      };
    }

    const keychainToken = await loadClaudeKeychainToken();
    if (keychainToken && !attemptedTokens.has(keychainToken)) {
      const { res, data } = await doFetch(keychainToken);
      if (res.ok) {
        return {
          provider: "anthropic",
          displayName: "Claude",
          windows: buildClaudeWindows(data),
          account: "keychain",
        };
      }

      if (res.status === 401 || res.status === 403) {
        lastAuthFailure = {
          status: res.status,
          source: "keychain",
        };
      } else {
        return {
          provider: "anthropic",
          displayName: "Claude",
          windows: [],
          error: `HTTP ${res.status}`,
          account: "keychain",
        };
      }
    }

    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: lastAuthFailure
        ? `HTTP ${lastAuthFailure.status}`
        : "No credentials",
      account: lastAuthFailure?.source,
    };
  } catch (error: unknown) {
    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: String(error),
    };
  }
}
