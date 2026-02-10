import type { RateWindow, UsageSnapshot } from "../types.js";
import {
  ANTIGRAVITY_API_CLIENT,
  ANTIGRAVITY_USER_AGENT,
  fetchWithTimeout,
  formatReset,
  refreshGoogleToken,
  URLS,
} from "./common.js";

type AntigravityAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
  clientId?: string;
};

type AntigravityAuthSource = "registry" | "env" | "pi-auth";

type AntigravityAuthFragment = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
  clientId?: string;
};

function parseAuthFragment(
  raw: Record<string, unknown>,
): AntigravityAuthFragment {
  return {
    accessToken:
      typeof raw.access === "string"
        ? raw.access
        : typeof raw.accessToken === "string"
          ? raw.accessToken
          : undefined,
    refreshToken:
      typeof raw.refresh === "string"
        ? raw.refresh
        : typeof raw.refreshToken === "string"
          ? raw.refreshToken
          : undefined,
    expiresAt:
      typeof raw.expires === "number"
        ? raw.expires
        : typeof raw.expiresAt === "number"
          ? raw.expiresAt
          : undefined,
    projectId:
      typeof raw.projectId === "string"
        ? raw.projectId
        : typeof raw.project_id === "string"
          ? raw.project_id
          : undefined,
    clientId:
      typeof raw.clientId === "string"
        ? raw.clientId
        : typeof raw.client_id === "string"
          ? raw.client_id
          : undefined,
  };
}

function getAntigravityAuthFromPiAuth(
  piAuth: Record<string, unknown>,
): AntigravityAuthFragment {
  const cred = (piAuth["google-antigravity"] ??
    piAuth.antigravity ??
    piAuth["anti-gravity"]) as Record<string, unknown> | undefined;
  if (!cred) return {};
  return parseAuthFragment(cred);
}

function getAntigravityAuthFromEnv(): AntigravityAuthFragment {
  return {
    accessToken: process.env.ANTIGRAVITY_API_KEY,
    projectId:
      process.env.ANTIGRAVITY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
  };
}

async function loadAntigravityAuth(
  modelRegistry: unknown,
  piAuth: Record<string, unknown>,
): Promise<(AntigravityAuth & { source: AntigravityAuthSource }) | undefined> {
  let registryAuth: AntigravityAuthFragment = {};

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
      raw = await Promise.resolve(mr?.authStorage?.get?.("google-antigravity"));

    registryAuth = {
      ...(raw ? parseAuthFragment(raw) : {}),
      accessToken: typeof accessToken === "string" ? accessToken : undefined,
    };
  } catch {
    // Ignore registry access errors
  }

  const envAuth = getAntigravityAuthFromEnv(),
    piAuthData = getAntigravityAuthFromPiAuth(piAuth),
    primary:
      | { source: AntigravityAuthSource; data: AntigravityAuthFragment }
      | undefined =
      (registryAuth.accessToken
        ? { source: "registry", data: registryAuth }
        : undefined) ||
      (envAuth.accessToken ? { source: "env", data: envAuth } : undefined) ||
      (piAuthData.accessToken
        ? { source: "pi-auth", data: piAuthData }
        : undefined);

  if (!primary?.data.accessToken) return undefined;

  const mergedProjectId =
      primary.data.projectId ||
      registryAuth.projectId ||
      envAuth.projectId ||
      piAuthData.projectId,
    mergedClientId =
      primary.data.clientId || registryAuth.clientId || piAuthData.clientId;

  return {
    accessToken: primary.data.accessToken,
    refreshToken: primary.data.refreshToken,
    expiresAt: primary.data.expiresAt,
    projectId: mergedProjectId,
    clientId: mergedClientId,
    source: primary.source,
  };
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
    const refreshed = await refreshGoogleToken(
      auth.refreshToken,
      auth.clientId,
    );
    if (refreshed?.accessToken) accessToken = refreshed.accessToken;
  }

  const fetchModels = (token: string) =>
    fetchWithTimeout(URLS.ANTIGRAVITY_MODELS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        "X-Goog-Api-Client": ANTIGRAVITY_API_CLIENT,
        Accept: "application/json",
      },
      body: JSON.stringify({ project: auth.projectId }),
      timeout: 10000,
    });

  try {
    const attemptedModelTokens = new Set<string>(),
      fetchModelsForToken = async (token: string) => {
        attemptedModelTokens.add(token);
        return fetchModels(token);
      };

    let { res, data } = await fetchModelsForToken(accessToken);

    if (res.status === 401 || res.status === 403) {
      let refreshed = false;

      if (auth.refreshToken) {
        const refreshedToken = await refreshGoogleToken(
          auth.refreshToken,
          auth.clientId,
        );
        if (
          refreshedToken?.accessToken &&
          !attemptedModelTokens.has(refreshedToken.accessToken)
        ) {
          accessToken = refreshedToken.accessToken;
          ({ res, data } = await fetchModelsForToken(accessToken));
          refreshed = true;
        }
      }

      if (!refreshed || res.status === 401 || res.status === 403) {
        if (auth.source !== "pi-auth") {
          const fallbackAuth = getAntigravityAuthFromPiAuth(piAuth);
          if (fallbackAuth.accessToken) {
            let fallbackToken = fallbackAuth.accessToken;

            if (fallbackAuth.refreshToken) {
              const refreshedFallback = await refreshGoogleToken(
                fallbackAuth.refreshToken,
                fallbackAuth.clientId,
              );
              if (refreshedFallback?.accessToken) {
                fallbackToken = refreshedFallback.accessToken;
              }
            }

            if (!attemptedModelTokens.has(fallbackToken)) {
              ({ res, data } = await fetchModelsForToken(fallbackToken));
            }
          }
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

    const dataTyped = data as {
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
      models = dataTyped.models || {},
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
        "claude-opus-4-6-thinking",
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
