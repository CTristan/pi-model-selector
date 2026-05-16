const RECOMMENDED_MODEL_PROVIDERS_BY_USAGE_PROVIDER: Readonly<
  Record<string, readonly string[]>
> = {
  antigravity: ["google"],
  codex: ["openai-codex"],
  copilot: ["github-copilot"],
  gemini: ["google"],
  kiro: ["google"],
  zai: ["openai"],
};

function normalizeProvider(provider: string): string {
  return provider.trim();
}

/**
 * Returns recommended model providers for a specific usage provider.
 */
export function getRecommendedModelProvidersForUsageProvider(
  usageProvider: string,
): string[] {
  const normalizedUsageProvider = normalizeProvider(usageProvider);
  if (normalizedUsageProvider.length === 0) return [];

  const recommendedProviders =
    RECOMMENDED_MODEL_PROVIDERS_BY_USAGE_PROVIDER[normalizedUsageProvider] ??
    [];

  return Array.from(
    new Set([
      normalizedUsageProvider,
      ...recommendedProviders
        .map(normalizeProvider)
        .filter((provider) => provider.length > 0),
    ]),
  );
}

/**
 * Sorts a list of models to prefer those with the given usage provider.
 */
export function sortModelsForUsageProvider<
  T extends { provider: string; id: string },
>(models: readonly T[], usageProvider: string): T[] {
  const recommendedProviders =
    getRecommendedModelProvidersForUsageProvider(usageProvider);
  const providerRanks = new Map(
    recommendedProviders.map((provider, index) => [provider, index]),
  );

  return [...models].sort((a, b) => {
    const rankA = providerRanks.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
    const rankB = providerRanks.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;

    const providerOrder = a.provider.localeCompare(b.provider);
    if (providerOrder !== 0) return providerOrder;

    return a.id.localeCompare(b.id);
  });
}
