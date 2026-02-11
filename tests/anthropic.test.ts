import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchClaudeUsage } from "../src/fetchers/anthropic.js";

describe("Anthropic Usage Fetcher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Window Logic", () => {
    it("should return both 5h and Week windows when both are present in API response", async () => {
      const mockResponse = {
        five_hour: {
          utilization: 0.8,
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 0.1,
          resets_at: new Date(Date.now() + 7200 * 1000).toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      expect(result.windows).toHaveLength(3);

      const labels = result.windows.map((w) => w.label);
      expect(labels).toContain("5h");
      expect(labels).toContain("Week");
      expect(labels).toContain("Shared");

      // 5h and Week should reflect RAW utilization
      expect(result.windows.find((w) => w.label === "5h")?.usedPercent).toBe(
        80,
      );
      expect(result.windows.find((w) => w.label === "Week")?.usedPercent).toBe(
        10,
      );
      // Shared should reflect pessimistic utilization (max of 0.8 and 0.1 => 80%)
      expect(
        result.windows.find((w) => w.label === "Shared")?.usedPercent,
      ).toBe(80);
    });

    it("should return 5h and Shared windows if Week is missing", async () => {
      const mockResponse = {
        five_hour: {
          utilization: 0.5,
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      expect(result.windows).toHaveLength(2);
      expect(result.windows.map((w) => w.label)).toContain("5h");
      expect(result.windows.map((w) => w.label)).toContain("Shared");
    });

    it("should return Week and Shared windows if 5h is missing", async () => {
      const mockResponse = {
        seven_day: {
          utilization: 0.5,
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      expect(result.windows).toHaveLength(2);
      expect(result.windows.map((w) => w.label)).toContain("Week");
      expect(result.windows.map((w) => w.label)).toContain("Shared");
    });

    it("should handle missing utilization gracefully (not return NaN)", async () => {
      const mockResponse = {
        five_hour: {
          // utilization missing
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 0.1,
          resets_at: new Date(Date.now() + 7200 * 1000).toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      const fiveH = result.windows.find((w) => w.label === "5h");
      expect(fiveH?.usedPercent).not.toBeNaN();
      expect(fiveH?.usedPercent).toBe(0);

      const week = result.windows.find((w) => w.label === "Week");
      expect(week?.usedPercent).toBe(10);

      const shared = result.windows.find((w) => w.label === "Shared");
      expect(shared?.usedPercent).toBe(10); // max(0, 0.1) * 100
    });

    it("should retain reset time in Shared window even if utilization is 0", async () => {
      const futureDate = new Date(Date.now() + 3600 * 1000);
      const laterDate = new Date(Date.now() + 7200 * 1000);
      const mockResponse = {
        five_hour: {
          utilization: 0,
          resets_at: futureDate.toISOString(),
        },
        seven_day: {
          utilization: 0,
          resets_at: laterDate.toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      const shared = result.windows.find((w) => w.label === "Shared");
      expect(shared?.usedPercent).toBe(0);
      expect(shared?.resetsAt).toBeDefined();
      // It should pick the latest reset time by default if utilization is equal (both 0)
      expect(shared?.resetsAt?.getTime()).toBe(laterDate.getTime());
    });
  });

  describe("Reset Logic", () => {
    it("should align globalResetsAt with the limiting window (5h limit hit)", async () => {
      const mockResponse = {
        five_hour: {
          utilization: 1.0,
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        }, // 1 hour
        seven_day: {
          utilization: 0.1,
          resets_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        }, // 5 days
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      const sharedWindow = result.windows.find((w) => w.label === "Shared");
      const resetsAt = sharedWindow?.resetsAt;
      const expectedReset = new Date(mockResponse.five_hour.resets_at);

      expect(resetsAt).toEqual(expectedReset);
    });

    it("should align globalResetsAt with the limiting window (7d limit hit)", async () => {
      const mockResponse = {
        five_hour: {
          utilization: 0.2,
          resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        seven_day: {
          utilization: 0.9,
          resets_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      const sharedWindow = result.windows.find((w) => w.label === "Shared");
      const resetsAt = sharedWindow?.resetsAt;
      const expectedReset = new Date(mockResponse.seven_day.resets_at);

      expect(resetsAt).toEqual(expectedReset);
    });

    it("should pick the latest reset time for Sonnet window among limiting windows", async () => {
      const now = Date.now();
      const mockResponse = {
        five_hour: {
          utilization: 0.8,
          resets_at: new Date(now + 3600 * 1000).toISOString(),
        }, // 1 hour
        seven_day_sonnet: {
          utilization: 0.8,
          resets_at: new Date(now + 1800 * 1000).toISOString(),
        }, // 0.5 hour
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "fake-token" },
      });

      const sonnet = result.windows.find((w) => w.label === "Sonnet");
      // Both have 0.8 utilization, so it should pick the LATEST reset (the 1 hour one from five_hour)
      expect(sonnet?.resetsAt?.getTime()).toBe(now + 3600 * 1000);
    });
  });

  describe("Error Handling", () => {
    it("should include account in error snapshot when an error is thrown", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network failure")),
      );

      const piAuth = {
        anthropic: { token: "test-token" },
      };

      const snapshot = await fetchClaudeUsage(undefined, piAuth);
      expect(snapshot.error).toContain("Network failure");
      expect(snapshot.account).toBe("auth.json");
    });

    it("should continue to next token on 429 error", async () => {
      const piAuth = {
        anthropic: { token: "token1" },
      };
      const modelRegistry = {
        authStorage: {
          getApiKey: () => "token2",
          get: () => ({ token: "token2" }),
        },
      };

      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: false,
              status: 429,
              json: () => Promise.resolve({}),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                five_hour: { utilization: 0.1 },
              }),
          });
        }),
      );

      const result = await fetchClaudeUsage(modelRegistry, piAuth);

      expect(callCount).toBe(2);
      expect(result.error).toBeUndefined();
      expect(result.windows.length).toBeGreaterThan(0);
    });
  });

  describe("Argument Reinterpretation", () => {
    it("should correctly handle legacy 1-arg call path fetchClaudeUsage(piAuth)", async () => {
      const mockResponse = {
        five_hour: { utilization: 0.5 },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      // Legacy call: first arg is piAuth, second is missing/empty
      const piAuth = {
        anthropic: { access: "legacy-token" },
      };

      const result = await fetchClaudeUsage(piAuth);

      expect(result.account).toBe("auth.json");
      expect(result.windows.length).toBeGreaterThan(0);

      // Verify that fetch was called with the legacy token
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            Authorization: "Bearer legacy-token",
          }),
        }),
      );
    });

    it("should NOT reinterpret if first arg looks like modelRegistry", async () => {
      const mockResponse = {
        five_hour: { utilization: 0.5 },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const modelRegistry = {
        authStorage: {
          getApiKey: () => "registry-token",
        },
      };

      const result = await fetchClaudeUsage(modelRegistry);

      expect(result.account).toBe("registry:anthropic:apiKey");
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            Authorization: "Bearer registry-token",
          }),
        }),
      );
    });
  });
});
