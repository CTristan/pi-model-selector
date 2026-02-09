/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchClaudeUsage,
  fetchCopilotUsage,
  fetchAllUsages,
  fetchGeminiUsage,
  fetchAntigravityUsage,
  fetchZaiUsage,
  fetchKiroUsage,
  fetchAllCodexUsages,
  formatReset,
  safeDate,
  loadPiAuth,
} from "../src/usage-fetchers.js";
import * as fs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      access: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn().mockReturnValue("darwin"),
    homedir: vi.fn().mockReturnValue("/mock/home"),
  };
});

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execMock = vi.fn(
    (
      _cmd: string,
      options: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (typeof options === "function")
        cb = options as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
      if (cb) cb(null, "{}", "");
    },
  );

  Object.defineProperty(execMock, util.promisify.custom, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: (cmd: string, options: any) => {
      return new Promise((resolve, reject) => {
        execMock(
          cmd,
          options,
          (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          },
        );
      });
    },
  });

  return {
    exec: execMock,
  };
});

describe("Usage Fetchers Utilities", () => {
  it("loadPiAuth should return empty object on error", async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("fail"));
    expect(await loadPiAuth()).toEqual({});
  });

  it("safeDate should handle invalid input", () => {
    expect(safeDate(null)).toBeUndefined();
    expect(safeDate("invalid")).toBeUndefined();
  });

  it("formatReset branches", () => {
    expect(formatReset(new Date("invalid"))).toBe("");
    const now = Date.now();
    expect(formatReset(new Date(now - 10000))).toBe("now");
    expect(formatReset(new Date(now + 30 * 1000))).toBe("now");
    expect(formatReset(new Date(now + 65 * 1000))).toBe("1m");
    expect(formatReset(new Date(now + 61 * 60000 + 1000))).toBe("1h 1m");
    expect(formatReset(new Date(now + 60 * 60000 + 1000))).toBe("1h");
    expect(formatReset(new Date(now + 3 * 24 * 3600000 + 1000))).toBe("3d");
  });
});

