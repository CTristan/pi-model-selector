import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RateWindow, UsageSnapshot } from "./types.js";
import { writeDebugLog } from "./types.js";

const execAsync = promisify(exec);

// ============================================================================
// Utility Functions
// ============================================================================

export async function loadPiAuth(): Promise<Record<string, unknown>> {
  const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    const data = await fs.promises.readFile(piAuthPath, "utf-8");
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function safeDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value as string | number | Date);
  return isNaN(d.getTime()) ? undefined : d;
}

export function formatReset(date: Date): string {
  if (isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60),
    mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24),
    remainingHours = hours % 24;
  if (days < 7)
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return "";
  }
}

// ============================================================================
// Claude Usage
// ============================================================================

async function loadClaudeKeychainToken(): Promise<string | undefined> {
  if (os.platform() !== "darwin") return undefined;
  try {
    const { stdout } = await execAsync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", timeout: 5000 },
      ),
      keychainData = stdout.trim();
    if (keychainData) {
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
    }
  } catch {
    // Keychain might not be available or entry missing
  }
  return undefined;
}

export async function fetchClaudeUsage(
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  let token = (
      piAuth.anthropic as Record<string, string | undefined> | undefined
    )?.access,
    source = "auth.json";

  if (!token) {
    token = await loadClaudeKeychainToken();
    source = "keychain";
  }

  if (!token) {
    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "No credentials",
    };
  }

  const doFetch = async (accessToken: string) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await doFetch(token);

    if ((res.status === 401 || res.status === 403) && source === "auth.json") {
      const keychainToken = await loadClaudeKeychainToken();
      if (keychainToken && keychainToken !== token) {
        token = keychainToken;
        source = "keychain";
        res = await doFetch(token);
      }
    }

    if (!res.ok) {
      return {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: `HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
        five_hour?: { utilization: number; resets_at?: string };
        seven_day?: { utilization: number; resets_at?: string };
        seven_day_sonnet?: { utilization: number; resets_at?: string };
        seven_day_opus?: { utilization: number; resets_at?: string };
      },
      windows: RateWindow[] = [],
      globalUtilization = Math.max(
        data.five_hour?.utilization ?? 0,
        data.seven_day?.utilization ?? 0,
      ),
      globalResetsAt = [data.five_hour?.resets_at, data.seven_day?.resets_at]
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

    if (data.seven_day_sonnet?.utilization !== undefined) {
      addPessimisticWindow(
        "Sonnet",
        data.seven_day_sonnet.utilization,
        data.seven_day_sonnet.resets_at,
      );
    }

    if (data.seven_day_opus?.utilization !== undefined) {
      addPessimisticWindow(
        "Opus",
        data.seven_day_opus.utilization,
        data.seven_day_opus.resets_at,
      );
    }

    if (windows.length === 0 && globalUtilization > 0) {
      const label =
        (data.five_hour?.utilization ?? 0) >= (data.seven_day?.utilization ?? 0)
          ? "5h"
          : "Week";
      windows.push({
        label,
        usedPercent: globalUtilization * 100,
        resetDescription: globalResetsAt
          ? formatReset(globalResetsAt)
          : undefined,
        resetsAt: globalResetsAt,
      });
    }

    return {
      provider: "anthropic",
      displayName: "Claude",
      windows,
      account: source,
    };
  } catch (error: unknown) {
    return {
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: String(error),
      account: source,
    };
  }
}

// ============================================================================
// Copilot Usage
// ============================================================================

export async function fetchCopilotUsage(
  modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  try {
    writeDebugLog("fetchCopilotUsage: starting token discovery");

    const mr = modelRegistry as {
      authStorage?: {
        getApiKey?: (id: string) => Promise<string | undefined>;
        get?: (id: string) => Promise<unknown>;
      };
    };

    interface TokenInfo {
      token: string;
      source: string;
      isCopilotToken: boolean;
    }

    const tokens: TokenInfo[] = [],
      addToken = (token: unknown, source: string) => {
        if (typeof token !== "string" || !token) return;
        if (tokens.some((t) => t.token === token)) return;
        tokens.push({
          token,
          source,
          isCopilotToken: token.startsWith("tid="),
        });
        writeDebugLog(`fetchCopilotUsage: added token from ${source}`);
      },
      extractFromData = (data: unknown, source: string) => {
        if (!data || typeof data !== "object") return;
        const d = data as Record<string, string | undefined>;
        addToken(
          d.access || d.accessToken || d.access_token,
          `${source}.access`,
        );
        addToken(d.token, `${source}.token`);
      };

    // 1. Discovery
    try {
      const gcpKey = await Promise.resolve(
        mr.authStorage?.getApiKey?.("github-copilot"),
      );
      addToken(gcpKey, "registry:github-copilot:apiKey");

      const gcpData = await Promise.resolve(
        mr.authStorage?.get?.("github-copilot"),
      );
      extractFromData(gcpData, "registry:github-copilot:data");

      const ghKey = await Promise.resolve(
        mr.authStorage?.getApiKey?.("github"),
      );
      addToken(ghKey, "registry:github:apiKey");

      const ghData = await Promise.resolve(mr.authStorage?.get?.("github"));
      extractFromData(ghData, "registry:github:data");
    } catch (e: unknown) {
      writeDebugLog(`fetchCopilotUsage: registry error: ${String(e)}`);
    }

    const copilotAuth = piAuth["github-copilot"] as
      | Record<string, string | undefined>
      | undefined;
    if (copilotAuth?.access) {
      addToken(copilotAuth.access, "auth.json");
    }

    try {
      const { stdout } = await execAsync("gh auth token", {
        encoding: "utf-8",
        timeout: 5000,
      });
      if (stdout.trim()) addToken(stdout.trim(), "gh-cli");
    } catch {
      // Gh cli might not be installed or authenticated
    }

    if (tokens.length === 0) {
      writeDebugLog("fetchCopilotUsage: no tokens found");
      return {
        provider: "copilot",
        displayName: "Copilot",
        windows: [],
        error: "No token found",
        account: "none",
      };
    }

    const headersBase = {
        "Editor-Version": "vscode/1.97.0",
        "Editor-Plugin-Version": "copilot/1.160.0",
        "User-Agent": "GitHubCopilot/1.160.0",
        Accept: "application/json",
      },
      tryFetch = async (authHeader: string) => {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 5000);
        try {
          return await fetch("https://api.github.com/copilot_internal/user", {
            headers: { ...headersBase, Authorization: authHeader },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      },
      tryExchange = async (
        githubToken: string,
      ): Promise<{ token: string; sku?: string } | null> => {
        writeDebugLog(
          `fetchCopilotUsage: attempting exchange for token from ${tokens.find((t) => t.token === githubToken)?.source || "unknown"}`,
        );
        try {
          const res = await fetch(
            "https://api.github.com/copilot_internal/v2/token",
            {
              headers: {
                ...headersBase,
                Authorization: `token ${githubToken}`,
              },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { token?: string; sku?: string };
            if (data.token) {
              writeDebugLog("fetchCopilotUsage: exchange successful");
              return { token: data.token, sku: data.sku };
            }
          } else {
            writeDebugLog(
              `fetchCopilotUsage: exchange failed: ${res.status} ${await res.text()}`,
            );
          }
        } catch (e: unknown) {
          writeDebugLog(`fetchCopilotUsage: exchange error: ${String(e)}`);
        }
        return null;
      };

    // 2. Execution
    let any304 = false,
      lastError: string | undefined,
      skuFound: string | undefined;

    for (const t of tokens) {
      writeDebugLog(`fetchCopilotUsage: trying token from ${t.source}`);

      let tokenToUse = t.token;
      const authHeader = t.isCopilotToken
        ? `Bearer ${tokenToUse}`
        : `token ${tokenToUse}`;

      let res = await tryFetch(authHeader);
      writeDebugLog(
        `fetchCopilotUsage: fetch with ${t.source} (${t.isCopilotToken ? "Bearer" : "token"}) status: ${res.status}`,
      );

      if (res.status === 401 && !t.isCopilotToken) {
        res = await tryFetch(`Bearer ${tokenToUse}`);
        writeDebugLog(
          `fetchCopilotUsage: fetch with ${t.source} (Bearer fallback) status: ${res.status}`,
        );
      }

      if (res.status === 401 && !t.isCopilotToken) {
        const exchanged = await tryExchange(tokenToUse);
        if (exchanged) {
          tokenToUse = exchanged.token;
          skuFound = exchanged.sku;
          res = await tryFetch(`Bearer ${tokenToUse}`);
          writeDebugLog(
            `fetchCopilotUsage: fetch with exchanged ${t.source} status: ${res.status}`,
          );
        }
      }

      if (res.ok || res.status === 304) {
        writeDebugLog(
          `fetchCopilotUsage: success with token from ${t.source}${res.status === 304 ? " (304 Not Modified)" : ""}`,
        );

        if (res.status === 304) {
          any304 = true;
          continue;
        }

        const data = (await res.json()) as {
            quota_reset_date_utc?: string;
            copilot_plan?: string;
            quota_snapshots?: {
              premium_interactions?: {
                remaining?: number;
                entitlement?: number;
                percent_remaining?: number;
              };
              chat?: {
                unlimited?: boolean;
                percent_remaining?: number;
              };
            };
          },
          windows: RateWindow[] = [],
          resetDate = safeDate(data.quota_reset_date_utc),
          resetDesc = resetDate ? formatReset(resetDate) : undefined;

        if (data.quota_snapshots?.premium_interactions) {
          const pi = data.quota_snapshots.premium_interactions,
            remaining = pi.remaining ?? 0,
            entitlement = pi.entitlement ?? 0,
            usedPercent = Math.max(0, 100 - (pi.percent_remaining || 0));
          windows.push({
            label: "Premium",
            usedPercent,
            resetDescription: resetDesc
              ? `${resetDesc} (${remaining}/${entitlement})`
              : `${remaining}/${entitlement}`,
            resetsAt: resetDate,
          });
        }

        if (
          data.quota_snapshots?.chat &&
          !data.quota_snapshots.chat.unlimited
        ) {
          const { chat } = data.quota_snapshots;
          windows.push({
            label: "Chat",
            usedPercent: Math.max(0, 100 - (chat.percent_remaining || 0)),
            resetDescription: resetDesc,
            resetsAt: resetDate,
          });
        }

        return {
          provider: "copilot",
          displayName: "Copilot",
          windows,
          plan: data.copilot_plan || skuFound,
          account: t.source,
        };
      }

      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        writeDebugLog(
          `fetchCopilotUsage: auth failure HTTP ${res.status} from ${t.source}, body (truncated): ${body.slice(
            0,
            100,
          )}`,
        );
        lastError = `HTTP ${res.status} from ${t.source}`;
      } else {
        lastError = `HTTP ${res.status} from ${t.source}`;
      }
    }

    if (any304) {
      writeDebugLog(
        "fetchCopilotUsage: no fresh data but received 304, falling back to active status",
      );
      return {
        provider: "copilot",
        displayName: "Copilot",
        windows: [
          {
            label: "Access",
            usedPercent: 0,
            resetDescription: "Active (cached)",
          },
        ],
        plan: skuFound,
        account: "304-fallback",
      };
    }

    if (skuFound) {
      writeDebugLog(
        "fetchCopilotUsage: all fetch attempts failed but we have a SKU, falling back to Active",
      );
      return {
        provider: "copilot",
        displayName: "Copilot",
        windows: [
          { label: "Access", usedPercent: 0, resetDescription: "Active" },
        ],
        plan: skuFound,
        account: "fallback",
      };
    }

    return {
      provider: "copilot",
      displayName: "Copilot",
      windows: [],
      error: lastError || "All tokens failed",
      account: "none",
    };
  } catch (error: unknown) {
    writeDebugLog(`fetchCopilotUsage: fatal error: ${String(error)}`);
    return {
      provider: "copilot",
      displayName: "Copilot",
      windows: [],
      error: String(error),
      account: "error",
    };
  }
}

// ============================================================================
// Token Refresh (shared)
// ============================================================================

export async function refreshGoogleToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt?: number } | null> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:
          "947318989803-6bn6qk8qdgf4n4g3pfee6491hc0brc4i.apps.googleusercontent.com",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Gemini Usage
// ============================================================================

export async function fetchGeminiUsage(
  _modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  const geminiAuth = piAuth["google-gemini-cli"] as
    | Record<string, unknown>
    | undefined;
  let token: string | undefined =
      typeof geminiAuth?.access === "string" ? geminiAuth.access : undefined,
    projectId: string | undefined =
      (typeof geminiAuth?.projectId === "string"
        ? geminiAuth.projectId
        : undefined) ||
      (typeof geminiAuth?.project_id === "string"
        ? geminiAuth.project_id
        : undefined);
  const refreshToken: string | undefined =
    typeof geminiAuth?.refresh === "string" ? geminiAuth.refresh : undefined;

  if (!token) {
    const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    try {
      await fs.promises.access(credPath);
      const data = JSON.parse(
        await fs.promises.readFile(credPath, "utf-8"),
      ) as Record<string, unknown>;
      token =
        typeof data.access_token === "string" ? data.access_token : undefined;
      if (!projectId)
        projectId =
          (typeof data.project_id === "string" ? data.project_id : undefined) ||
          (typeof data.projectId === "string" ? data.projectId : undefined);
    } catch {
      // Ignore file access errors
    }
  }

  if (!token) {
    return {
      provider: "gemini",
      displayName: "Gemini",
      windows: [],
      error: "No credentials",
      account: "pi-auth",
    };
  }

  if (!projectId) {
    return {
      provider: "gemini",
      displayName: "Gemini",
      windows: [],
      error: "Missing projectId",
      account: "pi-auth",
    };
  }

  const doFetch = async (accessToken: string) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 5000);

    try {
      return await fetch(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ project: projectId }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await doFetch(token);

    if (res.status === 401 || res.status === 403) {
      let refreshed = false;

      if (refreshToken) {
        const newData = await refreshGoogleToken(refreshToken);
        if (newData?.accessToken) {
          token = newData.accessToken;
          res = await doFetch(token);
          refreshed = true;
        }
      }

      if (!refreshed || res.status === 401 || res.status === 403) {
        const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
        try {
          await fs.promises.access(credPath);
          const data = JSON.parse(
            await fs.promises.readFile(credPath, "utf-8"),
          ) as Record<string, unknown>;
          if (
            typeof data.access_token === "string" &&
            data.access_token !== token
          ) {
            const newToken: string = data.access_token;
            res = await doFetch(newToken);
          }
        } catch {
          // Ignore file access errors
        }
      }
    }

    if (!res.ok) {
      return {
        provider: "gemini",
        displayName: "Gemini",
        windows: [],
        error: `HTTP ${res.status}`,
        account: "pi-auth",
      };
    }

    const data = (await res.json()) as {
        buckets?: Array<{
          modelId?: string;
          remainingFraction?: number;
        }>;
      },
      families: Record<string, number> = {};

    for (const bucket of data.buckets || []) {
      const modelId = bucket.modelId || "unknown",
        frac = bucket.remainingFraction ?? 1;

      let family = "Other";
      if (modelId.toLowerCase().includes("pro")) family = "Pro";
      else if (modelId.toLowerCase().includes("flash")) family = "Flash";
      else {
        const parts = modelId.split("-");
        if (parts.length > 0) {
          family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        }
      }

      if (families[family] === undefined || frac < families[family]) {
        families[family] = frac;
      }
    }

    const windows: RateWindow[] = [];
    for (const [label, frac] of Object.entries(families)) {
      windows.push({ label, usedPercent: (1 - frac) * 100 });
    }

    return {
      provider: "gemini",
      displayName: "Gemini",
      windows,
      account: "pi-auth",
    };
  } catch (error: unknown) {
    return {
      provider: "gemini",
      displayName: "Gemini",
      windows: [],
      error: String(error),
      account: "pi-auth",
    };
  }
}

// ============================================================================
// Antigravity Usage
// ============================================================================

type AntigravityAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
};

function getAntigravityAuthFromPiAuth(
  piAuth: Record<string, unknown>,
): AntigravityAuth | undefined {
  const cred = (piAuth["google-antigravity"] ??
    piAuth.antigravity ??
    piAuth["anti-gravity"]) as Record<string, unknown> | undefined;
  if (!cred) return undefined;

  const accessToken = typeof cred.access === "string" ? cred.access : undefined;
  if (!accessToken) return undefined;

  return {
    accessToken,
    refreshToken: typeof cred.refresh === "string" ? cred.refresh : undefined,
    expiresAt: typeof cred.expires === "number" ? cred.expires : undefined,
    projectId:
      typeof cred.projectId === "string"
        ? cred.projectId
        : typeof cred.project_id === "string"
          ? cred.project_id
          : undefined,
  };
}

async function loadAntigravityAuth(
  modelRegistry: unknown,
  piAuth: Record<string, unknown>,
): Promise<AntigravityAuth | undefined> {
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
    const accessToken = await Promise.resolve(
        mr?.authStorage?.getApiKey?.("google-antigravity"),
      ),
      raw = await Promise.resolve(mr?.authStorage?.get?.("google-antigravity")),
      projectId =
        typeof raw?.projectId === "string" ? raw.projectId : undefined,
      refreshToken = typeof raw?.refresh === "string" ? raw.refresh : undefined,
      expiresAt = typeof raw?.expires === "number" ? raw.expires : undefined;

    if (typeof accessToken === "string" && accessToken.length > 0) {
      return { accessToken, projectId, refreshToken, expiresAt };
    }
  } catch {
    // Ignore registry access errors
  }

  const fromPi = getAntigravityAuthFromPiAuth(piAuth);
  if (fromPi) return fromPi;

  if (process.env.ANTIGRAVITY_API_KEY) {
    return { accessToken: process.env.ANTIGRAVITY_API_KEY };
  }

  return undefined;
}

export async function fetchAntigravityUsage(
  modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  const auth = await loadAntigravityAuth(modelRegistry, piAuth);
  if (!auth?.accessToken) {
    return {
      provider: "antigravity",
      displayName: "Antigravity",
      windows: [],
      error: "No credentials",
      account: "pi-auth",
    };
  }

  if (!auth.projectId) {
    return {
      provider: "antigravity",
      displayName: "Antigravity",
      windows: [],
      error: "Missing projectId",
      account: "pi-auth",
    };
  }

  let { accessToken } = auth;

  if (
    auth.refreshToken &&
    auth.expiresAt &&
    auth.expiresAt < Date.now() + 5 * 60 * 1000
  ) {
    const refreshed = await refreshGoogleToken(auth.refreshToken);
    if (refreshed?.accessToken) accessToken = refreshed.accessToken;
  }

  const fetchModels = async (token: string): Promise<Response> => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 5000);

    try {
      return await fetch(
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/1.12.4",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            Accept: "application/json",
          },
          body: JSON.stringify({ project: auth.projectId }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await fetchModels(accessToken);

    if (res.status === 401 || res.status === 403) {
      let refreshed = false;

      if (auth.refreshToken) {
        const refreshedToken = await refreshGoogleToken(auth.refreshToken);
        if (refreshedToken?.accessToken) {
          accessToken = refreshedToken.accessToken;
          res = await fetchModels(accessToken);
          refreshed = true;
        }
      }

      if (!refreshed || res.status === 401 || res.status === 403) {
        const fallbackAuth = getAntigravityAuthFromPiAuth(piAuth);
        if (
          fallbackAuth &&
          (fallbackAuth.accessToken !== auth.accessToken ||
            fallbackAuth.refreshToken)
        ) {
          let fallbackToken = fallbackAuth.accessToken;

          if (fallbackAuth.refreshToken) {
            const refreshedFallback = await refreshGoogleToken(
              fallbackAuth.refreshToken,
            );
            if (refreshedFallback?.accessToken) {
              fallbackToken = refreshedFallback.accessToken;
            }
          }

          res = await fetchModels(fallbackToken);
        }
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        provider: "antigravity",
        displayName: "Antigravity",
        windows: [],
        error: "Unauthorized",
        account: "pi-auth",
      };
    }

    if (!res.ok) {
      return {
        provider: "antigravity",
        displayName: "Antigravity",
        windows: [],
        error: `HTTP ${res.status}`,
        account: "pi-auth",
      };
    }

    const data = (await res.json()) as {
        models?: Record<
          string,
          {
            quotaInfo?: {
              remainingFraction?: number;
              resetTime?: string;
            };
          }
        >;
      },
      models = data.models || {},
      getQuotaInfo = (
        modelKeys: string[],
      ): {
        usedPercent: number;
        resetDescription?: string;
        resetsAt?: Date;
      } | null => {
        let worstQI: { remainingFraction: number; resetTime?: string } | null =
          null;
        for (const key of modelKeys) {
          const qi = models?.[key]?.quotaInfo;
          if (!qi) continue;
          const rf =
            typeof qi.remainingFraction === "number" ? qi.remainingFraction : 0;
          // Pessimistic selection: find the model with the least remaining quota
          if (worstQI === null || rf < worstQI.remainingFraction) {
            worstQI = { remainingFraction: rf, resetTime: qi.resetTime };
          }
        }

        if (worstQI === null) return null;

        const usedPercent = Math.min(
            100,
            Math.max(0, (1 - worstQI.remainingFraction) * 100),
          ),
          resetTime = worstQI.resetTime
            ? new Date(worstQI.resetTime)
            : undefined;
        return {
          usedPercent,
          resetDescription: resetTime ? formatReset(resetTime) : undefined,
          resetsAt: resetTime,
        };
      },
      windows: RateWindow[] = [],
      claudeOrGptOss = getQuotaInfo([
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-thinking",
        "claude-opus-4-5-thinking",
        "gpt-oss-120b-medium",
      ]);
    if (claudeOrGptOss) {
      windows.push({
        label: "Claude",
        usedPercent: claudeOrGptOss.usedPercent,
        resetDescription: claudeOrGptOss.resetDescription,
        resetsAt: claudeOrGptOss.resetsAt,
      });
    }

    const gemini3Pro = getQuotaInfo([
      "gemini-3-pro-high",
      "gemini-3-pro-low",
      "gemini-3-pro-preview",
    ]);
    if (gemini3Pro) {
      windows.push({
        label: "G3 Pro",
        usedPercent: gemini3Pro.usedPercent,
        resetDescription: gemini3Pro.resetDescription,
        resetsAt: gemini3Pro.resetsAt,
      });
    }

    const gemini3Flash = getQuotaInfo(["gemini-3-flash"]);
    if (gemini3Flash) {
      windows.push({
        label: "G3 Flash",
        usedPercent: gemini3Flash.usedPercent,
        resetDescription: gemini3Flash.resetDescription,
        resetsAt: gemini3Flash.resetsAt,
      });
    }

    if (windows.length === 0) {
      return {
        provider: "antigravity",
        displayName: "Antigravity",
        windows: [],
        error: "No quota data",
        account: "pi-auth",
      };
    }

    return {
      provider: "antigravity",
      displayName: "Antigravity",
      windows,
      account: "pi-auth",
    };
  } catch (error: unknown) {
    return {
      provider: "antigravity",
      displayName: "Antigravity",
      windows: [],
      error: String(error),
      account: "pi-auth",
    };
  }
}

// ============================================================================
// Codex (OpenAI) Usage
// ============================================================================

interface CodexCredential {
  accessToken: string;
  accountId?: string;
  source: string;
}

function getPiCodexAuths(
  piAuth: Record<string, unknown>,
): Array<{ accessToken: string; accountId?: string; source: string }> {
  const results: Array<{
    accessToken: string;
    accountId?: string;
    source: string;
  }> = [];

  try {
    const codexKeys = Object.keys(piAuth)
      .filter((k) => k.startsWith("openai-codex"))
      .sort();

    for (const key of codexKeys) {
      const source = piAuth[key] as Record<string, unknown> | undefined;
      if (!source) continue;

      let accessToken: string | undefined, accountId: string | undefined;

      if (typeof source.access === "string") {
        accessToken = source.access;
        accountId =
          typeof source.accountId === "string" ? source.accountId : undefined;
      } else {
        const tokens = source.tokens as Record<string, unknown> | undefined;
        if (typeof tokens?.access_token === "string") {
          accessToken = tokens.access_token;
          accountId =
            typeof tokens.account_id === "string"
              ? tokens.account_id
              : undefined;
        }
      }

      if (accessToken) {
        const label =
          key === "openai-codex"
            ? "pi"
            : `pi:${key.replace("openai-codex-", "")}`;
        results.push({ accessToken, accountId, source: label });
      }
    }
  } catch {
    // Ignore piAuth access errors
  }

  return results;
}

async function readCodexAuthFile(
  filePath: string,
): Promise<{ accessToken?: string; accountId?: string }> {
  try {
    await fs.promises.access(filePath);
    const data = JSON.parse(
      await fs.promises.readFile(filePath, "utf-8"),
    ) as Record<string, unknown>;
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (typeof tokens?.access_token === "string") {
      return {
        accessToken: tokens.access_token,
        accountId:
          typeof tokens.account_id === "string" ? tokens.account_id : undefined,
      };
    }
    if (typeof data.OPENAI_API_KEY === "string" && data.OPENAI_API_KEY) {
      return { accessToken: data.OPENAI_API_KEY };
    }
    return {};
  } catch {
    return {};
  }
}

async function discoverCodexCredentials(
  modelRegistry: unknown,
  piAuth: Record<string, unknown>,
): Promise<CodexCredential[]> {
  const credentials: CodexCredential[] = [],
    seenTokens = new Set<string>(),
    piAuths = getPiCodexAuths(piAuth);
  for (const p of piAuths) {
    if (!seenTokens.has(p.accessToken)) {
      credentials.push({
        accessToken: p.accessToken,
        accountId: p.accountId,
        source: p.source,
      });
      seenTokens.add(p.accessToken);
    }
  }

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
    const registryToken = await Promise.resolve(
      mr?.authStorage?.getApiKey?.("openai-codex"),
    );
    if (typeof registryToken === "string" && !seenTokens.has(registryToken)) {
      const cred = await Promise.resolve(
          mr?.authStorage?.get?.("openai-codex"),
        ),
        accountId =
          cred?.type === "oauth" && typeof cred.accountId === "string"
            ? cred.accountId
            : undefined;
      credentials.push({
        accessToken: registryToken,
        accountId,
        source: "registry",
      });
      seenTokens.add(registryToken);
    }
  } catch {
    // Ignore registry access errors
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const stats = await fs.promises.stat(codexHome);
    if (stats.isDirectory()) {
      const files = await fs.promises.readdir(codexHome),
        authFiles = files
          .filter((f) => /^auth([_-].+)?\.json$/i.test(f))
          .sort();

      for (const authFile of authFiles) {
        const authPath = path.join(codexHome, authFile),
          auth = await readCodexAuthFile(authPath);

        if (!auth.accessToken || seenTokens.has(auth.accessToken)) {
          continue;
        }

        seenTokens.add(auth.accessToken);
        const nameMatch = authFile.match(/auth[_-]?(.+)?\.json/i),
          suffix = nameMatch?.[1] || "auth",
          label = `.codex:${suffix}`;
        credentials.push({
          accessToken: auth.accessToken,
          accountId: auth.accountId,
          source: label,
        });
      }
    }
  } catch {
    // Ignore .codex directory access errors
  }

  return credentials;
}

async function fetchCodexUsageForCredential(
  cred: CodexCredential,
): Promise<UsageSnapshot> {
  const displayName = `Codex (${cred.source})`;

  try {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 5000);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${cred.accessToken}`,
        "User-Agent": "CodexBar",
        Accept: "application/json",
      };

      if (cred.accountId) {
        headers["ChatGPT-Account-Id"] = cred.accountId;
      }

      const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        return {
          provider: "codex",
          displayName,
          windows: [],
          error: "Token expired",
          account: cred.source,
        };
      }

      if (!res.ok) {
        return {
          provider: "codex",
          displayName,
          windows: [],
          error: `HTTP ${res.status}`,
          account: cred.source,
        };
      }

      const data = (await res.json()) as {
          rate_limit?: {
            primary_window?: {
              used_percent?: number | string;
              reset_at?: number;
              limit_window_seconds?: number;
            };
            secondary_window?: {
              used_percent?: number | string;
              reset_at?: number;
              limit_window_seconds?: number;
            };
          };
          plan_type?: string;
          credits?: {
            balance?: number | string;
          };
        },
        windows: RateWindow[] = [];

      let maxUsed = -1,
        bestLabel = "",
        bestResetsAt: Date | undefined;

      interface CodexWindow {
        used_percent?: number | string;
        reset_at?: number;
        limit_window_seconds?: number;
      }

      const checkCodex = (w: CodexWindow | undefined) => {
        if (!w) return;
        const used =
            typeof w.used_percent === "number"
              ? w.used_percent
              : Number(w.used_percent) || 0,
          resetAt = w.reset_at ? new Date(w.reset_at * 1000) : undefined,
          windowHours = Math.round((w.limit_window_seconds || 10800) / 3600),
          label = windowHours >= 24 ? "Week" : `${windowHours}h`;

        if (used > maxUsed) {
          maxUsed = used;
          bestLabel = label;
          bestResetsAt = resetAt;
        } else if (used === maxUsed) {
          if (resetAt && (!bestResetsAt || resetAt > bestResetsAt)) {
            bestResetsAt = resetAt;
            bestLabel = label;
          }
        }
      };

      checkCodex(data.rate_limit?.primary_window);
      checkCodex(data.rate_limit?.secondary_window);

      if (maxUsed >= 0) {
        windows.push({
          label: bestLabel,
          usedPercent: maxUsed,
          resetDescription: bestResetsAt
            ? formatReset(bestResetsAt)
            : undefined,
          resetsAt: bestResetsAt,
        });
      }

      let plan = data.plan_type;
      if (
        data.credits?.balance !== undefined &&
        data.credits.balance !== null
      ) {
        const balance =
          typeof data.credits.balance === "number"
            ? data.credits.balance
            : parseFloat(data.credits.balance) || 0;
        plan = plan
          ? `${plan} ($${balance.toFixed(2)})`
          : `$${balance.toFixed(2)}`;
      }

      return {
        provider: "codex",
        displayName,
        windows,
        plan,
        account: cred.source,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error: unknown) {
    return {
      provider: "codex",
      displayName,
      windows: [],
      error: String(error),
      account: cred.source,
    };
  }
}

