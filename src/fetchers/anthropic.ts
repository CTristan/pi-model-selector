import * as os from "node:os";
import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  execAsync,
  fetchWithTimeout,
  formatReset,
  parseEpochMillis,
  safeDate,
  URLS,
} from "./common.js";

type ClaudeCredential = {
  token: string;
  source: string;
  expiresAt?: number;
};

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

  const expiresAt =
    parseEpochMillis(record.expires) ??
    parseEpochMillis(record.expiresAt) ??
    parseEpochMillis(record.expiry_date);

  const result: ClaudeCredential = { token, source };
  if (expiresAt !== undefined) {
    result.expiresAt = expiresAt;
  }
  return result;
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
    sonnetUtil = dataTyped.seven_day_sonnet?.utilization ?? 0,
    opusUtil = dataTyped.seven_day_opus?.utilization ?? 0,
    globalUtilization = Math.max(
      fiveHourUtil,
      sevenDayUtil,
      sonnetUtil,
      opusUtil,
    ),
    globalResetsAt = [
      { u: fiveHourUtil, r: dataTyped.five_hour?.resets_at },
      { u: sevenDayUtil, r: dataTyped.seven_day?.resets_at },
      { u: sonnetUtil, r: dataTyped.seven_day_sonnet?.resets_at },
      { u: opusUtil, r: dataTyped.seven_day_opus?.resets_at },
    ]
      .filter((c) => c.u === globalUtilization)
      .map((c) => safeDate(c.r))
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0],
    addPessimisticWindow = (
      label: string,
      utilization: number,
      resetsAtStr?: string,
    ) => {
      const finalUtilization = Math.max(globalUtilization, utilization);
      const windowResetsAt = safeDate(resetsAtStr);
      const finalResetsAt =
        globalResetsAt && windowResetsAt
          ? globalResetsAt.getTime() >= windowResetsAt.getTime()
            ? globalResetsAt
            : windowResetsAt
          : (globalResetsAt ?? windowResetsAt);

      const window: RateWindow = {
        label,
        usedPercent: finalUtilization * 100,
      };
      if (finalResetsAt) {
        window.resetDescription = formatReset(finalResetsAt);
        window.resetsAt = finalResetsAt;
      }
      windows.push(window);
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
    const window: RateWindow = {
      label: "5h",
      usedPercent: (dataTyped.five_hour.utilization ?? 0) * 100,
    };
    if (resetsAt) {
      window.resetDescription = formatReset(resetsAt);
      window.resetsAt = resetsAt;
    }
    windows.push(window);
  }

  if (dataTyped.seven_day) {
    const resetsAt = safeDate(dataTyped.seven_day.resets_at);
    const window: RateWindow = {
      label: "Week",
      usedPercent: (dataTyped.seven_day.utilization ?? 0) * 100,
    };
    if (resetsAt) {
      window.resetDescription = formatReset(resetsAt);
      window.resetsAt = resetsAt;
    }
    windows.push(window);
  }

  // If no model-specific windows were found, add a pessimistic "Shared" window
  // that the selector can use as a reliable bottleneck.
  if (!windows.some((w) => w.label === "Sonnet" || w.label === "Opus")) {
    const window: RateWindow = {
      label: "Shared",
      usedPercent: globalUtilization * 100,
    };
    if (globalResetsAt) {
      window.resetDescription = formatReset(globalResetsAt);
      window.resetsAt = globalResetsAt;
    }
    windows.push(window);
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
  modelRegistry?: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  // Backward-compatible argument handling:
  // Previously, callers used fetchClaudeUsage(piAuth). After the signature
  // change to (modelRegistry?, piAuth?), such calls would incorrectly treat
  // the piAuth object as modelRegistry and use an empty piAuth, resulting in
  // missing credentials. Detect when the first argument looks like a piAuth
  // object (has "anthropic") and does not look like a model registry
  // (lacking "authStorage"), and the second argument is empty, and in that
  // case, reinterpret the first argument as piAuth.
  let effectiveModelRegistry: unknown = modelRegistry;
  let effectivePiAuth: Record<string, unknown> = piAuth ?? {};

  if (
    effectiveModelRegistry &&
    typeof effectiveModelRegistry === "object" &&
    !("authStorage" in (effectiveModelRegistry as Record<string, unknown>)) &&
    "anthropic" in (effectiveModelRegistry as Record<string, unknown>) &&
    (effectivePiAuth == null ||
      (typeof effectivePiAuth === "object" &&
        Object.keys(effectivePiAuth).length === 0))
  ) {
    effectivePiAuth = effectiveModelRegistry as Record<string, unknown>;
    effectiveModelRegistry = undefined;
  }

  const credentials = await loadClaudeCredentials(
      effectiveModelRegistry,
      effectivePiAuth,
    ),
    attemptedTokens = new Set<string>();

  const doFetch = (accessToken: string) =>
    fetchWithTimeout(URLS.ANTHROPIC_USAGE, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      timeout: 10000,
    });

  let lastAttemptedSource: string | undefined;
  let lastAuthFailure: { status: number; source: string } | undefined;
  let lastError: { message: string; source: string } | undefined;

  const tryToken = async (
    token: string,
    source: string,
  ): Promise<UsageSnapshot | undefined> => {
    if (attemptedTokens.has(token)) return undefined;
    attemptedTokens.add(token);
    lastAttemptedSource = source;

    try {
      const { res, data } = await doFetch(token);

      if (res.ok) {
        return {
          provider: "anthropic",
          displayName: "Claude",
          windows: buildClaudeWindows(data),
          account: source,
        };
      }

      if (res.status === 401 || res.status === 403) {
        lastAuthFailure = {
          status: res.status,
          source: source,
        };
      } else {
        // For 429, 500, etc., we record it as the last error but continue.
        lastError = {
          message: `HTTP ${res.status}`,
          source: source,
        };
      }
    } catch (err) {
      lastError = {
        message: String(err),
        source: source,
      };
    }

    return undefined;
  };

  try {
    for (const credential of credentials) {
      const result = await tryToken(credential.token, credential.source);
      if (result) return result;
    }

    // Fallback to keychain if nothing worked yet
    const keychainToken = await loadClaudeKeychainToken();
    if (keychainToken) {
      const result = await tryToken(keychainToken, "keychain");
      if (result) return result;
    }

    if (lastError) {
      const snapshot: UsageSnapshot = {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: lastError.message,
      };
      if (lastError.source !== undefined) {
        snapshot.account = lastError.source;
      }
      return snapshot;
    }

    const snapshot: UsageSnapshot = {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: lastAuthFailure
        ? `HTTP ${lastAuthFailure.status}`
        : "No credentials",
    };
    if (lastAuthFailure?.source !== undefined) {
      snapshot.account = lastAuthFailure.source;
    }
    return snapshot;
  } catch (error: unknown) {
    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: String(error),
      account: lastAttemptedSource || "none",
    };
  }
}
