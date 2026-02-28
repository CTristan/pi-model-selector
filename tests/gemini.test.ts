import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGeminiUsage } from "../src/fetchers/gemini.js";

describe("Gemini Usage Fetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should handle expiresAt: 0 correctly in merging", async () => {
    // Mock fetch for the initial usage fetch
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ buckets: [] }),
      }),
    );

    const modelRegistry = {
      authStorage: {
        get: (id: string) => {
          if (id === "google-gemini") {
            return {
              accessToken: "valid-token",
              projectId: "test-project",
              expiresAt: 0, // Should be treated as a valid expiration time, not falsy
            };
          }
          return undefined;
        },
      },
    };

    const snapshots = await fetchGeminiUsage(modelRegistry, {});
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.provider).toBe("gemini");
    expect(snapshots[0]!.account).toBe("test-project");
  });

  it("should suppress anonymous errors when single account succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              buckets: [],
            }),
        });
      }),
    );

    const modelRegistry = {
      authStorage: {
        get: (id: string) => {
          if (id === "google-gemini") {
            return {
              accessToken: "valid-token",
              projectId: "test-project",
            };
          }
          if (id === "google-ai-platform") {
            return {
              accessToken: "invalid-token",
              clientId: "client-id",
              clientSecret: "client-secret",
            };
          }
          return undefined;
        },
      },
    };

    const snapshots = await fetchGeminiUsage(modelRegistry, {});
    // Should have at least one successful snapshot (test-project)
    expect(snapshots.length).toBeGreaterThan(0);
    const testProjectSnapshot = snapshots.find(
      (s) => s.account === "test-project",
    );
    expect(testProjectSnapshot).toBeDefined();
    expect(testProjectSnapshot?.error).toBeUndefined();
  });
});
