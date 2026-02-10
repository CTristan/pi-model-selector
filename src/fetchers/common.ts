import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

export const execAsync = promisify(exec);

export const COPILOT_EDITOR_VERSION = "vscode/1.97.2";
export const COPILOT_PLUGIN_VERSION = "copilot/1.254.0";
export const COPILOT_USER_AGENT = "GitHubCopilot/1.254.0";
export const ANTIGRAVITY_USER_AGENT = "antigravity/1.12.5";
export const ANTIGRAVITY_API_CLIENT =
  "google-cloud-sdk vscode_cloudshelleditor/0.1";

export const GOOGLE_CLOUD_SHELL_CLIENT_ID =
  "947318989803-6bn6qk8qdgf4n4g3pfee6491hc0brc4i.apps.googleusercontent.com";

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  copilot: "Copilot",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  zai: "z.ai",
};

export const URLS = {
  ANTHROPIC_USAGE: "https://api.anthropic.com/api/oauth/usage",
  COPILOT_USER: "https://api.github.com/copilot_internal/user",
  COPILOT_TOKEN: "https://api.github.com/copilot_internal/v2/token",
  GOOGLE_TOKEN: "https://oauth2.googleapis.com/token",
  GEMINI_QUOTA:
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  ANTIGRAVITY_MODELS:
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  CODEX_USAGE: "https://chatgpt.com/backend-api/wham/usage",
  ZAI_QUOTA: "https://api.z.ai/api/monitor/usage/quota/limit",
};

export async function loadPiAuth(): Promise<Record<string, unknown>> {
  const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    const data = await fs.promises.readFile(piAuthPath, "utf-8");
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function safeDate(value: unknown): Date | undefined {
  // Fix safeDate Epoch Issue: returns undefined for value = 0, ignoring the valid Epoch timestamp.
  if (value === 0 || value === "0") return new Date(0);
  if (!value) return undefined;
  const d = new Date(value as string | number | Date);
  return isNaN(d.getTime()) ? undefined : d;
}

export function formatReset(date: Date): string {
  if (isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins === 0) return "now";
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60),
    mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24),
    remainingHours = hours % 24;
  if (days < 7)
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return "";
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number },
): Promise<{ res: Response; data?: unknown }> {
  const { timeout = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    if (res.ok && res.status !== 204 && res.status !== 304) {
      const data = (await res.json()) as unknown;
      return { res, data };
    }
    return { res };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshGoogleToken(
  refreshToken: string,
  clientId?: string,
): Promise<{ accessToken: string; expiresAt?: number } | null> {
  const tryClientIds = clientId
    ? [clientId]
    : [undefined, GOOGLE_CLOUD_SHELL_CLIENT_ID];

  for (const candidateClientId of tryClientIds) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
    try {
      const params = new URLSearchParams({
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        normalizedClientId = candidateClientId?.trim();

      if (normalizedClientId) {
        params.set("client_id", normalizedClientId);
      }

      const res = await fetch(URLS.GOOGLE_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: controller.signal,
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) continue;

      return {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
    } catch {
      // Try next fallback candidate.
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}
