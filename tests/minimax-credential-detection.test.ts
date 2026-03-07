import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/fetchers/common.js");

describe("Minimax credential detection", () => {
  const mockPiAuth = {
    minimax: {
      key: "sk-cp-test-key-123",
    },
  };

  const emptyPiAuth = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    delete process.env.MINIMAX_API_KEY;
  });

  it("detects credentials from piAuth.key", async () => {
    const { hasProviderCredential } = await import(
      "../src/credential-check.js"
    );

    const hasCreds = await hasProviderCredential(
      "minimax" as any,
      mockPiAuth,
      undefined,
    );

    expect(hasCreds).toBe(true);
  });

  it("detects credentials from piAuth.access", async () => {
    const piAuthWithAccess = {
      minimax: {
        access: "sk-cp-test-key-456",
      },
    };

    const { hasProviderCredential } = await import(
      "../src/credential-check.js"
    );

    const hasCreds = await hasProviderCredential(
      "minimax" as any,
      piAuthWithAccess,
      undefined,
    );

    expect(hasCreds).toBe(true);
  });

  it("detects credentials from MINIMAX_API_KEY env var", async () => {
    process.env.MINIMAX_API_KEY = "env-minimax-key-789";

    const { hasProviderCredential } = await import(
      "../src/credential-check.js"
    );

    const hasCreds = await hasProviderCredential(
      "minimax" as any,
      emptyPiAuth,
      undefined,
    );

    expect(hasCreds).toBe(true);
  });

  it("returns false when no credentials are found", async () => {
    const { hasProviderCredential } = await import(
      "../src/credential-check.js"
    );

    const hasCreds = await hasProviderCredential(
      "minimax" as any,
      emptyPiAuth,
      undefined,
    );

    expect(hasCreds).toBe(false);
  });

  it("returns false when piAuth.minimax exists but has no key/access", async () => {
    const piAuthEmpty = {
      minimax: {},
    };

    const { hasProviderCredential } = await import(
      "../src/credential-check.js"
    );

    const hasCreds = await hasProviderCredential(
      "minimax" as any,
      piAuthEmpty,
      undefined,
    );

    expect(hasCreds).toBe(false);
  });
});
