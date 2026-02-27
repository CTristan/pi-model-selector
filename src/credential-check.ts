import type { ProviderName } from "./types.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Claude",
  copilot: "Copilot",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  zai: "z.ai",
};

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

export async function hasProviderCredential(
  provider: ProviderName,
  piAuth: Record<string, unknown>,
  modelRegistry?: {
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
  },
): Promise<boolean> {
  // Check environment variables
  if (provider === "antigravity") {
    if (isNonEmptyString(process.env.ANTIGRAVITY_API_KEY)) return true;
  }

  // Check authStorage for applicable providers
  if (modelRegistry?.authStorage) {
    try {
      if (provider === "copilot") {
        const [githubCopilotKey, githubKey, githubCopilotData, githubData] =
          await Promise.all([
            modelRegistry.authStorage.getApiKey?.("github-copilot"),
            modelRegistry.authStorage.getApiKey?.("github"),
            modelRegistry.authStorage.get?.("github-copilot"),
            modelRegistry.authStorage.get?.("github"),
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
            modelRegistry.authStorage.getApiKey?.("google-gemini"),
            modelRegistry.authStorage.getApiKey?.("google-gemini-cli"),
            modelRegistry.authStorage.get?.("google-gemini"),
            modelRegistry.authStorage.get?.("google-gemini-cli"),
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
          modelRegistry.authStorage.getApiKey?.("google-antigravity"),
          modelRegistry.authStorage.get?.("google-antigravity"),
        ]);

        if (
          isNonEmptyString(antigravityKey) ||
          hasTokenPayload(antigravityData)
        ) {
          return true;
        }
      }

      if (provider === "anthropic") {
        const anthropicKey =
          await modelRegistry.authStorage.getApiKey?.("anthropic");
        const anthropicData =
          await modelRegistry.authStorage.get?.("anthropic");

        if (isNonEmptyString(anthropicKey) || hasTokenPayload(anthropicData)) {
          return true;
        }
      }
    } catch {
      // Ignore registry access errors
    }
  }

  // Check piAuth for applicable providers
  if (provider === "zai") {
    // Need to import resolveZaiApiKey
    const { resolveZaiApiKey } = await import("./fetchers/zai.js");
    if (resolveZaiApiKey(piAuth)) return true;
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
