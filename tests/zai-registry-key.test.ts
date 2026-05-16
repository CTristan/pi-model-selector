import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZaiUsage } from "../src/fetchers/zai.js";

describe("fetchZaiUsage registry key resolution", () => {
  const originalZaiKey = process.env.Z_AI_API_KEY;

  beforeEach(() => {
    delete process.env.Z_AI_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 1,
                number: 7,
                percentage: 50,
                nextResetTime: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalZaiKey !== undefined) {
      process.env.Z_AI_API_KEY = originalZaiKey;
    } else {
      delete process.env.Z_AI_API_KEY;
    }
  });

  it("uses registry authStorage.getApiKey('zai') when available", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("registry-zai-key"),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await fetchZaiUsage(modelRegistry, {});

    expect(result.provider).toBe("zai");
    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("Pro");
    // Registry key was used (no error about missing key)
    expect(modelRegistry.authStorage.getApiKey).toHaveBeenCalledWith("zai");
  });

  it("trims whitespace from registry key", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("  registry-key-with-spaces  "),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await fetchZaiUsage(modelRegistry, {});
    expect(result.error).toBeUndefined();
    expect(result.windows).toHaveLength(1);
  });

  it("falls back to piAuth when registry returns undefined", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };
    const piAuth = { "z-ai": { access: "piauth-key" } };

    const result = await fetchZaiUsage(modelRegistry, piAuth);

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe("zai");
  });

  it("falls back to piAuth when registry returns empty string", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("   "),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };
    const piAuth = { zai: { access: "piauth-zai-key" } };

    const result = await fetchZaiUsage(modelRegistry, piAuth);
    expect(result.error).toBeUndefined();
  });

  it("falls back to piAuth when registry authStorage.getApiKey throws", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockRejectedValue(new Error("auth storage error")),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };
    const piAuth = { "z-ai": { key: "piauth-fallback-key" } };

    const result = await fetchZaiUsage(modelRegistry, piAuth);
    expect(result.error).toBeUndefined();
  });

  it("returns no-key error when registry returns empty and piAuth has no key", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await fetchZaiUsage(modelRegistry, {});
    expect(result.error).toBe("No API key");
    expect(result.windows).toHaveLength(0);
  });

  it("prefers env var over registry key", async () => {
    process.env.Z_AI_API_KEY = "env-key-takes-priority";
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("registry-key"),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await fetchZaiUsage(modelRegistry, {});

    // Env var is used; registry is NOT consulted at all because env check short-circuits
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe("zai");
    // Registry should not have been called because env var short-circuits early
    expect(modelRegistry.authStorage.getApiKey).not.toHaveBeenCalled();
  });

  it("works with no modelRegistry argument (default empty object)", async () => {
    const piAuth = { zai: { access: "default-key" } };
    const result = await fetchZaiUsage(undefined, piAuth);
    expect(result.error).toBeUndefined();
  });

  it("handles missing authStorage gracefully (registry without authStorage)", async () => {
    const modelRegistry = {}; // No authStorage

    const piAuth = { "z-ai": { access: "piauth-key-no-registry" } };
    const result = await fetchZaiUsage(modelRegistry, piAuth);
    expect(result.error).toBeUndefined();
  });
});