function usageFingerprint(snapshot: UsageSnapshot): string | null {
  if (snapshot.error || snapshot.windows.length === 0) {
    return null;
  }
  const parts = snapshot.windows.map((w) => {
    const pct = Number.isFinite(w.usedPercent)
        ? w.usedPercent.toFixed(2)
        : "NaN",
      resetTs = w.resetsAt ? w.resetsAt.getTime() : "";
    return `${w.label}:${pct}:${resetTs}`;
  });
  return `${snapshot.provider}|${parts.sort().join("|")}`;
}

export async function fetchAllCodexUsages(
  modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot[]> {
  const credentials = await discoverCodexCredentials(modelRegistry, piAuth);

  if (credentials.length === 0) {
    return [
      {
        provider: "codex",
        displayName: "Codex",
        windows: [],
        error: "No credentials",
      },
    ];
  }

  const results = await Promise.all(
      credentials.map((cred) => fetchCodexUsageForCredential(cred)),
    ),
    seenFingerprints = new Set<string>(),
    deduplicated: UsageSnapshot[] = [];

  for (const result of results) {
    const fingerprint = usageFingerprint(result);
    if (fingerprint === null) {
      deduplicated.push(result);
    } else if (!seenFingerprints.has(fingerprint)) {
      seenFingerprints.add(fingerprint);
      deduplicated.push(result);
    }
  }

  return deduplicated;
}

// ============================================================================
// Kiro (AWS)
// ============================================================================

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

async function whichAsync(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`which ${cmd}`, { encoding: "utf-8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function fetchKiroUsage(): Promise<UsageSnapshot> {
  const kiroBinary = await whichAsync("kiro-cli");
  if (!kiroBinary) {
    return {
      provider: "kiro",
      displayName: "Kiro",
      windows: [],
      error: "kiro-cli not found",
      account: "cli",
    };
  }

  try {
    try {
      await execAsync("kiro-cli whoami", { timeout: 5000 });
    } catch {
      return {
        provider: "kiro",
        displayName: "Kiro",
        windows: [],
        error: "Not logged in",
        account: "cli",
      };
    }

    const { stdout: output } = await execAsync(
        "kiro-cli chat --no-interactive /usage",
        {
          timeout: 10000,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      ),
      stripped = stripAnsi(output),
      windows: RateWindow[] = [];

    let planName = "Kiro";
    const planMatch = stripped.match(/\|\s*(KIRO\s+\w+)/i);
    if (planMatch) {
      planName = planMatch[1].trim();
    }

    let creditsPercent = 0,
      isRemainingStyle = false;

    // Tighten the regex to specifically target lines containing "Credits", "Usage", or "Progress"
    const percentMatch = stripped.match(
      /(Progress|Usage|Credits|Quota|Remaining):?\s*(?:█+|[#=]+|\s+)?(\d+)%/i,
    );
    if (percentMatch) {
      const keyword = percentMatch[1].toLowerCase(),
        val = parseInt(percentMatch[2], 10);
      if (keyword === "remaining" || keyword === "credits") {
        isRemainingStyle = true;
        creditsPercent = 100 - val;
      } else {
        creditsPercent = val;
      }
    }

    const creditsMatch = stripped.match(
      /(Progress|Usage|Credits|Quota|Remaining):?\s*\(?(\d+\.?\d*)\s*(?:\/|of)\s*(\d+\.?\d*)\)?/i,
    );
    if (creditsMatch) {
      const keyword = creditsMatch[1].toLowerCase(),
        val1 = parseFloat(creditsMatch[2]),
        total = parseFloat(creditsMatch[3]);
      if (keyword === "remaining" || keyword === "credits")
        isRemainingStyle = true;

      if (!percentMatch && total > 0) {
        creditsPercent = isRemainingStyle
          ? ((total - val1) / total) * 100
          : (val1 / total) * 100;
      }
    }

    let resetsAt: Date | undefined;
    const resetMatch = stripped.match(/resets\s+on\s+(\d{1,2}\/\d{1,2})/i);
    if (resetMatch) {
      const parts = resetMatch[1].split("/").map(Number),
        first = parts[0],
        second = parts[1],
        now = new Date(),
        year = now.getFullYear(),
        // Heuristic: pick the interpretation that results in the closest future date
        dateMD = new Date(year, first - 1, second),
        dateDM = new Date(year, second - 1, first),
        isValid = (d: Date) => !isNaN(d.getTime());

      if (first > 12) {
        resetsAt = dateDM; // Must be DD/MM
      } else if (second > 12) {
        resetsAt = dateMD; // Must be MM/DD
      } else if (isValid(dateMD) && isValid(dateDM)) {
        // Ambiguous. Pick the one that is in the future.
        const diffMD = dateMD.getTime() - now.getTime(),
          diffDM = dateDM.getTime() - now.getTime();

        if (diffMD > 0 && diffDM > 0) {
          resetsAt = diffMD < diffDM ? dateMD : dateDM;
        } else if (diffMD > 0) {
          resetsAt = dateMD;
        } else if (diffDM > 0) {
          resetsAt = dateDM;
        } else {
          // Both in past, pick interpretation closer to now (likely current month)
          resetsAt = diffMD > diffDM ? dateMD : dateDM;
        }
      }

      if (resetsAt && isValid(resetsAt)) {
        // If date is too far in the past, assume it's next year
        if (resetsAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
          resetsAt.setFullYear(year + 1);
        }
      }
    }

    windows.push({
      label: "Credits",
      usedPercent: creditsPercent,
      resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
      resetsAt,
    });

    const bonusMatch = stripped.match(
      /(Remaining\s+)?Bonus\s*credits:?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
    );
    if (bonusMatch) {
      // Bonus credits typically display available amount (Remaining)
      const isRemainingBonus = true,
        bonusVal1 = parseFloat(bonusMatch[2]),
        bonusTotal = parseFloat(bonusMatch[3]),
        bonusPercent =
          bonusTotal > 0
            ? (isRemainingBonus
                ? (bonusTotal - bonusVal1) / bonusTotal
                : bonusVal1 / bonusTotal) * 100
            : 0,
        expiryMatch = stripped.match(/expires\s+in\s+(\d+)\s+days?/i);
      windows.push({
        label: "Bonus",
        usedPercent: bonusPercent,
        resetDescription: expiryMatch ? `${expiryMatch[1]}d left` : undefined,
      });
    }

    return {
      provider: "kiro",
      displayName: "Kiro",
      windows,
      plan: planName,
      account: "cli",
    };
  } catch (error: unknown) {
    return {
      provider: "kiro",
      displayName: "Kiro",
      windows: [],
      error: String(error),
      account: "cli",
    };
  }
}

// ============================================================================
// Z.ai
// ============================================================================

export async function fetchZaiUsage(
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  let apiKey = process.env.Z_AI_API_KEY;

  if (!apiKey) {
    const zai = (piAuth["z-ai"] ?? piAuth.zai) as
      | Record<string, unknown>
      | undefined;
    apiKey = typeof zai?.access === "string" ? zai.access : undefined;
  }

  if (!apiKey) {
    return {
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: "No API key",
      account: "pi-auth",
    };
  }

  try {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        return {
          provider: "zai",
          displayName: "z.ai",
          windows: [],
          error: `HTTP ${res.status}`,
          account: "pi-auth",
        };
      }

      const data = (await res.json()) as {
        success?: boolean;
        code?: number;
        msg?: string;
        data?: {
          planName?: string;
          plan?: string;
          limits?: Array<{
            percentage?: number;
            nextResetTime?: string;
            unit?: number;
            number?: number;
            type?: string;
          }>;
        };
      };
      if (!data.success || data.code !== 200) {
        return {
          provider: "zai",
          displayName: "z.ai",
          windows: [],
          error: data.msg || "API error",
          account: "pi-auth",
        };
      }

      const windows: RateWindow[] = [],
        limits = data.data?.limits || [];

      for (const limit of limits) {
        const percent = limit.percentage || 0,
          nextReset = limit.nextResetTime
            ? new Date(limit.nextResetTime)
            : undefined;

        let windowLabel = "Limit";
        // Unit: 1=day, 3=hour, 5=minute
        if (limit.unit === 1) windowLabel = `${limit.number}d`;
        else if (limit.unit === 3) windowLabel = `${limit.number}h`;
        else if (limit.unit === 5) windowLabel = `${limit.number}m`;

        if (limit.type === "TOKENS_LIMIT") {
          windows.push({
            label: `Tokens (${windowLabel})`,
            usedPercent: percent,
            resetDescription: nextReset ? formatReset(nextReset) : undefined,
            resetsAt: nextReset,
          });
        } else if (limit.type === "TIME_LIMIT") {
          windows.push({
            label: "Monthly",
            usedPercent: percent,
            resetDescription: nextReset ? formatReset(nextReset) : undefined,
            resetsAt: nextReset,
          });
        }
      }

      const planName = data.data?.planName || data.data?.plan || undefined;
      return {
        provider: "zai",
        displayName: "z.ai",
        windows,
        plan: planName,
        account: "pi-auth",
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error: unknown) {
    return {
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: String(error),
      account: "pi-auth",
    };
  }
}

// ============================================================================
// Usage Aggregation
// ============================================================================

export async function fetchAllUsages(
  modelRegistry: unknown,
  disabledProviders: string[] = [],
): Promise<UsageSnapshot[]> {
  const disabled = new Set(disabledProviders.map((p) => p.toLowerCase())),
    piAuth = await loadPiAuth(),
    timeout = <T>(promise: Promise<T>, ms: number, fallback: T) => {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    },
    fetchers: {
      provider: string;
      fetch: () => Promise<UsageSnapshot | UsageSnapshot[]>;
    }[] = [
      { provider: "anthropic", fetch: () => fetchClaudeUsage(piAuth) },
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
      activeFetchers.map((f) =>
        timeout(
          f.fetch(),
          12000,
          f.provider === "codex"
            ? [
                {
                  provider: f.provider,
                  displayName: f.provider,
                  windows: [],
                  error: "Timeout",
                },
              ]
            : {
                provider: f.provider,
                displayName: f.provider,
                windows: [],
                error: "Timeout",
              },
        ),
      ),
    );

  return results.flat();
}
