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

    // globalUtilization should be 1.0
    // resetsAt should be the 1 hour one, NOT the 5 days one.

    const resetsAt = result.windows[0].resetsAt;
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

    const resetsAt = result.windows[0].resetsAt;
    const expectedReset = new Date(mockResponse.seven_day.resets_at);

    expect(resetsAt).toEqual(expectedReset);
  });
});
