import { fetchClaudeUsage } from "./fetchers/anthropic.js";
import { fetchAntigravityUsage } from "./fetchers/antigravity.js";
import { fetchAllCodexUsages } from "./fetchers/codex.js";
import { fetchCopilotUsage } from "./fetchers/copilot.js";
import { fetchGeminiUsage } from "./fetchers/gemini.js";
import { fetchKiroUsage } from "./fetchers/kiro.js";
import { fetchMinimaxUsage } from "./fetchers/minimax.js";
import { fetchOpenCodeGoUsage } from "./fetchers/opencode-go.js";
import { fetchZaiUsage } from "./fetchers/zai.js";
import type { MappingEntry, ProviderSettings, UsageSnapshot } from "./types.js";

/** Auth source used by a quota adapter. */
export type UsageProviderAuthMode = "pi" | "legacy" | "external";

/** Provider-specific quota source and its Pi model-provider associations. */
export interface UsageProviderAdapter {
  usageProvider: string;
  piProviderIds: readonly string[];
  authMode: UsageProviderAuthMode;
  fetch: (
    modelRegistry: unknown,
    piAuth: Record<string, unknown>,
    providerSettings?: ProviderSettings,
  ) => Promise<UsageSnapshot | UsageSnapshot[]>;
  isAvailable?: (
    modelRegistry: unknown,
    piAuth: Record<string, unknown>,
    providerSettings?: ProviderSettings,
  ) => boolean | Promise<boolean>;
  isUnavailable?: (snapshot: UsageSnapshot) => boolean;
}

const USAGE_PROVIDER_ADAPTERS: readonly UsageProviderAdapter[] = [
  {
    usageProvider: "anthropic",
    piProviderIds: ["anthropic"],
    authMode: "pi",
    fetch: (modelRegistry, piAuth) => fetchClaudeUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No credentials",
  },
  {
    usageProvider: "copilot",
    piProviderIds: ["github-copilot"],
    authMode: "legacy",
    fetch: (modelRegistry, piAuth) => fetchCopilotUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No token found",
  },
  {
    usageProvider: "gemini",
    piProviderIds: ["google-gemini-cli"],
    authMode: "external",
    fetch: (modelRegistry, piAuth) => fetchGeminiUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No credentials",
  },
  {
    usageProvider: "codex",
    piProviderIds: ["openai-codex"],
    authMode: "pi",
    fetch: (modelRegistry, piAuth) =>
      fetchAllCodexUsages(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No credentials",
  },
  {
    usageProvider: "antigravity",
    piProviderIds: [],
    authMode: "external",
    fetch: (modelRegistry, piAuth) =>
      fetchAntigravityUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No credentials",
  },
  {
    usageProvider: "kiro",
    piProviderIds: [],
    authMode: "external",
    fetch: () => fetchKiroUsage(),
    isUnavailable: (snapshot) =>
      snapshot.error === "kiro-cli not found" ||
      snapshot.error === "Not logged in",
  },
  {
    usageProvider: "zai",
    piProviderIds: ["zai", "zai-coding-cn"],
    authMode: "pi",
    fetch: (modelRegistry, piAuth) => fetchZaiUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No API key",
  },
  {
    usageProvider: "minimax",
    piProviderIds: ["minimax"],
    authMode: "pi",
    fetch: (modelRegistry, piAuth, providerSettings) =>
      fetchMinimaxUsage(
        piAuth,
        providerSettings?.minimax?.groupId,
        modelRegistry,
      ),
    isUnavailable: (snapshot) =>
      snapshot.error?.startsWith("No API key found") === true,
  },
  {
    usageProvider: "opencode-go",
    piProviderIds: ["opencode-go"],
    authMode: "pi",
    fetch: (modelRegistry, piAuth) =>
      fetchOpenCodeGoUsage(modelRegistry, piAuth),
    isUnavailable: (snapshot) => snapshot.error === "No API key",
  },
];

/** Returns every supported quota adapter for wizard discovery. */
export function getUsageProviderAdapters(): readonly UsageProviderAdapter[] {
  return USAGE_PROVIDER_ADAPTERS;
}

/** Returns quota adapters referenced by the configured usage mappings. */
export function getUsageProviderAdaptersForMappings(
  mappings: readonly MappingEntry[],
): UsageProviderAdapter[] {
  const mappedProviders = new Set(
    mappings.map((mapping) => mapping.usage.provider),
  );
  return USAGE_PROVIDER_ADAPTERS.filter((adapter) =>
    mappedProviders.has(adapter.usageProvider),
  );
}

/** Finds a quota adapter by its usage-provider ID. */
export function getUsageProviderAdapter(
  usageProvider: string,
): UsageProviderAdapter | undefined {
  return USAGE_PROVIDER_ADAPTERS.find(
    (adapter) => adapter.usageProvider === usageProvider,
  );
}

/** Returns whether a snapshot represents an expected unavailable source. */
export function isUnavailableUsageSnapshot(snapshot: UsageSnapshot): boolean {
  return (
    getUsageProviderAdapter(snapshot.provider)?.isUnavailable?.(snapshot) ??
    false
  );
}
