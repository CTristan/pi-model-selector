import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllCodexUsages } from "../src/fetchers/codex.js";
import { resetGlobalState } from "../src/types.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: { ...actual.promises, readdir: vi.fn(), stat: vi.fn() },
  };
});

describe("Codex same-account fallback credentials", () => {
  beforeEach(() => {
    process.env.CODEX_HOME = "/tmp/no-such-codex-home";
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error("not found"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CODEX_HOME;
    resetGlobalState();
  });

  it("tries fallback token when first token for same accountId is expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            rate_limit: { primary_window: { used_percent: 10 } },
          }),
        }),
    );

    const results = await fetchAllCodexUsages(
      {},
      {
        "openai-codex": {
          access: "expired-token",
          accountId: "acct-1",
        },
        "openai-codex-work": {
          access: "valid-token",
          accountId: "acct-1",
        },
      },
    );

    const successResult = results.find((r) => !r.error);
    expect(successResult).toBeDefined();
    expect(successResult!.windows).toHaveLength(1);
  });

  it("still deduplicates identical access tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: { primary_window: { used_percent: 10 } },
        }),
      }),
    );

    const results = await fetchAllCodexUsages(
      {},
      {
        "openai-codex": {
          access: "same-token",
          accountId: "acct-1",
        },
        "openai-codex-work": {
          access: "same-token",
          accountId: "acct-2",
        },
      },
    );

    expect(results).toHaveLength(1);
  });
});
