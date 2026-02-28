import type { RateWindow, UsageSnapshot } from "../types.js";
import { fetchWithTimeout, formatReset, safeDate, URLS } from "./common.js";

export function resolveZaiApiKey(
  piAuth: Record<string, unknown>,
): string | undefined {
  const envApiKey = process.env.Z_AI_API_KEY;
  if (typeof envApiKey === "string" && envApiKey.trim().length > 0) {
    return envApiKey.trim();
  }

  const zai = (piAuth["z-ai"] ?? piAuth.zai) as
    | Record<string, unknown>
    | undefined;

  const access = zai?.access,
    key = zai?.key;

  if (typeof access === "string" && access.trim().length > 0) {
    return access.trim();
  }

  if (typeof key === "string" && key.trim().length > 0) {
    return key.trim();
  }

  return undefined;
}

export async function fetchZaiUsage(
  piAuth: Record<string, unknown> = {},
): Promise<UsageSnapshot> {
  const apiKey = resolveZaiApiKey(piAuth);

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
        const window: RateWindow = {
          label: `Tokens (${windowLabel})`,
          usedPercent: percent,
        };
        if (nextReset) {
          window.resetDescription = formatReset(nextReset);
          window.resetsAt = nextReset;
        }
        windows.push(window);
      } else if (limit.type === "TIME_LIMIT") {
        const window: RateWindow = {
          label: "Monthly",
          usedPercent: percent,
        };
        if (nextReset) {
          window.resetDescription = formatReset(nextReset);
          window.resetsAt = nextReset;
        }
        windows.push(window);
      }
    }

    const result: UsageSnapshot = {
      provider: "zai",
      displayName: "z.ai",
      windows,
      account: "pi-auth",
    };
    const planValue = dataTyped.data?.planName || dataTyped.data?.plan;
    if (planValue !== undefined) {
      result.plan = planValue;
    }
    return result;
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
