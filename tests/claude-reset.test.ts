import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchClaudeUsage } from "../src/usage-fetchers.js";

describe("fetchClaudeUsage Logic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    const result = await fetchClaudeUsage({
      anthropic: { access: "fake-token" },
    });

    expect(result.windows).toBeDefined();
    expect(result.windows.length).toBeGreaterThan(0);

    // Find the Shared or pessimistic window
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

    const result = await fetchClaudeUsage({
      anthropic: { access: "fake-token" },
    });

    const sharedWindow = result.windows.find((w) => w.label === "Shared");
    const resetsAt = sharedWindow?.resetsAt;
    const expectedReset = new Date(mockResponse.seven_day.resets_at);

    expect(resetsAt).toEqual(expectedReset);
  });

  it("should not be misleading when windows have low vs high utilization", async () => {
    const mockResponse = {
      five_hour: {
        utilization: 0.01, // 1%
        resets_at: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
      },
      seven_day: {
        utilization: 0.8, // 80%
        resets_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(), // 5 days
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

    const fiveHourWindow = result.windows.find((w) => w.label === "5h");
    const weekWindow = result.windows.find((w) => w.label === "Week");
    const sharedWindow = result.windows.find((w) => w.label === "Shared");

    // 5h window should show its TRUE stats
    expect(fiveHourWindow?.usedPercent).toBe(1);
    expect(fiveHourWindow?.resetsAt).toEqual(
      new Date(mockResponse.five_hour.resets_at),
    );

    // Week window should show its TRUE stats
    expect(weekWindow?.usedPercent).toBe(80);
    expect(weekWindow?.resetsAt).toEqual(
      new Date(mockResponse.seven_day.resets_at),
    );

    // Shared window should be PESSIMISTIC
    expect(sharedWindow?.usedPercent).toBe(80);
    expect(sharedWindow?.resetsAt).toEqual(
      new Date(mockResponse.seven_day.resets_at),
    );
  });

  it("should not be misleading at 0% utilization", async () => {
    const mockResponse = {
      five_hour: {
        utilization: 0,
        resets_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      seven_day: {
        utilization: 0,
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

    const result = await fetchClaudeUsage({
      anthropic: { access: "fake-token" },
    });

    const fiveHourWindow = result.windows.find((w) => w.label === "5h");
    const weekWindow = result.windows.find((w) => w.label === "Week");

    expect(fiveHourWindow?.usedPercent).toBe(0);
    expect(fiveHourWindow?.resetsAt).toEqual(
      new Date(mockResponse.five_hour.resets_at),
    );

    expect(weekWindow?.usedPercent).toBe(0);
    expect(weekWindow?.resetsAt).toEqual(
      new Date(mockResponse.seven_day.resets_at),
    );
  });
});
