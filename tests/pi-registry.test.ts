import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  getCatalogProviderIds,
  getProviderAuth,
  getProviderAuthStatus,
  getSelectableModels,
  getSelectableModelsAsync,
  isSelectableModel,
} from "../src/pi-registry.js";

function createContext(overrides: Record<string, unknown> = {}) {
  const available = [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "opencode-go", id: "kimi-k2.6" },
  ];
  const registry = {
    getAvailable: vi.fn(() => available),
    getAll: vi.fn(() => [...available, { provider: "zai", id: "glm-5" }]),
    getProviderAuthStatus: vi.fn(() => ({
      configured: true,
      source: "stored",
    })),
    getProviderAuth: vi.fn(async () => ({
      auth: { apiKey: "secret" },
      source: "OAuth",
    })),
  };

  return {
    modelRegistry: registry,
    scopedModels: [],
    ...overrides,
  } as unknown as ExtensionContext;
}

describe("Pi registry boundary", () => {
  it("prefers the session-scoped models when a scope is configured", () => {
    const scopedModels = [
      {
        model: { provider: "opencode-go", id: "kimi-k2.6" },
        thinkingLevel: "high",
      },
    ];
    const ctx = createContext({ scopedModels });

    expect(getSelectableModels(ctx)).toEqual([scopedModels[0]?.model]);
    expect(ctx.modelRegistry.getAvailable).not.toHaveBeenCalled();
  });

  it("uses Pi's authenticated model snapshot when no scope is configured", () => {
    const ctx = createContext();

    expect(getSelectableModels(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "opencode-go", id: "kimi-k2.6" },
    ]);
    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalledOnce();
  });

  it("supports async compatibility mocks when loading selectable models", async () => {
    const ctx = createContext({
      modelRegistry: {
        getAvailable: vi.fn(async () => [
          { provider: "opencode-go", id: "kimi-k2.6" },
        ]),
      },
    });

    await expect(getSelectableModelsAsync(ctx)).resolves.toEqual([
      { provider: "opencode-go", id: "kimi-k2.6" },
    ]);
  });

  it("derives provider IDs from Pi's complete model catalogue", () => {
    const ctx = createContext();

    expect(getCatalogProviderIds(ctx)).toEqual([
      "anthropic",
      "opencode-go",
      "zai",
    ]);
    expect(ctx.modelRegistry.getAll).toHaveBeenCalledOnce();
  });

  it("delegates provider auth status and request auth to Pi", async () => {
    const ctx = createContext();

    expect(getProviderAuthStatus(ctx, "anthropic")).toEqual({
      configured: true,
      source: "stored",
    });
    await expect(getProviderAuth(ctx, "anthropic")).resolves.toEqual({
      auth: { apiKey: "secret" },
      source: "OAuth",
    });
    expect(ctx.modelRegistry.getProviderAuthStatus).toHaveBeenCalledWith(
      "anthropic",
    );
    expect(ctx.modelRegistry.getProviderAuth).toHaveBeenCalledWith("anthropic");
  });

  it("checks model availability by provider and ID", () => {
    const ctx = createContext();

    expect(
      isSelectableModel(ctx, { provider: "opencode-go", id: "kimi-k2.6" }),
    ).toBe(true);
    expect(
      isSelectableModel(ctx, { provider: "opencode-go", id: "missing" }),
    ).toBe(false);
  });

  it("falls back to the registry lookup when an older host omits getAvailable", () => {
    const find = vi.fn((provider: string, id: string) => ({ provider, id }));
    const ctx = createContext({
      modelRegistry: { find },
    });

    expect(
      isSelectableModel(ctx, { provider: "opencode-go", id: "kimi-k2.6" }),
    ).toBe(true);
    expect(find).toHaveBeenCalledWith("opencode-go", "kimi-k2.6");
  });

  it("does not fall back to find when Pi reports an empty authenticated snapshot", () => {
    const find = vi.fn((provider: string, id: string) => ({ provider, id }));
    const ctx = createContext({
      modelRegistry: {
        getAvailable: vi.fn(() => []),
        find,
      },
    });

    expect(
      isSelectableModel(ctx, { provider: "opencode-go", id: "kimi-k2.6" }),
    ).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });
});
