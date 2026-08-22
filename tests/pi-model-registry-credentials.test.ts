import { describe, expect, it, vi } from "vitest";
import { hasProviderCredential } from "../src/credential-check.js";

describe("current Pi model registry credential detection", () => {
  it("uses provider auth status before compatibility fallbacks", async () => {
    const getProviderAuthStatus = vi.fn(() => ({ configured: true }));

    await expect(
      hasProviderCredential("anthropic", {}, { getProviderAuthStatus }),
    ).resolves.toBe(true);
    expect(getProviderAuthStatus).toHaveBeenCalledWith("anthropic");
  });

  it("uses current provider key and auth resolution methods", async () => {
    const registry = {
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
      getApiKeyForProvider: vi.fn(async () => undefined),
      getProviderAuth: vi.fn(async (provider: string) =>
        provider === "openai-codex" ? { auth: { token: "oauth" } } : undefined,
      ),
    };

    await expect(hasProviderCredential("codex", {}, registry)).resolves.toBe(
      true,
    );
    expect(registry.getApiKeyForProvider).toHaveBeenCalledWith("openai-codex");
    expect(registry.getProviderAuth).toHaveBeenCalledWith("openai-codex");
  });
});
