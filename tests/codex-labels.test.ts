import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAllCodexUsages } from "../src/fetchers/codex.js";

describe("Codex Window Labels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(results[0].windows[0].label).not.toBe("Week");
    expect(results[0].windows[0].label).toBe("1d");
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
    expect(results[0].windows[0].label).toBe("1w");
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
    expect(res401[0].error).toBe("Token expired");

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as unknown as Response);
    const res403 = await fetchAllCodexUsages(
      {},
      { "openai-codex": { access: "tok2" } },
    );
    expect(res403[0].error).toBe("Permission denied");
  });
});
