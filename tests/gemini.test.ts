import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGeminiUsage,
  nextMidnightPacific,
} from "../src/fetchers/gemini.js";

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

  it("should include resetsAt and resetDescription on windows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            buckets: [
              { modelId: "gemini-2.5-pro", remainingFraction: 0.8 },
              { modelId: "gemini-2.0-flash", remainingFraction: 0.5 },
            ],
          }),
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
          return undefined;
        },
      },
    };

    const snapshots = await fetchGeminiUsage(modelRegistry, {});
    const snapshot = snapshots.find((s) => s.account === "test-project");
    expect(snapshot).toBeDefined();
    expect(snapshot!.error).toBeUndefined();
    expect(snapshot!.windows.length).toBe(2);

    for (const w of snapshot!.windows) {
      expect(w.resetsAt).toBeInstanceOf(Date);
      expect(w.resetsAt!.getTime()).toBeGreaterThan(Date.now());
      expect(w.resetDescription).toBeDefined();
      expect(w.resetDescription!.length).toBeGreaterThan(0);
    }
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

describe("nextMidnightPacific", () => {
  it("returns a Date in the future", () => {
    const result = nextMidnightPacific();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns a time at most ~24h in the future", () => {
    const result = nextMidnightPacific();
    const diffMs = result.getTime() - Date.now();
    // Should be within 25 hours (to account for DST fall-back) + small tolerance
    expect(diffMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000 + 5000);
    expect(diffMs).toBeGreaterThan(0);
  });

  it("accepts a custom 'now' timestamp", () => {
    // 2025-06-15 10:00:00 UTC = 2025-06-15 03:00:00 PDT
    const now = new Date("2025-06-15T10:00:00Z");
    const result = nextMidnightPacific(now);
    expect(result).toBeInstanceOf(Date);
    // Next midnight Pacific is 2025-06-16 00:00:00 PDT = 2025-06-16 07:00:00 UTC
    expect(result.getTime()).toBeGreaterThan(now.getTime());

    // Verify it's approximately 21 hours later (03:00 -> 00:00 next day)
    const diffHours = (result.getTime() - now.getTime()) / (60 * 60 * 1000);
    expect(diffHours).toBeGreaterThan(20);
    expect(diffHours).toBeLessThan(22);
  });

  it("handles PST (winter) correctly", () => {
    // 2025-01-15 10:00:00 UTC = 2025-01-15 02:00:00 PST (UTC-8)
    const now = new Date("2025-01-15T10:00:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight PST = 2025-01-16 00:00:00 PST = 2025-01-16 08:00:00 UTC
    const expected = new Date("2025-01-16T08:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles PDT (summer) correctly", () => {
    // 2025-07-15 10:00:00 UTC = 2025-07-15 03:00:00 PDT (UTC-7)
    const now = new Date("2025-07-15T10:00:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight PDT = 2025-07-16 00:00:00 PDT = 2025-07-16 07:00:00 UTC
    const expected = new Date("2025-07-16T07:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles just before midnight Pacific", () => {
    // 2025-06-15 06:59:00 UTC = 2025-06-14 23:59:00 PDT
    const now = new Date("2025-06-15T06:59:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight PDT = 2025-06-15 00:00:00 PDT = 2025-06-15 07:00:00 UTC
    const expected = new Date("2025-06-15T07:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles just after midnight Pacific", () => {
    // 2025-06-15 07:01:00 UTC = 2025-06-15 00:01:00 PDT
    const now = new Date("2025-06-15T07:01:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight PDT = 2025-06-16 00:00:00 PDT = 2025-06-16 07:00:00 UTC
    const expected = new Date("2025-06-16T07:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles spring-forward DST transition (before the gap)", () => {
    // 2025-03-09 09:30:00 UTC = 2025-03-09 01:30:00 PST (before spring forward at 2:00 AM)
    // At 2:00 AM, clocks jump to 3:00 AM PDT
    const now = new Date("2025-03-09T09:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-03-10 00:00:00 PDT = 2025-03-10 07:00:00 UTC
    const expected = new Date("2025-03-10T07:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles spring-forward DST transition (after the gap)", () => {
    // 2025-03-09 10:30:00 UTC = 2025-03-09 03:30:00 PDT (after spring forward)
    const now = new Date("2025-03-09T10:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-03-10 00:00:00 PDT = 2025-03-10 07:00:00 UTC
    const expected = new Date("2025-03-10T07:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles fall-back DST transition (before the repeat hour)", () => {
    // 2025-11-02 07:30:00 UTC = 2025-11-02 00:30:00 PDT (before fall back at 2:00 AM)
    // At 2:00 AM PDT, clocks fall back to 1:00 AM PST
    const now = new Date("2025-11-02T07:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-11-03 00:00:00 PST = 2025-11-03 08:00:00 UTC
    const expected = new Date("2025-11-03T08:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles fall-back DST transition (after the repeat hour)", () => {
    // 2025-11-02 10:30:00 UTC = 2025-11-02 02:30:00 PST (after fall back)
    const now = new Date("2025-11-02T10:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-11-03 00:00:00 PST = 2025-11-03 08:00:00 UTC
    const expected = new Date("2025-11-03T08:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles first occurrence of repeated hour during fall-back", () => {
    // 2025-11-02 08:30:00 UTC = 2025-11-02 01:30:00 PDT (first 1:30 AM, PDT)
    const now = new Date("2025-11-02T08:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-11-03 00:00:00 PST = 2025-11-03 08:00:00 UTC
    const expected = new Date("2025-11-03T08:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("handles second occurrence of repeated hour during fall-back", () => {
    // 2025-11-02 09:30:00 UTC = 2025-11-02 01:30:00 PST (second 1:30 AM, PST)
    const now = new Date("2025-11-02T09:30:00Z");
    const result = nextMidnightPacific(now);
    // Next midnight is 2025-11-03 00:00:00 PST = 2025-11-03 08:00:00 UTC
    const expected = new Date("2025-11-03T08:00:00Z");
    expect(result.getTime()).toBe(expected.getTime());
  });
});
