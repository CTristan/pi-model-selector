import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A model exposed by Pi's current catalogue. */
export type PiModel = NonNullable<ExtensionContext["model"]>;

/** Resolved provider request authentication returned by Pi. */
export interface PiProviderAuth {
  auth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
  };
  env?: Record<string, string>;
  source?: string;
}

/** Side-effect-free provider authentication status returned by Pi. */
export interface PiProviderAuthStatus {
  configured: boolean;
  source?: string;
  label?: string;
}

type ScopedModelContext = ExtensionContext & {
  scopedModels?: readonly { model: PiModel }[];
};

type RegistryCompatibility = ExtensionContext["modelRegistry"] & {
  getAvailable?: () => readonly PiModel[] | Promise<readonly PiModel[]>;
  getAll?: () => readonly PiModel[];
  getProviderAuthStatus?: (providerId: string) => PiProviderAuthStatus;
  getProviderAuth?: (providerId: string) => Promise<PiProviderAuth | undefined>;
};

function getScopedModels(ctx: ExtensionContext): PiModel[] | undefined {
  const scopedModels = (ctx as ScopedModelContext).scopedModels;
  if (!scopedModels || scopedModels.length === 0) return undefined;
  return scopedModels.map(({ model }) => model);
}

function getAvailableModelSnapshot(
  ctx: ExtensionContext,
): PiModel[] | undefined {
  const registry = ctx.modelRegistry as RegistryCompatibility;
  if (typeof registry.getAvailable !== "function") return undefined;
  const available = registry.getAvailable();
  return Array.isArray(available) ? [...available] : undefined;
}

/** Returns the models Pi allows the current session to select. */
export function getSelectableModels(ctx: ExtensionContext): PiModel[] {
  return getScopedModels(ctx) ?? getAvailableModelSnapshot(ctx) ?? [];
}

/** Loads selectable models through Pi's sync or compatibility API. */
export async function getSelectableModelsAsync(
  ctx: ExtensionContext,
): Promise<PiModel[]> {
  const scopedModels = getScopedModels(ctx);
  if (scopedModels) return scopedModels;

  const registry = ctx.modelRegistry as RegistryCompatibility;
  if (typeof registry.getAvailable !== "function") return [];
  const available = await Promise.resolve(registry.getAvailable());
  return Array.isArray(available) ? [...available] : [];
}

/** Returns the provider IDs present in Pi's complete model catalogue. */
export function getCatalogProviderIds(ctx: ExtensionContext): string[] {
  const registry = ctx.modelRegistry as RegistryCompatibility;
  if (typeof registry.getAll !== "function") return [];
  return [...new Set(registry.getAll().map((model) => model.provider))];
}

/** Returns Pi's current side-effect-free authentication status for a provider. */
export function getProviderAuthStatus(
  ctx: ExtensionContext,
  providerId: string,
): PiProviderAuthStatus {
  const registry = ctx.modelRegistry as RegistryCompatibility;
  return registry.getProviderAuthStatus?.(providerId) ?? { configured: false };
}

/** Resolves provider request authentication through Pi's public registry API. */
export async function getProviderAuth(
  ctx: ExtensionContext,
  providerId: string,
): Promise<PiProviderAuth | undefined> {
  return await getProviderAuthFromRegistry(ctx.modelRegistry, providerId);
}

/** Resolves provider auth from a registry-like host object. */
export async function getProviderAuthFromRegistry(
  modelRegistry: unknown,
  providerId: string,
): Promise<PiProviderAuth | undefined> {
  if (!modelRegistry || typeof modelRegistry !== "object") return undefined;
  const registry = modelRegistry as RegistryCompatibility;
  if (typeof registry.getProviderAuth !== "function") return undefined;
  return await registry.getProviderAuth(providerId);
}

function findModelInList(
  models: readonly PiModel[],
  providerId: string,
  modelId: string,
): PiModel | undefined {
  return models.find(
    (model) => model.provider === providerId && model.id === modelId,
  );
}

function findByRegistryLookup(
  ctx: ExtensionContext,
  providerId: string,
  modelId: string,
): PiModel | undefined {
  const finder = (
    ctx.modelRegistry as RegistryCompatibility & {
      find?: (provider: string, modelId: string) => PiModel | undefined;
    }
  ).find;
  return typeof finder === "function"
    ? finder.call(ctx.modelRegistry, providerId, modelId)
    : undefined;
}

/** Finds a selectable model by exact provider and model ID. */
export function findSelectableModel(
  ctx: ExtensionContext,
  providerId: string,
  modelId: string,
): PiModel | undefined {
  const scopedModels = getScopedModels(ctx);
  if (scopedModels) {
    return findModelInList(scopedModels, providerId, modelId);
  }

  const availableModels = getAvailableModelSnapshot(ctx);
  if (availableModels) {
    return findModelInList(availableModels, providerId, modelId);
  }

  return findByRegistryLookup(ctx, providerId, modelId);
}

/**
 * Finds a selectable model, awaiting Promise-returning `getAvailable()` hosts.
 * Falls back to `find()` only when `getAvailable` is absent.
 */
export async function findSelectableModelAsync(
  ctx: ExtensionContext,
  providerId: string,
  modelId: string,
): Promise<PiModel | undefined> {
  const scopedModels = getScopedModels(ctx);
  if (scopedModels) {
    return findModelInList(scopedModels, providerId, modelId);
  }

  const registry = ctx.modelRegistry as RegistryCompatibility;
  if (typeof registry.getAvailable === "function") {
    const available = await Promise.resolve(registry.getAvailable());
    const availableModels = Array.isArray(available)
      ? [...available]
      : undefined;
    if (availableModels) {
      return findModelInList(availableModels, providerId, modelId);
    }
    return undefined;
  }

  return findByRegistryLookup(ctx, providerId, modelId);
}

/** Returns whether Pi can select the exact provider and model ID. */
export function isSelectableModel(
  ctx: ExtensionContext,
  model: { provider: string; id: string },
): boolean {
  return findSelectableModel(ctx, model.provider, model.id) !== undefined;
}
