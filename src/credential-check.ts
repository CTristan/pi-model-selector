import { resolveMinimaxApiKey } from "./fetchers/minimax.js";
import { resolveZaiApiKey } from "./fetchers/zai.js";
import type { ProviderName } from "./types.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Claude",
  copilot: "Copilot",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  zai: "z.ai",
  minimax: "Minimax",
};

/**
 * A map of provider names to their human-readable display labels.
 */
export { PROVIDER_LABELS };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasTokenPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    record.access,
    record.accessToken,
    record.token,
    record.refresh,
    record.key,
  ].some(isNonEmptyString);
}

/**
 * Checks if a provider has valid credentials available via environment variables,
 * model registry storage, or user authentication configuration.
 * @param provider The name of the provider.
 * @param piAuth The user's Pi authentication configuration.
 * @param modelRegistry The optional registry containing authentication storage.
 * @returns A promise resolving to true if credentials exist, false otherwise.
 */
export async function hasProviderCredential(
  provider: ProviderName,
  piAuth: Record<string, unknown>,
  modelRegistry?: unknown,
): Promise<boolean> {
  const registry = modelRegistry as
    | {
        getProviderAuthStatus?: (id: string) => { configured: boolean };
        getProviderAuth?: (id: string) => Promise<unknown>;
        getApiKeyForProvider?: (id: string) => Promise<string | undefined>;
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
      }
    | undefined;

  // Check environment variables
  if (provider === "antigravity") {
    if (isNonEmptyString(process.env.ANTIGRAVITY_API_KEY)) return true;
  }

  // Prefer the public current-Pi registry API. Check host provider aliases
  // because quota provider names do not always match registry provider ids.
  const registryProviderAliases: Record<ProviderName, string[]> = {
    anthropic: ["anthropic"],
    copilot: ["github-copilot", "github"],
    gemini: ["google-gemini", "google-gemini-cli"],
    codex: ["openai-codex"],
    antigravity: ["google-antigravity"],
    kiro: ["kiro"],
    zai: ["zai"],
    minimax: ["minimax"],
  };
  for (const providerId of registryProviderAliases[provider]) {
    try {
      if (registry?.getProviderAuthStatus?.(providerId).configured) return true;
      const [apiKey, auth] = await Promise.all([
        registry?.getApiKeyForProvider?.(providerId),
        registry?.getProviderAuth?.(providerId),
      ]);
      if (isNonEmptyString(apiKey) || auth !== undefined) return true;
    } catch {
      // Continue through aliases and compatibility fallbacks.
    }
  }

  // OMP exposes its credential store structurally as authStorage.
  if (registry?.authStorage) {
    try {
      if (provider === "copilot") {
        const [githubCopilotKey, githubKey, githubCopilotData, githubData] =
          await Promise.all([
            registry.authStorage.getApiKey?.("github-copilot"),
            registry.authStorage.getApiKey?.("github"),
            registry.authStorage.get?.("github-copilot"),
            registry.authStorage.get?.("github"),
          ]);

        if (
          isNonEmptyString(githubCopilotKey) ||
          isNonEmptyString(githubKey) ||
          hasTokenPayload(githubCopilotData) ||
          hasTokenPayload(githubData)
        ) {
          return true;
        }
      }

      if (provider === "gemini") {
        const [geminiKey, geminiCliKey, geminiData, geminiCliData] =
          await Promise.all([
            registry.authStorage.getApiKey?.("google-gemini"),
            registry.authStorage.getApiKey?.("google-gemini-cli"),
            registry.authStorage.get?.("google-gemini"),
            registry.authStorage.get?.("google-gemini-cli"),
          ]);

        if (
          isNonEmptyString(geminiKey) ||
          isNonEmptyString(geminiCliKey) ||
          hasTokenPayload(geminiData) ||
          hasTokenPayload(geminiCliData)
        ) {
          return true;
        }
      }

      if (provider === "antigravity") {
        const [antigravityKey, antigravityData] = await Promise.all([
          registry.authStorage.getApiKey?.("google-antigravity"),
          registry.authStorage.get?.("google-antigravity"),
        ]);

        if (
          isNonEmptyString(antigravityKey) ||
          hasTokenPayload(antigravityData)
        ) {
          return true;
        }
      }

      if (provider === "codex") {
        const codexKey = await registry.authStorage.getApiKey?.("openai-codex");
        const codexData = await registry.authStorage.get?.("openai-codex");

        if (isNonEmptyString(codexKey) || hasTokenPayload(codexData)) {
          return true;
        }
      }

      if (provider === "anthropic") {
        const anthropicKey =
          await registry.authStorage.getApiKey?.("anthropic");
        const anthropicData = await registry.authStorage.get?.("anthropic");

        if (isNonEmptyString(anthropicKey) || hasTokenPayload(anthropicData)) {
          return true;
        }
      }

      if (provider === "zai") {
        const registryKey = await registry.authStorage.getApiKey?.("zai");
        if (isNonEmptyString(registryKey) || resolveZaiApiKey(piAuth)) {
          return true;
        }
      }
    } catch {
      // Ignore registry access errors
    }
  }

  if (provider === "zai" && resolveZaiApiKey(piAuth)) {
    return true;
  }

  if (provider === "minimax" && resolveMinimaxApiKey(piAuth)) {
    return true;
  }

  if (provider === "codex") {
    return Object.entries(piAuth).some(([authProvider, payload]) => {
      return (
        authProvider.startsWith("openai-codex") && hasTokenPayload(payload)
      );
    });
  }

  if (provider === "antigravity") {
    if (
      hasTokenPayload(
        piAuth["google-antigravity"] ??
          piAuth.antigravity ??
          piAuth["anti-gravity"],
      )
    )
      return true;
  }

  // For remaining providers (anthropic, copilot, gemini, kiro), check piAuth aliases
  const providerAliases: Record<string, string[]> = {
    anthropic: ["anthropic"],
    copilot: ["github-copilot", "copilot", "github"],
    gemini: ["google-gemini", "google-gemini-cli", "gemini"],
    kiro: ["kiro"],
  };

  const aliases = providerAliases[provider];
  if (!aliases) return false;

  return aliases.some((alias) => hasTokenPayload(piAuth[alias]));
}
