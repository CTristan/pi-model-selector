import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RateWindow, UsageSnapshot } from "../types.js";
import { writeDebugLog } from "../types.js";
import {
  fetchWithTimeout,
  parseEpochMillis,
  refreshGoogleToken,
  URLS,
} from "./common.js";

interface GeminiTokenInfo {
  token?: string;
  refreshToken?: string;
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: number;
  sources: string[];
}

export async function fetchGeminiUsage(
  modelRegistry: unknown,
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot[]> {
  try {
    writeDebugLog("fetchGeminiUsage: starting");

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

    const discoveredProjectIds = new Set<string>();
    const discoveredCredentials: Array<{
      token?: string;
      refreshToken?: string;
      projectId?: string;
      clientId?: string;
      clientSecret?: string;
      expiresAt?: number;
      source: string;
    }> = [];

    const addFragment = (
      source: string,
      token?: string,
      refreshToken?: string,
      projectId?: string,
      clientId?: string,
      clientSecret?: string,
      expiresAt?: number,
    ) => {
      if (projectId) discoveredProjectIds.add(projectId);
      if (token || refreshToken || projectId) {
        discoveredCredentials.push({
          token,
          refreshToken,
          projectId,
          clientId,
          clientSecret,
          expiresAt,
          source,
        });
        writeDebugLog(`fetchGeminiUsage: discovered fragment from ${source}`);
      }
    };

    const extractFromData = (data: unknown, source: string) => {
      if (data == null || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      const token = d.access || d.access_token || d.token || d.accessToken;
      const refresh = d.refresh || d.refresh_token;
      const project = d.projectId || d.project_id;
      const client = d.clientId || d.client_id;
      const clientSecret = d.clientSecret || d.client_secret;
      const expiresAt =
        parseEpochMillis(
          d.expires ?? d.expiresAt ?? d.expiry_date ?? d.expiryDate,
        ) ??
        (typeof d.expires_in === "number" && Number.isFinite(d.expires_in)
          ? Date.now() + d.expires_in * 1000
          : typeof d.expires_in === "string" && /^\d+$/.test(d.expires_in)
            ? Date.now() + Number(d.expires_in) * 1000
            : undefined);

      if (
        typeof token === "string" ||
        typeof refresh === "string" ||
        typeof project === "string"
      ) {
        addFragment(
          source,
          typeof token === "string" ? token : undefined,
          typeof refresh === "string" ? refresh : undefined,
          typeof project === "string" ? project : undefined,
          typeof client === "string" ? client : undefined,
          typeof clientSecret === "string" ? clientSecret : undefined,
          expiresAt,
        );
      }
    };

    // 1. Discovery
    try {
      const discoverRegistry = async (id: string) => {
        const key = await mr?.authStorage?.getApiKey?.(id);
        if (key) addFragment(`registry:${id}:apiKey`, key);

        const data = await mr?.authStorage?.get?.(id);
        extractFromData(data, `registry:${id}:data`);
      };

      await discoverRegistry("google-gemini");
      await discoverRegistry("google-gemini-cli");

      extractFromData(
        piAuth["google-gemini-cli"],
        "auth.json:google-gemini-cli",
      );
      extractFromData(piAuth["google-gemini"], "auth.json:google-gemini");
    } catch (e: unknown) {
      writeDebugLog(`fetchGeminiUsage: registry error: ${String(e)}`);
    }

    // Fallback to disk
    const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    try {
      await fs.promises.access(credPath);
      const diskData = JSON.parse(
        await fs.promises.readFile(credPath, "utf-8"),
      ) as unknown;
      extractFromData(diskData, "disk:~/.gemini/oauth_creds.json");
    } catch {
      // Ignore
    }

    // Merging logic:
    // 1. Group credentials by their auth content.
    const groupedAuth = new Map<
      string,
      {
        token?: string;
        refreshToken?: string;
        clientId?: string;
        clientSecret?: string;
        expiresAt?: number;
        projectIds: Set<string>;
        sources: Set<string>;
      }
    >();

    for (const cred of discoveredCredentials) {
      const key = `${cred.token || ""}|${cred.refreshToken || ""}|${cred.clientId || ""}|${cred.clientSecret || ""}`;
      if (!groupedAuth.has(key)) {
        groupedAuth.set(key, {
          token: cred.token,
          refreshToken: cred.refreshToken,
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          expiresAt: cred.expiresAt,
          projectIds: new Set(),
          sources: new Set(),
        });
      }
      const group = groupedAuth.get(key);
      if (!group) continue;
      if (cred.projectId) group.projectIds.add(cred.projectId);
      if (cred.expiresAt !== undefined) {
        group.expiresAt = Math.max(group.expiresAt ?? 0, cred.expiresAt);
      }
      group.sources.add(cred.source);
    }

    const projectSources = new Map<string, Set<string>>();
    for (const pid of discoveredProjectIds) {
      projectSources.set(pid, new Set());
    }
    for (const cred of discoveredCredentials) {
      if (cred.projectId) {
        projectSources.get(cred.projectId)?.add(cred.source);
      }
    }

    const configs: GeminiTokenInfo[] = [];

    // 2. For each unique projectId, find matching auth groups
    for (const pid of discoveredProjectIds) {
      const sourcesForPid = projectSources.get(pid) ?? new Set<string>();

      for (const group of groupedAuth.values()) {
        if (group.projectIds.has(pid) || group.projectIds.size === 0) {
          if (!group.token && !group.refreshToken) continue;

          // Merge sources from the project discovery and the auth group.
          const combinedSources = new Set([
            ...Array.from(sourcesForPid),
            ...Array.from(group.sources),
          ]);

          configs.push({
            projectId: pid,
            token: group.token,
            refreshToken: group.refreshToken,
            clientId: group.clientId,
            clientSecret: group.clientSecret,
            expiresAt: group.expiresAt,
            sources: Array.from(combinedSources),
          });
        }
      }
    }

    // 3. Handle auth groups that didn't match any project
    for (const group of groupedAuth.values()) {
      if (!group.token && !group.refreshToken) continue;

      const alreadyUsed = configs.some(
        (c) =>
          c.token === group.token &&
          c.refreshToken === group.refreshToken &&
          c.clientId === group.clientId &&
          c.clientSecret === group.clientSecret,
      );

      if (!alreadyUsed) {
        configs.push({
          token: group.token,
          refreshToken: group.refreshToken,
          clientId: group.clientId,
          clientSecret: group.clientSecret,
          expiresAt: group.expiresAt,
          sources: Array.from(group.sources),
        });
      }
    }

    if (configs.length === 0) {
      return [
        {
          provider: "gemini",
          displayName: "Gemini",
          windows: [],
          error: "No credentials",
          account: "none",
        },
      ];
    }

    // 2. Execution
    // Group configs by projectId to process accounts in parallel,
    // but try credentials for the same account sequentially.
    const projectGroups = new Map<string, GeminiTokenInfo[]>();
    for (const cfg of configs) {
      const pid = cfg.projectId || "no-project";
      const group = projectGroups.get(pid);
      if (group) {
        group.push(cfg);
      } else {
        projectGroups.set(pid, [cfg]);
      }
    }

    const snapshots = await Promise.all(
      Array.from(projectGroups.entries()).map(
        async ([projectId, groupConfigs]): Promise<UsageSnapshot> => {
          let lastSnapshot: UsageSnapshot | undefined;
          const triedTokensInProject = new Set<string>();

          for (const cfg of groupConfigs) {
            try {
              if (projectId === "no-project") {
                lastSnapshot = {
                  provider: "gemini",
                  displayName: "Gemini",
                  windows: [],
                  error: "Missing projectId",
                  account: cfg.sources.join(", "),
                };
                continue;
              }

              const doFetch = async (tok: string) => {
                triedTokensInProject.add(tok);
                return fetchWithTimeout(URLS.GEMINI_QUOTA, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${tok}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ project: projectId }),
                  timeout: 10000,
                });
              };

              let currentToken = cfg.token;

              // Proactively refresh expired/missing access tokens when possible.
              if (
                cfg.refreshToken &&
                (!currentToken ||
                  (cfg.expiresAt !== undefined &&
                    cfg.expiresAt < Date.now() + 60_000))
              ) {
                const refreshed = await refreshGoogleToken(
                  cfg.refreshToken,
                  cfg.clientId,
                  cfg.clientSecret,
                );
                if (refreshed?.accessToken) {
                  currentToken = refreshed.accessToken;
                }
              }

              if (currentToken && triedTokensInProject.has(currentToken)) {
                // Skip if we already tried this token and it failed.
                continue;
              }

              let res: Response;
              let data: unknown;

              if (currentToken) {
                ({ res, data } = await doFetch(currentToken));
              } else {
                res = { ok: false, status: 401 } as Response;
              }

              if (
                (res.status === 401 || res.status === 403) &&
                cfg.refreshToken
              ) {
                const refreshed = await refreshGoogleToken(
                  cfg.refreshToken,
                  cfg.clientId,
                  cfg.clientSecret,
                );
                if (refreshed?.accessToken) {
                  currentToken = refreshed.accessToken;
                  if (triedTokensInProject.has(currentToken)) {
                    // Already tried this refreshed token from another source.
                    continue;
                  }
                  ({ res, data } = await doFetch(currentToken));
                }
              }

              if (!res.ok) {
                lastSnapshot = {
                  provider: "gemini",
                  displayName: "Gemini",
                  windows: [],
                  error: `HTTP ${res.status}`,
                  account: projectId,
                };
                continue;
              }

              const dataTyped = data as {
                buckets?: Array<{
                  modelId?: string;
                  remainingFraction?: number;
                }>;
              };
              const families: Record<string, number> = {};

              for (const bucket of dataTyped.buckets || []) {
                const modelId = bucket.modelId || "unknown",
                  frac = bucket.remainingFraction ?? 1;

                let family = "Other";
                if (modelId.toLowerCase().includes("pro")) family = "Pro";
                else if (modelId.toLowerCase().includes("flash")) {
                  family = "Flash";
                } else {
                  const parts = modelId.split("-");
                  if (parts.length > 0 && parts[0]) {
                    family =
                      parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
                  }
                }

                if (!family) family = "Other";

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
                account: projectId,
              };
            } catch (e: unknown) {
              lastSnapshot = {
                provider: "gemini",
                displayName: "Gemini",
                windows: [],
                error: String(e),
                account: projectId,
              };
            }
          }

          return (
            lastSnapshot || {
              provider: "gemini",
              displayName: "Gemini",
              windows: [],
              error: "No working credentials",
              account: projectId,
            }
          );
        },
      ),
    );

    // 3. Deduplication and suppression
    const results: UsageSnapshot[] = [];
    const seenAccounts = new Set<string>();
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
              `fetchGeminiUsage: suppressing error from ${s.account} because another token succeeded for this project`,
            );
            continue;
          }
          // Suppress anonymous errors if a single account/project succeeded.
          if (
            isSingleAccountSuccess &&
            (accountKey.includes(":") ||
              accountKey === "none" ||
              accountKey === "error")
          ) {
            writeDebugLog(
              `fetchGeminiUsage: suppressing anonymous error from ${accountKey} because single account/project ${successfulAccountNames[0]} succeeded`,
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
    writeDebugLog(`fetchGeminiUsage: fatal error: ${String(error)}`);
    return [
      {
        provider: "gemini",
        displayName: "Gemini",
        windows: [],
        error: String(error),
        account: "error",
      },
    ];
  }
}
