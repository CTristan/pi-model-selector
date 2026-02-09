import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RateWindow, UsageSnapshot } from "../types.js";
import { fetchWithTimeout, refreshGoogleToken, URLS } from "./common.js";

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
  let clientId: string | undefined =
    typeof geminiAuth?.clientId === "string"
      ? geminiAuth.clientId
      : typeof geminiAuth?.client_id === "string"
        ? geminiAuth.client_id
        : undefined;

  if (!token || !projectId || !clientId) {
    const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    try {
      await fs.promises.access(credPath);
      const data = JSON.parse(
        await fs.promises.readFile(credPath, "utf-8"),
      ) as Record<string, unknown>;
      if (!token)
        token =
          typeof data.access_token === "string" ? data.access_token : undefined;
      if (!projectId)
        projectId =
          (typeof data.project_id === "string" ? data.project_id : undefined) ||
          (typeof data.projectId === "string" ? data.projectId : undefined);
      if (!clientId)
        clientId =
          (typeof data.client_id === "string" ? data.client_id : undefined) ||
          (typeof data.clientId === "string" ? data.clientId : undefined);
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

  const doFetch = (accessToken: string) =>
    fetchWithTimeout(URLS.GEMINI_QUOTA, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: projectId }),
      timeout: 10000,
    });

  try {
    let { res, data } = await doFetch(token);

    if (res.status === 401 || res.status === 403) {
      let refreshed = false;

      if (refreshToken) {
        const newData = await refreshGoogleToken(refreshToken, clientId);
        if (newData?.accessToken) {
          token = newData.accessToken;
          ({ res, data } = await doFetch(token));
          refreshed = true;
        }
      }

      if (!refreshed || res.status === 401 || res.status === 403) {
        const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
        try {
          await fs.promises.access(credPath);
          const dataFromDisc = JSON.parse(
            await fs.promises.readFile(credPath, "utf-8"),
          ) as Record<string, unknown>;
          if (
            typeof dataFromDisc.access_token === "string" &&
            dataFromDisc.access_token !== token
          ) {
            const newToken: string = dataFromDisc.access_token;
            ({ res, data } = await doFetch(newToken));
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

    const dataTyped = data as {
        buckets?: Array<{
          modelId?: string;
          remainingFraction?: number;
        }>;
      },
      families: Record<string, number> = {};

    for (const bucket of dataTyped.buckets || []) {
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