describe("Usage Fetchers", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  describe("fetchClaudeUsage", () => {
    it("should handle Keychain failure and 401 retry", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cmd: string, options: unknown, cb?: any): any => {
          if (typeof options === "function") cb = options;
          if (cmd.includes("security")) {
            cb(
              null,
              JSON.stringify({
                claudeAiOauth: { scopes: ["user:profile"], accessToken: "key" },
              }),
              "",
            );
          } else {
            if (cb) cb(null, "", "");
          }
        },
      );

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ five_hour: { utilization: 0.1 } }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchClaudeUsage({
        anthropic: { access: "expired" },
      });
      expect(result.account).toBe("keychain");
    });

    it("should handle global utilization resetsAt branches", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0.5, resets_at: "2026-02-08T22:00:00Z" },
            seven_day: { utilization: 0.1, resets_at: "2026-02-08T23:00:00Z" },
          }),
        }),
      );
      const result = await fetchClaudeUsage({ anthropic: { access: "mock" } });
      expect(result.windows[0].resetsAt).toBeDefined();
    });

    it("should handle Sonnet/Opus specific windows and pessimistic logic", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0.5, resets_at: "2026-02-08T22:00:00Z" },
            seven_day_sonnet: {
              utilization: 0.3,
              resets_at: "2026-02-08T21:00:00Z",
            },
            seven_day_opus: {
              utilization: 0.4,
              resets_at: "2026-02-08T23:00:00Z",
            },
          }),
        }),
      );
      const result = await fetchClaudeUsage({ anthropic: { access: "mock" } });
      expect(result.windows).toHaveLength(2);
      expect(
        result.windows.find((w) => w.label === "Sonnet")?.usedPercent,
      ).toBe(50);
    });

    it("should include fallback window even if global utilization is zero", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
          }),
        }),
      );
      const result = await fetchClaudeUsage({ anthropic: { access: "mock" } });
      expect(result.windows).toHaveLength(1);
      expect(result.windows[0].usedPercent).toBe(0);
    });
  });

  describe("fetchCopilotUsage", () => {
    it("should handle discovery and extraction branches", async () => {
      const results = await fetchCopilotUsage(
        {
          authStorage: {
            getApiKey: async (id: string) => {
              if (id === "github-copilot") return "gcp_key";
              if (id === "github") return "gh_key";
              return undefined;
            },
            get: async (id: string) => {
              if (id === "github-copilot") return { access: "gcp_tok" };
              if (id === "github") return { token: "gh_tok" };
              return null;
            },
          },
        },
        {},
      );
      expect(results[0].provider).toBe("copilot");
    });

    it("should handle token exchange and SKU Found fallback", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "unauthorized",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "unauthorized",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "tid=new", sku: "Enterprise" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: async () => "forbidden",
        });
      vi.stubGlobal("fetch", fetchMock);
      const results = await fetchCopilotUsage(
        {
          authStorage: {
            getApiKey: async () => "gh_token",
            get: async () => ({}),
          },
        },
        {},
      );
      expect(results[0].plan).toBe("Enterprise");
      expect(results[0].account).toBe("fallback");
    });

    it("should handle 304 fallback", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 304,
        }),
      );

      const results = await fetchCopilotUsage(
        {
          authStorage: {
            getApiKey: async () => "tid=mock",
            get: async () => ({}),
          },
        },
        {},
      );
      expect(results[0].account).toBe("304-fallback");
    });

    it("should aggregate unique errors from multiple tokens", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 401 })
          .mockResolvedValueOnce({ ok: false, status: 429 }),
      );

      const results = await fetchCopilotUsage(
        {
          authStorage: {
            getApiKey: async (id: string) =>
              id === "github-copilot" ? "tid=t1" : "tid=t2",
          },
        },
        {},
      );
      expect(results[0].account).toBe("registry:github-copilot:apiKey");
      expect(results[1].error).toContain("HTTP 429");
      expect(results[0].error).toContain("HTTP 401");
    });
  });

  describe("fetchGeminiUsage", () => {
    it("should handle model families and fraction updates", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            buckets: [
              { modelId: "gemini-pro", remainingFraction: 0.5 },
              { modelId: "gemini-pro-v2", remainingFraction: 0.2 },
              { modelId: "other", remainingFraction: 0.9 },
            ],
          }),
        }),
      );
      const result = await fetchGeminiUsage(
        {},
        { "google-gemini-cli": { access: "tok", projectId: "pid" } },
      );
      expect(result.windows).toHaveLength(2);
      expect(result.windows.find((w) => w.label === "Pro")?.usedPercent).toBe(
        80,
      );
    });

    it("should handle token refresh", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "new", expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ buckets: [] }),
        });
      vi.stubGlobal("fetch", fetchMock);
      const result = await fetchGeminiUsage(
        {},
        {
          "google-gemini-cli": {
            access: "old",
            refresh: "ref",
            projectId: "pid",
          },
        },
      );
      expect(result.provider).toBe("gemini");
    });
  });

  describe("fetchAntigravityUsage", () => {
    it("should handle discovery and models with multiple window logic", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            models: {
              "claude-sonnet-4-5": { quotaInfo: { remainingFraction: 0.5 } },
              "claude-opus-4-5-thinking": {
                quotaInfo: { remainingFraction: 0.3 },
              },
              "gemini-3-pro-low": { quotaInfo: { remainingFraction: 0.1 } },
              "gemini-3-pro-high": { quotaInfo: { remainingFraction: 0.2 } },
              "gemini-3-flash": { quotaInfo: { remainingFraction: 0.9 } },
            },
          }),
        }),
      );
      const result = await fetchAntigravityUsage(
        {
          authStorage: {
            getApiKey: async () => "tok",
            get: async () => ({ projectId: "pid" }),
          },
        },
        {},
      );
      expect(result.windows).toHaveLength(3);
      expect(
        result.windows.find((w) => w.label === "Claude")?.usedPercent,
      ).toBe(70);
    });

    it("should handle refresh branches", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ models: {} }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchAntigravityUsage(
        {
          authStorage: {
            getApiKey: async () => "token",
            get: async () => ({
              projectId: "pid",
              refresh: "ref",
              expires: Date.now() - 1000,
            }),
          },
        },
        {},
      );
      expect(result.provider).toBe("antigravity");
    });
  });

  describe("fetchZaiUsage", () => {
    it("should handle different time unit labels", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              code: 200,
              data: {
                limits: [
                  { type: "TOKENS_LIMIT", percentage: 10, unit: 1, number: 1 },
                  { type: "TOKENS_LIMIT", percentage: 20, unit: 3, number: 2 },
                  { type: "TOKENS_LIMIT", percentage: 30, unit: 5, number: 30 },
                  { type: "TIME_LIMIT", percentage: 5 },
                ],
              },
            }),
        }),
      );
      const result = await fetchZaiUsage({ "z-ai": { access: "mock" } });
      expect(result.windows).toHaveLength(4);
    });
  });

  describe("fetchKiroUsage", () => {
    it("should handle patterns and bonus", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cmd, options, cb): any => {
          if (typeof options === "function") cb = options;
          if (!cb) return;
          if (cmd.startsWith("which") || cmd.startsWith("where"))
            cb(null, "/bin/kiro-cli", "");
          else if (cmd.includes("whoami")) cb(null, "user", "");
          else if (cmd.includes("/usage")) {
            cb(
              null,
              "| KIRO PRO | Progress: 50% Credits: (10 / 20) resets on 10/11 Bonus credits: 5 / 10 expires in 2 days",
              "",
            );
          } else cb(null, "", "");
        },
      );
      const result = await fetchKiroUsage();
      expect(result.windows).toHaveLength(2);
      expect(result.windows[1].resetDescription).toBe("2d left");
      expect(result.windows[1].usedPercent).toBe(50);
    });

    it("should correctly handle 'Remaining Bonus credits'", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cmd, options, cb): any => {
          if (typeof options === "function") cb = options;
          if (!cb) return;
          if (cmd.startsWith("which") || cmd.startsWith("where"))
            cb(null, "/bin/kiro-cli", "");
          else if (cmd.includes("whoami")) cb(null, "user", "");
          else if (cmd.includes("/usage")) {
            cb(null, "Remaining Bonus credits: 2.5 / 10.0", "");
          } else cb(null, "", "");
        },
      );
      const result = await fetchKiroUsage();
      const bonus = result.windows.find((w) => w.label === "Bonus");
      expect(bonus?.usedPercent).toBe(75);
    });
  });

  describe("fetchCodexUsage", () => {
    it("should handle credits and deduplication and distinguish by account", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              rate_limit: { primary_window: { used_percent: 10 } },
              credits: { balance: 15.0 },
              plan_type: "Plus",
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              rate_limit: { primary_window: { used_percent: 10 } },
              credits: { balance: 15.0 },
              plan_type: "Plus",
            }),
          }),
      );
      const result = await fetchAllCodexUsages(
        {},
        {
          "openai-codex-1": { access: "token1" },
          "openai-codex-2": { access: "token2" },
        },
      );
      // Should have 2 because although usage is identical, they are from different accounts
      expect(result).toHaveLength(2);
      expect(result[0].account).toBe("pi:1");
      expect(result[1].account).toBe("pi:2");
    });
  });

  describe("fetchAllUsages", () => {
    it("should handle fetch timeout", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => new Promise(() => {})),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        JSON.stringify({ anthropic: { access: "token" } }),
      );

      const promise = fetchAllUsages({}, [
        "copilot",
        "gemini",
        "codex",
        "antigravity",
        "kiro",
        "zai",
      ]);

      // Advance past the 12s timeout
      await vi.advanceTimersByTimeAsync(13000);
      // Ensure all microtasks and timers are processed
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result[0].error).toBe("Timeout");
      vi.useRealTimers();
    });
  });
});
