import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchClaudeUsage } from "../src/fetchers/anthropic.js";

describe("Anthropic Window Logic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    const result = await fetchClaudeUsage({
      anthropic: { access: "fake-token" },
    });

    expect(result.windows).toHaveLength(3);

    const labels = result.windows.map((w) => w.label);
    expect(labels).toContain("5h");
    expect(labels).toContain("Week");
    expect(labels).toContain("Shared");

    // 5h and Week should reflect RAW utilization
    expect(result.windows.find((w) => w.label === "5h")?.usedPercent).toBe(80);
    expect(result.windows.find((w) => w.label === "Week")?.usedPercent).toBe(
      10,
    );
    // Shared should reflect pessimistic utilization (max of 0.8 and 0.1 => 80%)
    expect(result.windows.find((w) => w.label === "Shared")?.usedPercent).toBe(
      80,
    );
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

    const result = await fetchClaudeUsage({
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

    const result = await fetchClaudeUsage({
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

    const result = await fetchClaudeUsage({
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

    const result = await fetchClaudeUsage({
      anthropic: { access: "fake-token" },
    });

    const shared = result.windows.find((w) => w.label === "Shared");
    expect(shared?.usedPercent).toBe(0);
    expect(shared?.resetsAt).toBeDefined();
    // It should pick the latest reset time by default if utilization is equal (both 0)
    expect(shared?.resetsAt?.getTime()).toBe(laterDate.getTime());
  });
});
