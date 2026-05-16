import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasProviderCredential } from "../src/credential-check.js";

describe("hasProviderCredential — codex authStorage branch (new in PR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when authStorage.getApiKey('openai-codex') returns a non-empty key", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("codex-api-key-123"),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(true);
    expect(modelRegistry.authStorage.getApiKey).toHaveBeenCalledWith(
      "openai-codex",
    );
  });

  it("returns true when authStorage.get('openai-codex') returns an object with access token", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ access: "codex-access-token" }),
      },
    };

    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(true);
    expect(modelRegistry.authStorage.get).toHaveBeenCalledWith("openai-codex");
  });

  it("returns true when authStorage.get('openai-codex') returns an object with accessToken field", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ accessToken: "codex-bearer-token" }),
      },
    };

    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(true);
  });

  it("falls through to piAuth check when registry returns empty for codex", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(""),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    // piAuth has no openai-codex keys
    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(false);
  });

  it("returns true when piAuth has openai-codex key after registry returns nothing", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const piAuth = {
      "openai-codex": { access: "piauth-codex-token" },
    };

    const result = await hasProviderCredential("codex", piAuth, modelRegistry);
    expect(result).toBe(true);
  });

  it("returns true when piAuth has openai-codex-secondary key after registry returns nothing", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const piAuth = {
      "openai-codex-secondary": { access: "secondary-codex-token" },
    };

    const result = await hasProviderCredential("codex", piAuth, modelRegistry);
    expect(result).toBe(true);
  });

  it("returns false when both registry and piAuth have no codex credentials", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(false);
  });

  it("falls through to piAuth check when registry throws", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockRejectedValue(new Error("auth storage error")),
        get: vi.fn().mockRejectedValue(new Error("auth storage error")),
      },
    };

    const piAuth = {
      "openai-codex": { access: "piauth-fallback-token" },
    };

    // Should not throw, and should return true via piAuth
    const result = await hasProviderCredential("codex", piAuth, modelRegistry);
    expect(result).toBe(true);
  });

  it("returns false when registry throws and piAuth has no codex credentials", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        get: vi.fn().mockRejectedValue(new Error("storage unavailable")),
      },
    };

    const result = await hasProviderCredential("codex", {}, modelRegistry);
    expect(result).toBe(false);
  });

  it("returns true for codex without modelRegistry (only piAuth)", async () => {
    const piAuth = {
      "openai-codex": { access: "standalone-codex-token" },
    };

    const result = await hasProviderCredential("codex", piAuth);
    expect(result).toBe(true);
  });

  it("returns false for codex without modelRegistry and no piAuth key", async () => {
    const result = await hasProviderCredential("codex", {});
    expect(result).toBe(false);
  });

  it("codex check only consults 'openai-codex' id in authStorage (not other ids)", async () => {
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    await hasProviderCredential("codex", {}, modelRegistry);

    const getApiKeyCalls = modelRegistry.authStorage.getApiKey.mock.calls.map(
      (c) => c[0],
    );
    expect(getApiKeyCalls).toContain("openai-codex");
    // Codex check should only use the openai-codex id
    expect(getApiKeyCalls.every((id) => id === "openai-codex")).toBe(true);
  });
});