import type { RateWindow, UsageSnapshot } from "../types.js";
import { writeDebugLog } from "../types.js";
import {
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
  COPILOT_USER_AGENT,
  execAsync,
  fetchWithTimeout,
  formatReset,
  safeDate,
  URLS,
} from "./common.js";

// Cache for Copilot ETags and data to support 304 Not Modified
const COPILOT_ETAGS = new Map<string, string>();
const COPILOT_DATA_CACHE = new Map<string, unknown>();

export async function fetchCopilotUsage(
  modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot[]> {
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

    interface CopilotTokenResponse {
      token: string;
      sku?: string;
    }

    interface CopilotUserResponse {
      login?: string;
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
        addToken(d.refresh || d.refresh_token, `${source}.refresh`);
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
    if (copilotAuth) {
      extractFromData(copilotAuth, "auth.json");
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
      return [
        {
          provider: "copilot",
          displayName: "Copilot",
          windows: [],
          error: "No token found",
          account: "none",
        },
      ];
    }

    const headersBase = {
        "Editor-Version": COPILOT_EDITOR_VERSION,
        "Editor-Plugin-Version": COPILOT_PLUGIN_VERSION,
        "User-Agent": COPILOT_USER_AGENT,
        Accept: "application/json",
      },
      tryFetch = (authHeader: string, etag?: string) =>
        fetchWithTimeout(URLS.COPILOT_USER, {
          headers: {
            ...headersBase,
            Authorization: authHeader,
            ...(etag ? { "If-None-Match": etag } : {}),
          },
          timeout: 10000,
        }),
      tryExchange = async (
        githubToken: string,
      ): Promise<{ token: string; sku?: string } | null> => {
        writeDebugLog(
          `fetchCopilotUsage: attempting exchange for token from ${tokens.find((t) => t.token === githubToken)?.source || "unknown"}`,
        );
        try {
          const { res, data } = await fetchWithTimeout(URLS.COPILOT_TOKEN, {
            headers: {
              ...headersBase,
              Authorization: `token ${githubToken}`,
            },
            timeout: 5000,
          });
          const d = data as CopilotTokenResponse | undefined;
          if (res.ok && d?.token) {
            writeDebugLog("fetchCopilotUsage: exchange successful");
            return { token: d.token, sku: d.sku };
          } else if (res) {
            writeDebugLog(`fetchCopilotUsage: exchange failed: ${res.status}`);
          }
        } catch (e: unknown) {
          writeDebugLog(`fetchCopilotUsage: exchange error: ${String(e)}`);
        }
        return null;
      };

    // 2. Execution
    const snapshots = await Promise.all(
      tokens.map(async (t): Promise<UsageSnapshot> => {
        writeDebugLog(`fetchCopilotUsage: trying token from ${t.source}`);

        let tokenToUse = t.token;
        let skuFound: string | undefined;

        const getAuthHeader = (tok: string, isCopilot: boolean) =>
          isCopilot ? `Bearer ${tok}` : `token ${tok}`;

        const etag = COPILOT_ETAGS.get(t.token);
        let { res, data } = await tryFetch(
          getAuthHeader(tokenToUse, t.isCopilotToken),
          etag,
        );

        if (res.status === 401 && !t.isCopilotToken) {
          ({ res, data } = await tryFetch(`Bearer ${tokenToUse}`, etag));
        }

        if (res.status === 401 && !t.isCopilotToken) {
          const exchanged = await tryExchange(tokenToUse);
          if (exchanged) {
            tokenToUse = exchanged.token;
            skuFound = exchanged.sku;
            ({ res, data } = await tryFetch(`Bearer ${tokenToUse}`, etag));
          }
        }

        if (res.status !== 200 && res.status !== 304) {
          writeDebugLog(
            `fetchCopilotUsage: fetch failed for ${t.source} (HTTP ${res.status})`,
          );
        }

        if (res.status === 304) {
          writeDebugLog(
            `fetchCopilotUsage: 304 Not Modified for token from ${t.source}`,
          );
          const cachedData = COPILOT_DATA_CACHE.get(t.token) as
            | CopilotUserResponse
            | undefined;
          if (cachedData) {
            data = cachedData;
          } else {
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
        }

        const d = data as CopilotUserResponse | undefined;

        if (d && (res.ok || res.status === 304)) {
          if (res.status !== 304) {
            const newEtag = res.headers?.get?.("etag");
            if (newEtag) {
              COPILOT_ETAGS.set(t.token, newEtag);
              COPILOT_DATA_CACHE.set(t.token, d);
            }
          }

          const windows: RateWindow[] = [],
            resetDate = safeDate(d.quota_reset_date_utc),
            resetDesc = resetDate ? formatReset(resetDate) : undefined;

          if (d.quota_snapshots?.premium_interactions) {
            const pi = d.quota_snapshots.premium_interactions,
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

          if (d.quota_snapshots?.chat && !d.quota_snapshots.chat.unlimited) {
            const { chat } = d.quota_snapshots;
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
            plan: d.copilot_plan || skuFound,
            account: d.login || t.source,
          };
        }

        if (skuFound) {
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
          error: `HTTP ${res.status}`,
          account: t.source,
        };
      }),
    );

    const successful = snapshots.filter((s) => !s.error);
    if (successful.length > 0) {
      // Deduplicate by account (e.g. login)
      const seen = new Set<string>();
      return successful.filter((s) => {
        const key = `${s.provider}:${s.account || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // Deduplicate errors
    const seenErrors = new Set<string>();
    return snapshots.filter((s) => {
      if (!s.error) return true;
      if (seenErrors.has(s.error)) return false;
      seenErrors.add(s.error);
      return true;
    });
  } catch (error: unknown) {
    writeDebugLog(`fetchCopilotUsage: fatal error: ${String(error)}`);
    return [
      {
        provider: "copilot",
        displayName: "Copilot",
        windows: [],
        error: String(error),
        account: "error",
      },
    ];
  }
}
