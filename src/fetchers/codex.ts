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
        const result = { accessToken, source: label };
        if (accountId !== undefined) {
          (
            result as {
              accessToken: string;
              accountId?: string;
              source: string;
            }
          ).accountId = accountId;
        }
        results.push(
          result as { accessToken: string; accountId?: string; source: string },
        );
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
      const result: { accessToken: string; accountId?: string } = {
        accessToken: tokens.access_token,
      };
      if (typeof tokens.account_id === "string") {
        result.accountId = tokens.account_id;
      }
      return result;
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
      const result: CodexCredential = {
        accessToken: p.accessToken,
        source: p.source,
      };
      if (p.accountId !== undefined) {
        result.accountId = p.accountId;
      }
      credentials.push(result);
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
    const registryToken = await mr?.authStorage?.getApiKey?.("openai-codex");
    if (typeof registryToken === "string" && !seenTokens.has(registryToken)) {
      const cred = await mr?.authStorage?.get?.("openai-codex"),
        accountId =
          cred?.type === "oauth" && typeof cred.accountId === "string"
            ? cred.accountId
            : undefined;
      const result: CodexCredential = {
        accessToken: registryToken,
        source: "registry",
      };
      if (accountId !== undefined) {
        result.accountId = accountId;
      }
      credentials.push(result);
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
        const result: CodexCredential = {
          accessToken: auth.accessToken,
          source: label,
        };
        if (auth.accountId !== undefined) {
          result.accountId = auth.accountId;
        }
        credentials.push(result);
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

    if (res.status === 401) {
      return {
        provider: "codex",
        displayName,
        windows: [],
        error: "Token expired",
        account: cred.source,
      };
    }

    if (res.status === 403) {
      return {
        provider: "codex",
        displayName,
        windows: [],
        error: "Permission denied",
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
    };

    const windowsByLabel = new Map<string, RateWindow>();

    interface CodexWindow {
      used_percent?: number | string;
      reset_at?: number;
      limit_window_seconds?: number;
    }

    const addCodexWindow = (w: CodexWindow | undefined) => {
      if (!w) return;
      const used =
          typeof w.used_percent === "number"
            ? w.used_percent
            : Number(w.used_percent) || 0,
        resetAt = w.reset_at ? new Date(w.reset_at * 1000) : undefined,
        hours = (w.limit_window_seconds || 10800) / 3600,
        label =
          hours >= 168 && hours % 168 === 0
            ? `${hours / 168}w`
            : hours >= 24 && hours % 24 === 0
              ? `${hours / 24}d`
              : hours % 1 === 0
                ? `${hours}h`
                : `${hours.toFixed(1)}h`;

      const entry: RateWindow = {
        label,
        usedPercent: used,
      };
      if (resetAt) {
        entry.resetDescription = formatReset(resetAt);
        entry.resetsAt = resetAt;
      }

      const existing = windowsByLabel.get(label);
      if (!existing) {
        windowsByLabel.set(label, entry);
        return;
      }

      if (used > existing.usedPercent) {
        windowsByLabel.set(label, entry);
        return;
      }

      if (used === existing.usedPercent) {
        const existingReset = existing.resetsAt?.getTime();
        const nextReset = resetAt?.getTime();
        if (
          nextReset !== undefined &&
          (existingReset === undefined || nextReset > existingReset)
        ) {
          windowsByLabel.set(label, entry);
        }
      }
    };

    addCodexWindow(dataTyped.rate_limit?.primary_window);
    addCodexWindow(dataTyped.rate_limit?.secondary_window);

    const windows = Array.from(windowsByLabel.values()).sort((a, b) => {
      if (a.usedPercent !== b.usedPercent) {
        return b.usedPercent - a.usedPercent;
      }
      const aReset = a.resetsAt
          ? a.resetsAt.getTime()
          : Number.NEGATIVE_INFINITY,
        bReset = b.resetsAt ? b.resetsAt.getTime() : Number.NEGATIVE_INFINITY;
      if (aReset !== bReset) {
        return bReset - aReset;
      }
      return a.label.localeCompare(b.label);
    });

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

    const result: UsageSnapshot = {
      provider: "codex",
      displayName,
      windows,
      account: cred.accountId || cred.source,
    };
    if (plan !== undefined) {
      result.plan = plan;
    }
    return result;
  } catch (error: unknown) {
    return {
      provider: "codex",
      displayName,
      windows: [],
      error: String(error),
      account: cred.accountId || cred.source,
    };
  }
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
    seenAccounts = new Set<string>(),
    deduplicated: UsageSnapshot[] = [];

  // Prioritize successes
  const sortedSnapshots = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    return 0;
  });

  for (const result of sortedSnapshots) {
    const accountKey = result.account || "unknown";
    if (!seenAccounts.has(accountKey)) {
      seenAccounts.add(accountKey);
      deduplicated.push(result);
    }
  }

  return deduplicated;
}
