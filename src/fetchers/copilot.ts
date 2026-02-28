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
      sources: string[];
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
          remaining?: number;
          entitlement?: number;
        };
      };
    }

    const tokens: TokenInfo[] = [],
      addToken = (token: unknown, source: string) => {
        if (typeof token !== "string" || !token) return;
        const existing = tokens.find((t) => t.token === token);
        if (existing) {
          if (!existing.sources.includes(source)) {
            existing.sources.push(source);
            writeDebugLog(
              `fetchCopilotUsage: token already known, added source ${source}`,
            );
          }
          return;
        }
        tokens.push({
          token,
          sources: [source],
          isCopilotToken: token.startsWith("tid="),
        });
        writeDebugLog(`fetchCopilotUsage: added token from ${source}`);
      },
      extractFromData = (data: unknown, source: string) => {
        if (data == null || typeof data !== "object") return;
        const d = data as Record<string, unknown>;
        const token = d.access || d.accessToken || d.access_token || d.token;
        if (typeof token === "string" && token) {
          addToken(token, `${source}.access`);
        }
      };

    // 1. Discovery
    try {
      const gcpKey = await mr?.authStorage?.getApiKey?.("github-copilot");
      addToken(gcpKey, "registry:github-copilot:apiKey");

      const gcpData = await mr?.authStorage?.get?.("github-copilot");
      extractFromData(gcpData, "registry:github-copilot:data");

      const ghKey = await mr?.authStorage?.getApiKey?.("github");
      addToken(ghKey, "registry:github:apiKey");

      const ghData = await mr?.authStorage?.get?.("github");
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
        const tInfo = tokens.find((t) => t.token === githubToken);
        writeDebugLog(
          `fetchCopilotUsage: attempting exchange for token from ${tInfo ? tInfo.sources.join(", ") : "unknown"}`,
        );
        try {
          const request = (auth: string) =>
            fetchWithTimeout(URLS.COPILOT_TOKEN, {
              headers: {
                ...headersBase,
                Authorization: auth,
              },
              timeout: 5000,
            });

          let { res, data } = await request(`token ${githubToken}`);

          if (res.status === 401) {
            writeDebugLog(
              "fetchCopilotUsage: exchange 401, retrying with Bearer",
            );
            ({ res, data } = await request(`Bearer ${githubToken}`));
          }

          const d = data as CopilotTokenResponse | undefined;
          if (res.ok && d?.token) {
            writeDebugLog("fetchCopilotUsage: exchange successful");
            const result: { token: string; sku?: string } = { token: d.token };
            if (d.sku !== undefined) {
              result.sku = d.sku;
            }
            return result;
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
        const sourceLabel = t.sources.join(", ");
        try {
          writeDebugLog(`fetchCopilotUsage: trying token from ${sourceLabel}`);

          let tokenToUse = t.token;
          let skuFound: string | undefined;

          const getAuthHeader = (tok: string, isCopilot: boolean) =>
            isCopilot ? `Bearer ${tok}` : `token ${tok}`;

          let cacheKey = tokenToUse;
          const request = (authHeader: string) =>
            tryFetch(authHeader, COPILOT_ETAGS.get(cacheKey));

          let { res, data } = await request(
            getAuthHeader(tokenToUse, t.isCopilotToken),
          );
          writeDebugLog(
            `fetchCopilotUsage: ${sourceLabel} initial fetch status: ${res.status} (isCopilotToken=${t.isCopilotToken})`,
          );

          if (res.status === 401 && !t.isCopilotToken) {
            writeDebugLog(
              `fetchCopilotUsage: ${sourceLabel} retrying with Bearer`,
            );
            ({ res, data } = await request(`Bearer ${tokenToUse}`));
            writeDebugLog(
              `fetchCopilotUsage: ${sourceLabel} Bearer retry status: ${res.status}`,
            );
          }

          if (res.status === 401 && !t.isCopilotToken) {
            const exchanged = await tryExchange(tokenToUse);
            if (exchanged) {
              tokenToUse = exchanged.token;
              cacheKey = tokenToUse;
              skuFound = exchanged.sku;
              writeDebugLog(
                `fetchCopilotUsage: ${sourceLabel} retrying with exchanged token`,
              );
              ({ res, data } = await request(`Bearer ${tokenToUse}`));
              writeDebugLog(
                `fetchCopilotUsage: ${sourceLabel} exchanged retry status: ${res.status}`,
              );
            }
          }

          if (res.status !== 200 && res.status !== 304) {
            writeDebugLog(
              `fetchCopilotUsage: fetch failed for ${sourceLabel} (HTTP ${res.status})`,
            );
          }

          if (res.status === 304) {
            writeDebugLog(
              `fetchCopilotUsage: 304 Not Modified for token from ${sourceLabel}`,
            );
            const cachedData = COPILOT_DATA_CACHE.get(cacheKey) as
              | CopilotUserResponse
              | undefined;
            if (cachedData) {
              data = cachedData;
            } else {
              const result: UsageSnapshot = {
                provider: "copilot",
                displayName: "Copilot",
                windows: [
                  {
                    label: "Access",
                    usedPercent: 0,
                    resetDescription: "Active (cached)",
                  },
                ],
                account: `304-fallback:${sourceLabel}`,
              };
              if (skuFound !== undefined) {
                result.plan = skuFound;
              }
              return result;
            }
          }

          const d = data as CopilotUserResponse | undefined;

          if (d && (res.ok || res.status === 304)) {
            if (res.status !== 304) {
              const newEtag = res.headers?.get?.("etag");
              if (newEtag) {
                COPILOT_ETAGS.set(cacheKey, newEtag);
                COPILOT_DATA_CACHE.set(cacheKey, d);
              }
            }

            const windows: RateWindow[] = [],
              resetDate = safeDate(d.quota_reset_date_utc),
              resetDesc = resetDate ? formatReset(resetDate) : undefined;

            if (d.quota_snapshots?.premium_interactions) {
              const pi = d.quota_snapshots.premium_interactions,
                remaining = pi.remaining ?? 0,
                entitlement = pi.entitlement ?? 0;

              let usedPercent = 0;
              if (typeof pi.percent_remaining === "number") {
                usedPercent = Math.max(0, 100 - pi.percent_remaining);
              } else if (entitlement > 0) {
                usedPercent = Math.max(
                  0,
                  100 - (remaining / entitlement) * 100,
                );
              }

              const window: RateWindow = {
                label: "Premium",
                usedPercent,
                resetDescription: resetDesc
                  ? `${resetDesc} (${remaining}/${entitlement})`
                  : `${remaining}/${entitlement}`,
              };
              if (resetDate) {
                window.resetsAt = resetDate;
              }
              windows.push(window);
            }

            if (d.quota_snapshots?.chat && !d.quota_snapshots.chat.unlimited) {
              const { chat } = d.quota_snapshots;
              let usedPercent = 0;
              if (typeof chat.percent_remaining === "number") {
                usedPercent = Math.max(0, 100 - chat.percent_remaining);
              } else if (
                typeof chat.remaining === "number" &&
                typeof chat.entitlement === "number" &&
                chat.entitlement > 0
              ) {
                usedPercent = Math.max(
                  0,
                  100 - (chat.remaining / chat.entitlement) * 100,
                );
              }
              const window: RateWindow = {
                label: "Chat",
                usedPercent,
                ...(resetDesc !== undefined
                  ? { resetDescription: resetDesc }
                  : {}),
              };
              if (resetDate) {
                window.resetsAt = resetDate;
              }
              windows.push(window);
            }

            if (windows.length === 0) {
              windows.push({
                label: "Access",
                usedPercent: 0,
                resetDescription: "Active",
              });
            }

            const result: UsageSnapshot = {
              provider: "copilot",
              displayName: "Copilot",
              windows,
              account: d.login || sourceLabel,
            };
            const planValue = d.copilot_plan || skuFound;
            if (planValue !== undefined) {
              result.plan = planValue;
            }
            return result;
          }

          if (skuFound) {
            return {
              provider: "copilot",
              displayName: "Copilot",
              windows: [
                { label: "Access", usedPercent: 0, resetDescription: "Active" },
              ],
              plan: skuFound,
              account: `fallback:${sourceLabel}`,
            };
          }

          return {
            provider: "copilot",
            displayName: "Copilot",
            windows: [],
            error: `HTTP ${res.status}`,
            account: sourceLabel,
          };
        } catch (e: unknown) {
          writeDebugLog(
            `fetchCopilotUsage: error for token from ${sourceLabel}: ${String(e)}`,
          );
          return {
            provider: "copilot",
            displayName: "Copilot",
            windows: [],
            error: String(e),
            account: sourceLabel,
          };
        }
      }),
    );

    const results: UsageSnapshot[] = [];
    const seenAccounts = new Set<string>();

    // Prioritize successes
    const sortedSnapshots = [...snapshots].sort((a, b) => {
      if (a.error && !b.error) return 1;
      if (!a.error && b.error) return -1;
      return 0;
    });

    const successfulAccounts = new Set(
      snapshots.filter((s) => !s.error).map((s) => s.account),
    );
    const successfulAccountNames = Array.from(successfulAccounts);
    const isSingleAccountSuccess = successfulAccountNames.length === 1;

    for (const s of sortedSnapshots) {
      const accountKey = s.account || "unknown";
      if (!seenAccounts.has(accountKey)) {
        if (s.error) {
          if (successfulAccounts.has(accountKey)) {
            writeDebugLog(
              `fetchCopilotUsage: suppressing error from ${s.account} because another token succeeded for this account`,
            );
            continue;
          }
          // Suppress anonymous errors if a single account succeeded
          if (
            isSingleAccountSuccess &&
            (accountKey.includes(":") ||
              accountKey.startsWith("auth.json") ||
              accountKey === "gh-cli" ||
              accountKey === "none")
          ) {
            writeDebugLog(
              `fetchCopilotUsage: suppressing anonymous error from ${accountKey} because single account ${successfulAccountNames[0]} succeeded`,
            );
            continue;
          }
        }
        seenAccounts.add(accountKey);
        results.push(s);
      }
    }

    return results;
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
