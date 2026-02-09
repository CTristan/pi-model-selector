import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RateWindow, UsageSnapshot } from "../types.js";
import { fetchWithTimeout, formatReset, URLS } from "./common.js";

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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.accessToken}`,
      "User-Agent": "CodexBar",
      Accept: "application/json",
    };

    if (cred.accountId) {
      headers["ChatGPT-Account-Id"] = cred.accountId;
    }

    const { res, data } = await fetchWithTimeout(URLS.CODEX_USAGE, {
      method: "GET",
      headers,
      timeout: 5000,
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

    const dataTyped = data as {
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

    checkCodex(dataTyped.rate_limit?.primary_window);
    checkCodex(dataTyped.rate_limit?.secondary_window);

    if (maxUsed >= 0) {
      windows.push({
        label: bestLabel,
        usedPercent: maxUsed,
        resetDescription: bestResetsAt ? formatReset(bestResetsAt) : undefined,
        resetsAt: bestResetsAt,
      });
    }

    let plan = dataTyped.plan_type;
    if (
      dataTyped.credits?.balance !== undefined &&
      dataTyped.credits.balance !== null
    ) {
      const balance =
        typeof dataTyped.credits.balance === "number"
          ? dataTyped.credits.balance
          : parseFloat(dataTyped.credits.balance) || 0;
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
  const escape = (s: string) => s.replace(/\|/g, "\\|");
  const parts = snapshot.windows.map((w) => {
    const pct = Number.isFinite(w.usedPercent)
        ? w.usedPercent.toFixed(2)
        : "NaN",
      resetTs = w.resetsAt ? w.resetsAt.getTime() : "";
    return `${escape(w.label)}:${pct}:${resetTs}`;
  });
  const accountPart = snapshot.account ? `|${escape(snapshot.account)}` : "";
  return `${snapshot.provider}|${parts.sort().join("|")}${accountPart}`;
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
