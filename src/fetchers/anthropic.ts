import * as os from "node:os";
import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  execAsync,
  fetchWithTimeout,
  formatReset,
  safeDate,
  URLS,
} from "./common.js";

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

  const doFetch = (accessToken: string) =>
    fetchWithTimeout(URLS.ANTHROPIC_USAGE, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      timeout: 10000,
    });

  try {
    let { res, data } = await doFetch(token);

    if (res.status === 401 || res.status === 403) {
      if (source === "auth.json") {
        const keychainToken = await loadClaudeKeychainToken();
        if (keychainToken && keychainToken !== token) {
          token = keychainToken;
          source = "keychain";
          ({ res, data } = await doFetch(token));
        }
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

    if (windows.length === 0 && (globalUtilization >= 0 || globalResetsAt)) {
      const label =
        (dataTyped.five_hour?.utilization ?? 0) >=
        (dataTyped.seven_day?.utilization ?? 0)
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
