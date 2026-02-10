import type { RateWindow, UsageSnapshot } from "../types.js";
import { fetchWithTimeout, formatReset, safeDate, URLS } from "./common.js";

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
    const { res, data } = await fetchWithTimeout(URLS.ZAI_QUOTA, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: 5000,
    });

    if (!res.ok) {
      return {
        provider: "zai",
        displayName: "z.ai",
        windows: [],
        error: `HTTP ${res.status}`,
        account: "pi-auth",
      };
    }

    const dataTyped = data as {
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
    if (!dataTyped.success || dataTyped.code !== 200) {
      return {
        provider: "zai",
        displayName: "z.ai",
        windows: [],
        error: dataTyped.msg || "API error",
        account: "pi-auth",
      };
    }

    const windows: RateWindow[] = [],
      limits = dataTyped.data?.limits || [];

    for (const limit of limits) {
      const percent = limit.percentage || 0,
        nextReset = safeDate(limit.nextResetTime);

      let windowLabel = "Limit";
      if (typeof limit.number === "number" && typeof limit.unit === "number") {
        // Unit: 1=day, 3=hour, 5=minute
        if (limit.unit === 1) windowLabel = `${limit.number}d`;
        else if (limit.unit === 3) windowLabel = `${limit.number}h`;
        else if (limit.unit === 5) windowLabel = `${limit.number}m`;
      }

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

    return {
      provider: "zai",
      displayName: "z.ai",
      windows,
      plan: dataTyped.data?.planName || dataTyped.data?.plan,
      account: "pi-auth",
    };
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
