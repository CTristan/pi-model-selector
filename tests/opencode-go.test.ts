import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenCodeGoUsage,
  resolveOpenCodeGoApiKey,
} from "../src/fetchers/opencode-go.js";

function usageResponse(overrides?: {
  rolling?: unknown;
  weekly?: unknown;
  monthly?: unknown;
  usage?: unknown;
}) {
  const window = (status: string, percent: number, resetsAt: string) => ({
    status,
    percent,
    resetsAt,
  });
  return {
    usage:
      overrides?.usage !== undefined
        ? overrides.usage
        : {
            rolling:
              overrides?.rolling !== undefined
                ? overrides.rolling
                : window("ok", 17, "2026-08-22T19:34:44.188Z"),
            weekly:
              overrides?.weekly !== undefined
                ? overrides.weekly
                : window("ok", 7, "2026-08-24T00:00:00.188Z"),
            monthly:
              overrides?.monthly !== undefined
                ? overrides.monthly
                : window("ok", 3, "2026-09-11T19:32:38.188Z"),
          },
  };
}

describe("resolveOpenCodeGoApiKey", () => {
  const originalKey = process.env.OPENCODE_API_KEY;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalKey !== undefined) {
      process.env.OPENCODE_API_KEY = originalKey;
    } else {
      delete process.env.OPENCODE_API_KEY;
    }
  });

  it("prefers the OPENCODE_API_KEY environment variable", () => {
    process.env.OPENCODE_API_KEY = " env-key ";
    expect(resolveOpenCodeGoApiKey({})).toBe("env-key");
  });

  it("reads legacy piAuth fragments", () => {
    delete process.env.OPENCODE_API_KEY;
    expect(
      resolveOpenCodeGoApiKey({
        "opencode-go": { key: "  legacy-key  " },
      }),
    ).toBe("legacy-key");
    expect(
      resolveOpenCodeGoApiKey({
        "opencode-go": { access: "legacy-access" },
      }),
    ).toBe("legacy-access");
  });

  it("returns undefined without credentials", () => {
    delete process.env.OPENCODE_API_KEY;
    expect(resolveOpenCodeGoApiKey({})).toBeUndefined();
  });
});

describe("fetchOpenCodeGoUsage", () => {
  const originalKey = process.env.OPENCODE_API_KEY;

  beforeEach(() => {
    delete process.env.OPENCODE_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalKey !== undefined) {
      process.env.OPENCODE_API_KEY = originalKey;
    } else {
      delete process.env.OPENCODE_API_KEY;
    }
  });

  it("returns an error snapshot without credentials", async () => {
    const result = await fetchOpenCodeGoUsage({}, {});

    expect(result.provider).toBe("opencode-go");
    expect(result.displayName).toBe("OpenCode Go");
    expect(result.windows).toEqual([]);
    expect(result.error).toBe("No API key");
  });

  it("uses Pi's public provider auth when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => usageResponse(),
      }),
    );
    const getProviderAuth = vi.fn().mockResolvedValue({
      auth: { apiKey: "public-registry-opencode-key" },
      source: "stored credential",
    });

    const result = await fetchOpenCodeGoUsage({ getProviderAuth }, {});

    expect(result.error).toBeUndefined();
    expect(getProviderAuth).toHaveBeenCalledWith("opencode-go");
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) throw new Error("Expected an OpenCode Go usage request");
    const request = call[1];
    if (!request) throw new Error("Expected OpenCode Go request options");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer public-registry-opencode-key",
    );
  });

  it("uses registry authStorage.getApiKey('opencode-go') next", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => usageResponse(),
      }),
    );
    const modelRegistry = {
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue("storage-key"),
      },
    };

    const result = await fetchOpenCodeGoUsage(modelRegistry, {});

    expect(result.error).toBeUndefined();
    expect(modelRegistry.authStorage.getApiKey).toHaveBeenCalledWith(
      "opencode-go",
    );
  });

  it("falls back to OPENCODE_API_KEY when the registry has nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => usageResponse(),
      }),
    );
    process.env.OPENCODE_API_KEY = " env-opencode-key ";

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue(undefined) },
      {},
    );

    expect(result.error).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) throw new Error("Expected an OpenCode Go usage request");
    const request = call[1];
    if (!request) throw new Error("Expected OpenCode Go request options");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer env-opencode-key",
    );
  });

  it("reports HTTP errors with the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.error).toBe("HTTP 401 Unauthorized");
  });

  it("parses all three quota windows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => usageResponse(),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.plan).toBe("Go");
    expect(result.windows.map((w) => w.label)).toEqual([
      "5-hour",
      "Weekly",
      "Monthly",
    ]);
    expect(result.windows.map((w) => w.usedPercent)).toEqual([17, 7, 3]);
    for (const window of result.windows) {
      expect(window.resetsAt).toBeInstanceOf(Date);
      expect(window.resetDescription).toBeTruthy();
    }
  });

  it("includes rate-limited windows with their reported percent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          usageResponse({
            weekly: {
              status: "rate-limited",
              percent: 100,
              resetsAt: "2026-08-24T00:00:00.188Z",
            },
          }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    const weekly = result.windows.find((w) => w.label === "Weekly");
    expect(weekly?.usedPercent).toBe(100);
  });

  it("skips windows with unknown statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          usageResponse({
            monthly: { status: "paused", percent: 50 },
          }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
  });

  it("clamps percent values into 0-100", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          usageResponse({
            rolling: {
              status: "ok",
              percent: -5,
              resetsAt: "2026-08-22T19:34:44.188Z",
            },
            weekly: { status: "ok", percent: 140 },
          }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    const rolling = result.windows.find((w) => w.label === "5-hour");
    const weekly = result.windows.find((w) => w.label === "Weekly");
    expect(rolling?.usedPercent).toBe(0);
    expect(weekly?.usedPercent).toBe(100);
  });

  it("drops windows whose percent is not a finite number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          usageResponse({
            rolling: { status: "ok", percent: "seventeen" },
          }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.windows.map((w) => w.label)).toEqual(["Weekly", "Monthly"]);
  });

  it("returns an error snapshot for a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: "unexpected" }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.error).toBe("Invalid response format: missing usage");
  });

  it("returns an error snapshot when no windows are valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          usageResponse({
            rolling: { status: "paused" },
            weekly: { status: "paused" },
            monthly: { status: "paused" },
          }),
      }),
    );

    const result = await fetchOpenCodeGoUsage(
      { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "k" } }) },
      {},
    );

    expect(result.error).toBe("No usable usage windows in response");
  });
});
