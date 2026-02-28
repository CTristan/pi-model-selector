import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllCodexUsages } from "../src/fetchers/codex.js";
import { resetGlobalState } from "../src/types.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn(),
  };
});

describe("Codex Window Labels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(os.platform).mockReturnValue("linux");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGlobalState();
  });

  it("should label 24h window as '1d' or '24h' (not 'Week')", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 86400, // 24 hours
            },
          },
        }),
    } as unknown as Response);

    const results = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok" } },
    );
    expect(results[0]!.windows[0]!.label).not.toBe("Week");
    expect(results[0]!.windows[0]!.label).toBe("1d");
  });

  it("should label 168h window as '1w' or 'Week'", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 604800, // 168 hours
            },
          },
        }),
    } as unknown as Response);

    const results = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok" } },
    );
    expect(results[0]!.windows[0]!.label).toBe("1w");
  });

  it("should distinguish 401 and 403 errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as unknown as Response);

    const res401 = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok1" } },
    );
    expect(res401[0]!.error).toBe("Token expired");

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as unknown as Response);
    const res403 = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok2" } },
    );
    expect(res403[0]!.error).toBe("Permission denied");
  });

  it("should sort windows without reset times by usedPercent then label", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 86400,
              // No reset_at - tests ternary operator branch
            },
            secondary_window: {
              used_percent: 50,
              limit_window_seconds: 3600,
              // No reset_at - tests ternary operator branch
            },
          },
        }),
    } as unknown as Response);

    const results = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok" } },
    );
    expect(results[0]!.windows).toHaveLength(2);
    // Should be sorted by usedPercent descending
    expect(results[0]!.windows[0]!.usedPercent).toBe(50);
    expect(results[0]!.windows[1]!.usedPercent).toBe(30);
  });

  it("should sort windows with equal reset times by usedPercent then label", async () => {
    const baseTime = Date.now();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 86400,
              reset_at: baseTime / 1000,
            },
            secondary_window: {
              used_percent: 30,
              limit_window_seconds: 3600,
              reset_at: baseTime / 1000, // Same reset time
            },
          },
        }),
    } as unknown as Response);

    const results = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok" } },
    );
    expect(results[0]!.windows).toHaveLength(2);
    // When usedPercent and reset time are equal, sort by label
    // "1d" should come before "1h" alphabetically
    expect(results[0]!.windows[0]!.label).toBe("1d");
    expect(results[0]!.windows[1]!.label).toBe("1h");
  });

  it("should sort windows with one having reset time and one without", async () => {
    const baseTime = Date.now();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 86400,
              // No reset_at
            },
            secondary_window: {
              used_percent: 30,
              limit_window_seconds: 3600,
              reset_at: baseTime / 1000,
            },
          },
        }),
    } as unknown as Response);

    const results = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok" } },
    );
    expect(results[0]!.windows).toHaveLength(2);
    // When usedPercent is equal, window with reset time should come first
    expect(results[0]!.windows[0]!.resetsAt).toBeDefined();
    expect(results[0]!.windows[1]!.resetsAt).toBeUndefined();
  });
});
