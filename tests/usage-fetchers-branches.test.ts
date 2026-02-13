import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalState } from "../src/types.js";
import {
  fetchAllCodexUsages,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  fetchCopilotUsage,
  fetchGeminiUsage,
  fetchKiroUsage,
  fetchZaiUsage,
  formatReset,
  loadPiAuth,
  refreshGoogleToken,
} from "../src/usage-fetchers.js";

// Mocks
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
    platform: vi.fn(),
    homedir: vi.fn().mockReturnValue("/mock/home"),
  };
});

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execMock = vi.fn((_cmd, options, cb) => {
    if (typeof options === "function") cb = options;
    if (cb) cb(null, "", "");
    return {} as ReturnType<typeof import("node:child_process").exec>; // Return mock ChildProcess
  });

  Object.defineProperty(execMock, util.promisify.custom, {
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

describe("Usage Fetchers Branch Coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks(); // This clears implementations too
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    // Re-establish default mocks
    vi.mocked(fs.promises.readFile).mockResolvedValue("");
    vi.mocked(fs.promises.access).mockResolvedValue(undefined); // Success
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error("no ent"));
    vi.mocked(fs.promises.readdir).mockResolvedValue([]);

    vi.mocked(os.platform).mockReturnValue("linux");
    vi.mocked(os.homedir).mockReturnValue("/mock/home");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "",
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetGlobalState();
  });

  // ========================================================================
  // Utilities
  // ========================================================================
  describe("formatReset", () => {
    it("should format hours without minutes if minutes is 0", () => {
      const now = Date.now();
      expect(formatReset(new Date(now + 120 * 60000 + 10000))).toBe("2h");
      expect(formatReset(new Date(now + 121 * 60000 + 10000))).toBe("2h 1m");
    });

    it("formatReset should handle minutes < 60", () => {
      const now = Date.now();
      expect(formatReset(new Date(now + 45 * 60000 + 1000))).toBe("45m");
    });

    it("should format days", () => {
      const now = Date.now();
      // Add buffer to ensure we don't drop below the hour due to execution time
      expect(formatReset(new Date(now + 25 * 60 * 60 * 1000 + 5000))).toBe(
        "1d 1h",
      );
      expect(
        formatReset(new Date(now + 7 * 24 * 60 * 60 * 1000 + 1000)),
      ).not.toContain("d"); // > 7 days falls back to date
    });

    it("should return date string for > 7 days", () => {
      const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      expect(formatReset(future)).not.toBe("");
      expect(formatReset(future)).not.toContain("d ");
    });
  });

  describe("loadPiAuth", () => {
    it("should return parsed JSON on success", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        JSON.stringify({ test: 123 }),
      );
      const auth = await loadPiAuth();
      expect(auth).toEqual({ test: 123 });
    });
  });

  // ========================================================================
  // Claude
  // ========================================================================
  describe("Claude Usage", () => {
    it("should return undefined for keychain on non-darwin", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const result = await fetchClaudeUsage(undefined, {});
      expect(result.error).toBe("No credentials");
    });

    it("should handle keychain error/empty", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (_cmd, _opts, cb): any => {
          // @ts-expect-error: mock callback signature
          cb(new Error("fail"), "", "");
        },
      );
      const result = await fetchClaudeUsage(undefined, {});
      expect(result.error).toBe("No credentials");
    });

    it("should handle successful keychain load but missing scopes", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (_cmd, _opts, cb): any => {
          // @ts-expect-error: mock callback signature
          cb(
            null,
            JSON.stringify({
              claudeAiOauth: { scopes: ["other"], accessToken: "abc" },
            }),
            "",
          );
        },
      );
      const result = await fetchClaudeUsage(undefined, {});
      expect(result.error).toBe("No credentials");
    });

    it("fetchClaudeUsage should update token from keychain if different", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (_cmd, _opts, cb): any => {
          // @ts-expect-error: mock callback signature
          cb(
            null,
            JSON.stringify({
              claudeAiOauth: {
                scopes: ["user:profile"],
                accessToken: "new_key",
              },
            }),
            "",
          );
        },
      );

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 }) // Old token fails
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ five_hour: { utilization: 0.1 } }),
        }); // New token succeeds
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "old_key" },
      });
      expect(result.account).toBe("keychain");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fetchClaudeUsage should use global resetsAt if pessimistic window requires it", async () => {
      const now = Date.now();
      const globalReset = new Date(now + 3600 * 1000).toISOString();
      const sonnetReset = new Date(now + 1800 * 1000).toISOString();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0.9, resets_at: globalReset },
            seven_day_sonnet: { utilization: 0.5, resets_at: sonnetReset },
          }),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "key" },
      });
      const sonnetWindow = result.windows.find((w) => w.label === "Sonnet");
      expect(sonnetWindow?.usedPercent).toBe(90);
      expect(sonnetWindow?.resetsAt?.toISOString()).toBe(globalReset);
    });

    it("fetchClaudeUsage with no global reset time", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0.9 },
            seven_day_sonnet: {
              utilization: 0.5,
              resets_at: "2026-01-01T00:00:00Z",
            },
          }),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "key" },
      });
      const w = result.windows.find((w) => w.label === "Sonnet");
      expect(w?.usedPercent).toBe(90);
    });

    it("fetchClaudeUsage with no specific reset time", async () => {
      const globalReset = new Date(Date.now() + 3600 * 1000).toISOString();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            five_hour: { utilization: 0.9, resets_at: globalReset },
            seven_day_sonnet: { utilization: 0.5 },
          }),
        }),
      );

      const result = await fetchClaudeUsage(undefined, {
        anthropic: { access: "key" },
      });
      const w = result.windows.find((w) => w.label === "Sonnet");
      expect(w?.resetsAt?.toISOString()).toBe(globalReset);
    });
  });

  // ========================================================================
  // Copilot
  // ========================================================================
  describe("Copilot Usage", () => {
    it("should handle registry errors", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (_cmd, _opts, cb): any => {
          // @ts-expect-error: mock callback signature
          cb(null, "", "");
        },
      );

      const modelRegistry = {
        authStorage: {
          getApiKey: vi.fn().mockRejectedValue(new Error("registry fail")),
          get: vi.fn().mockRejectedValue(new Error("registry fail")),
        },
      };
      const results = await fetchCopilotUsage(modelRegistry, {});
      expect(results[0].provider).toBe("copilot");
      expect(results[0].error).toBe("No token found");
    });

    it("should pick up token from gh auth token", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (cmd, _opts, cb): any => {
          if (typeof cmd === "string" && cmd.includes("gh auth token")) {
            // @ts-expect-error: mock callback signature
            cb(null, "gh_cli_token\n", "");
          } else {
            // @ts-expect-error: mock callback signature
            cb(new Error("fail"), "", "");
          }
        },
      );

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            quota_snapshots: { chat: { percent_remaining: 50 } },
          }),
        }),
      );

      const results = await fetchCopilotUsage({}, {});
      expect(results[0].account).toBe("gh-cli");
    });

    it("should fallback to 304 cached state", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation(
        (_cmd, _opts, cb): any => {
          // @ts-expect-error: mock callback signature
          cb(null, "gh_cli_token", "");
        },
      );

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 304,
        }),
      );

      const results = await fetchCopilotUsage({}, {});
      expect(results[0].account).toBe("304-fallback:gh-cli");
      expect(results[0].windows[0].resetDescription).toContain("cached");
    });

    it("fetchCopilotUsage should use registry token", async () => {
      const modelRegistry = {
        authStorage: {
          getApiKey: vi.fn().mockResolvedValue("reg_key"),
          get: vi.fn().mockResolvedValue({ access: "reg_access" }),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            quota_snapshots: { chat: { percent_remaining: 50 } },
          }),
        }),
      );

      const results = await fetchCopilotUsage(modelRegistry, {});
      expect(results[0].account).toContain("registry");
    });
  });

  // ========================================================================
  // Gemini
  // ========================================================================
  describe("Gemini Usage", () => {
    it("should handle refresh failure and fallback to creds file", async () => {
      const piAuth = {
        "google-gemini-cli": {
          access: "expired_token",
          refresh: "refresh_token",
          projectId: "pid",
        },
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ buckets: [] }),
        });

      vi.stubGlobal("fetch", fetchMock);

      vi.mocked(fs.promises.access).mockResolvedValue(undefined);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        JSON.stringify({ access_token: "file_token", project_id: "pid" }),
      );

      const result = await fetchGeminiUsage({}, piAuth);
      expect(result[0].provider).toBe("gemini");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("should handle generic model families", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            buckets: [{ modelId: "unknown-model-1", remainingFraction: 0.5 }],
          }),
        }),
      );

      const result = await fetchGeminiUsage(
        {},
        { "google-gemini-cli": { access: "tok", projectId: "pid" } },
      );
      expect(result[0].windows[0].label).toBe("Unknown");
    });

    it("refreshGoogleToken should handle API failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
      expect(await refreshGoogleToken("rt")).toBeNull();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 400 }),
      );
      expect(await refreshGoogleToken("rt")).toBeNull();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ expires_in: 3600 }),
        }),
      );
      expect(await refreshGoogleToken("rt")).toBeNull();
    });

    it("refreshGoogleToken should not force cloud-shell client_id when none is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "new_token", expires_in: 3600 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await refreshGoogleToken("rt");

      const firstOptions = fetchMock.mock.calls[0]?.[1] as
        | RequestInit
        | undefined;
      const firstBody = firstOptions?.body as URLSearchParams;
      expect(firstBody.toString()).not.toContain("client_id=");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refreshGoogleToken should fall back to cloud-shell client_id only after a failed no-client attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "new_token", expires_in: 3600 }),
        });
      vi.stubGlobal("fetch", fetchMock);

      await refreshGoogleToken("rt");

      const firstOptions = fetchMock.mock.calls[0]?.[1] as
        | RequestInit
        | undefined;
      const firstBody = firstOptions?.body as URLSearchParams;
      const secondOptions = fetchMock.mock.calls[1]?.[1] as
        | RequestInit
        | undefined;
      const secondBody = secondOptions?.body as URLSearchParams;
      expect(firstBody.toString()).not.toContain("client_id=");
      expect(secondBody.toString()).toContain("client_id=");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // Antigravity
  // ========================================================================
  describe("Antigravity Usage", () => {
    it("should handle missing credentials gracefully", async () => {
      const result = await fetchAntigravityUsage({}, {});
      expect(result.error).toBe("No credentials");
    });

    it("should use ENV var credential", async () => {
      vi.stubEnv("ANTIGRAVITY_API_KEY", "env_key");
      const result = await fetchAntigravityUsage({}, {});
      expect(result.error).toBe("Missing projectId");
    });

    it("should merge projectId from piAuth when token comes from registry", async () => {
      const modelRegistry = {
        authStorage: {
          getApiKey: async () => "registry_token",
          get: async () => ({}),
        },
      };
      const piAuth = {
        "google-antigravity": { projectId: "pid" },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ models: {} }),
        }),
      );

      const result = await fetchAntigravityUsage(modelRegistry, piAuth);
      expect(result.error).toBe("No quota data");
    });

    it("should allow ANTIGRAVITY_API_KEY auth when projectId exists in piAuth", async () => {
      vi.stubEnv("ANTIGRAVITY_API_KEY", "env_key");
      const piAuth = {
        "google-antigravity": { projectId: "pid" },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ models: {} }),
        }),
      );

      const result = await fetchAntigravityUsage({}, piAuth);
      expect(result.error).toBe("No quota data");
    });

    it("should handle refresh failure and fallback to piAuth", async () => {
      const modelRegistry = {
        authStorage: {
          getApiKey: async () => "expired_reg_token",
          get: async () => ({ projectId: "pid", refresh: "bad_refresh" }),
        },
      };

      const piAuth = {
        "google-antigravity": { access: "fallback_token", projectId: "pid" },
      };

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      fetchMock.mockResolvedValueOnce({ ok: false });
      fetchMock.mockResolvedValueOnce({ ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: {} }),
      });

      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchAntigravityUsage(modelRegistry, piAuth);
      expect(result.provider).toBe("antigravity");
      expect(result.error).toBe("No quota data");
    });

    it("fetchAntigravityUsage should proactively refresh token", async () => {
      const piAuth = {
        "google-antigravity": {
          access: "old_tok",
          refresh: "rt",
          expires: Date.now() + 1000,
          projectId: "pid",
        },
      };

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "new_tok", expires_in: 3600 }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: {} }),
      });

      vi.stubGlobal("fetch", fetchMock);

      await fetchAntigravityUsage({}, piAuth);
      expect(fetchMock.mock.calls[0][0]).toContain("oauth2.googleapis.com");
    });

    it("fetchAntigravityUsage should continue if proactive refresh fails", async () => {
      const piAuth = {
        "google-antigravity": {
          access: "old_tok",
          refresh: "rt",
          expires: Date.now() + 1000,
          projectId: "pid",
        },
      };

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({ ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: {} }),
      });

      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchAntigravityUsage({}, piAuth);
      expect(result.provider).toBe("antigravity");
    });

    it("fetchAntigravityUsage should skip models with better quota (pessimistic)", async () => {
      const piAuth = {
        "google-antigravity": { access: "tok", projectId: "pid" },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            models: {
              "claude-sonnet-4-5": { quotaInfo: { remainingFraction: 0.5 } },
              "claude-sonnet-4-5-thinking": {
                quotaInfo: { remainingFraction: 0.9 },
              },
              "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 0.1 } },
            },
          }),
        }),
      );

      const result = await fetchAntigravityUsage({}, piAuth);
      expect(result.windows[0].usedPercent).toBe(90);
    });

    it("fetchAntigravityUsage should compare multiple models", async () => {
      const piAuth = {
        "google-antigravity": { access: "tok", projectId: "pid" },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            models: {
              "claude-sonnet-4-5": { quotaInfo: { remainingFraction: 0.8 } },
              "claude-opus-4-6-thinking": {
                quotaInfo: { remainingFraction: 0.2 },
              },
            },
          }),
        }),
      );

      const result = await fetchAntigravityUsage({}, piAuth);
      expect(result.windows[0].usedPercent).toBe(80);
    });
  });

  // ========================================================================
  // Codex
  // ========================================================================
  describe("Codex Usage", () => {
    it("should discover credentials from .codex directory", async () => {
      vi.mocked(fs.promises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as unknown as fs.Stats);

      vi.mocked(fs.promises.readdir).mockResolvedValue([
        "auth.json",
        "auth-other.json",
        "ignore.txt",
      ] as any);

      vi.mocked(fs.promises.readFile).mockImplementation(async (p) => {
        if (String(p).endsWith("auth.json"))
          return JSON.stringify({ tokens: { access_token: "tok1" } });
        if (String(p).endsWith("auth-other.json"))
          return JSON.stringify({ OPENAI_API_KEY: "tok2" });
        return "";
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ rate_limit: {} }),
        }),
      );

      const result = await fetchAllCodexUsages({}, {});
      expect(result).toHaveLength(2);
    });

    it("should handle string credit balance", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            rate_limit: { primary_window: { used_percent: 10 } },
            credits: { balance: "20.50" },
            plan_type: "Pro",
          }),
        }),
      );

      const result = await fetchAllCodexUsages(
        {},
        { "openai-codex": { access: "t" } },
      );
      expect(result[0].plan).toBe("Pro ($20.50)");
    });

    it("fetchAllCodexUsages handles errors in fingerprinting", async () => {
      const piAuth = {
        "openai-codex-1": { access: "tok1" },
        "openai-codex-2": { access: "tok2" },
      };
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
      const result = await fetchAllCodexUsages({}, piAuth);
      expect(result).toHaveLength(2);
    });

    it("usageFingerprint should handle empty windows", async () => {
      const piAuth = { "openai-codex-1": { access: "tok" } };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}), // No rate_limit
        }),
      );
      const result = await fetchAllCodexUsages({}, piAuth);
      expect(result).toHaveLength(1);
    });
  });

  // ========================================================================
  // Kiro
  // ========================================================================
  describe("Kiro Usage", () => {
    it("should return error if kiro-cli not found", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb): any => {
        if (typeof opts === "function") cb = opts as any;
        if (typeof cmd === "string" && cmd.includes("which")) {
          cb?.(new Error("not found"), "", "");
        } else {
          cb?.(null, "", "");
        }
      });
      const result = await fetchKiroUsage();
      expect(result.error).toBe("kiro-cli not found");
    });

    it("should handle date ambiguity DD/MM vs MM/DD", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb): any => {
        if (typeof opts === "function") cb = opts as any;
        if (typeof cmd === "string" && cmd.includes("which")) {
          cb?.(null, "/bin/kiro", "");
        } else if (typeof cmd === "string" && cmd.includes("whoami")) {
          cb?.(null, "user", "");
        } else {
          cb?.(null, "Usage: 10% resets on 02/03", "");
        }
      });

      const result = await fetchKiroUsage();
      expect(result.windows[0].resetsAt).toBeDefined();
    });

    it("kiro date heuristic branches", async () => {
      const child_process = await import("node:child_process");
      vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb): any => {
        if (typeof opts === "function") cb = opts as any;
        if (typeof cmd === "string" && cmd.includes("which")) {
          cb?.(null, "/bin/kiro", "");
        } else if (typeof cmd === "string" && cmd.includes("whoami")) {
          cb?.(null, "user", "");
        } else {
          cb?.(null, "Usage: 10% resets on 10/11", "");
        }
      });
      const result = await fetchKiroUsage();
      expect(result.windows[0].resetsAt).toBeDefined();
    });
    it("fetchAntigravityUsage should fail if piAuth is missing projectId", async () => {
      const piAuth = { "google-antigravity": { access: "tok" } }; // No projectId
      const result = await fetchAntigravityUsage({}, piAuth);
      expect(result.error).toBe("Missing projectId");
    });

    it("fetchGeminiUsage should fail if piAuth is missing projectId", async () => {
      const piAuth = { "google-gemini-cli": { access: "tok" } };
      vi.mocked(fs.promises.access).mockRejectedValue(new Error("no file"));
      const result = await fetchGeminiUsage({}, piAuth);
      expect(result[0].error).toBe("Missing projectId");
    });

    it("fetchCopilotUsage should handle exchange exception", async () => {
      const piAuth = { "github-copilot": { access: "gh_token" } }; // Not a tid= token

      const fetchMock = vi.fn();
      // 1. Initial fetch (token gh_token) -> 401
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "",
      });
      // 2. Bearer fallback -> 401
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "",
      });
      // 3. Exchange call -> Throws
      fetchMock.mockRejectedValueOnce(new Error("network fail"));

      vi.stubGlobal("fetch", fetchMock);

      const results = await fetchCopilotUsage({}, piAuth);
      // Should fail eventually
      expect(results[0].error).toBeDefined();
    });
    it("fetchGeminiUsage should try file fallback if refreshed token still fails", async () => {
      const piAuth = {
        "google-gemini-cli": {
          access: "expired_token",
          refresh: "valid_refresh",
          projectId: "pid",
        },
      };

      const fetchMock = vi.fn();
      // 1. Initial 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      // 2. Refresh success
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "new_token" }),
      });
      // 3. New token 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      // 4. File fallback success
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ buckets: [] }),
      });

      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(fs.promises.access).mockResolvedValue(undefined);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        JSON.stringify({ access_token: "file_token", project_id: "pid" }),
      );

      const result = await fetchGeminiUsage({}, piAuth);
      expect(result[0].provider).toBe("gemini");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("fetchAntigravityUsage should skip proactive refresh if expiry is far", async () => {
      const piAuth = {
        "google-antigravity": {
          access: "tok",
          refresh: "rt",
          expires: Date.now() + 3600 * 1000, // 1 hour
          projectId: "pid",
        },
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: {} }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await fetchAntigravityUsage({}, piAuth);
      // Should only call models endpoint, not refresh
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("cloudcode-pa");
    });
    it("fetchGeminiUsage should skip file fallback if token is same", async () => {
      const piAuth = {
        "google-gemini-cli": {
          access: "expired_token",
          refresh: "valid_refresh",
          projectId: "pid",
        },
      };

      const fetchMock = vi.fn();
      // 1. Initial 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
      // 2. Refresh success
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "new_token" }),
      });
      // 3. New token 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

      // File has SAME token as new_token
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(fs.promises.access).mockResolvedValue(undefined);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        JSON.stringify({ access_token: "new_token", project_id: "pid" }),
      );

      const result = await fetchGeminiUsage({}, piAuth);
      expect(result[0].provider).toBe("gemini");
      expect(fetchMock).toHaveBeenCalledTimes(3); // Should NOT call 4th time
    });

    it("fetchAntigravityUsage should skip fallback if token is same", async () => {
      // Auth from Registry/File
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({})); // No file

      // Setup: loadAntigravityAuth returns a token.
      // piAuth has SAME token.

      const modelRegistry = {
        authStorage: {
          getApiKey: async () => "tok",
          get: async () => ({ projectId: "pid" }),
        },
      };

      const piAuth = {
        "google-antigravity": { access: "tok", projectId: "pid" },
      };

      const fetchMock = vi.fn();
      // 1. Initial 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchAntigravityUsage(modelRegistry, piAuth);
      // Should fail after 1 call because fallback token is identical
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.error).toBe("Unauthorized");
    });
  });

  describe("Additional Coverage", () => {
    describe("formatReset", () => {
      it("should handle past dates", () => {
        expect(formatReset(new Date(Date.now() - 1000))).toBe("now");
      });

      it("should handle exact hours (0 minutes)", () => {
        const now = Date.now();
        expect(formatReset(new Date(now + 2 * 60 * 60 * 1000 + 100))).toBe(
          "2h",
        );
      });

      it("should handle exact days (0 hours)", () => {
        const now = Date.now();
        expect(formatReset(new Date(now + 3 * 24 * 60 * 60 * 1000 + 100))).toBe(
          "3d",
        );
      });

      it("should handle invalid dates gracefully in catch block", () => {
        const original = Intl.DateTimeFormat;
        global.Intl.DateTimeFormat = vi.fn(() => ({
          format: () => {
            throw new Error("fail");
          },
        })) as any;
        expect(formatReset(new Date(Date.now() + 10 * 24 * 3600000))).toBe("");
        global.Intl.DateTimeFormat = original;
      });
    });

    describe("fetchClaudeUsage Branches", () => {
      it("should not retry if source is not auth.json", async () => {
        vi.mocked(os.platform).mockReturnValue("darwin");
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        vi.stubGlobal("fetch", fetchMock);

        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (_cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb)
              cb(
                null,
                JSON.stringify({
                  claudeAiOauth: { scopes: ["user:profile"], accessToken: "k" },
                }),
                "",
              );
          },
        );

        const res = await fetchClaudeUsage(undefined, {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.error).toBe("HTTP 401");
      });

      it("should not retry if keychain token is same as auth.json token", async () => {
        vi.mocked(os.platform).mockReturnValue("darwin");
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
        vi.stubGlobal("fetch", fetchMock);

        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (_cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb)
              cb(
                null,
                JSON.stringify({
                  claudeAiOauth: {
                    scopes: ["user:profile"],
                    accessToken: "same_token",
                  },
                }),
                "",
              );
          },
        );

        await fetchClaudeUsage(undefined, {
          anthropic: { access: "same_token" },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("should handle keychain with missing claudeAiOauth property", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (_cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb) cb(null, JSON.stringify({ other: {} }), "");
          },
        );
        const res = await fetchClaudeUsage(undefined, {});
        expect(res.error).toBe("No credentials");
      });
    });

    describe("fetchCopilotUsage Branches", () => {
      it("should handle tryExchange failure (network)", async () => {
        const piAuth = { "github-copilot": { access: "gh_token" } };
        const fetchMock = vi.fn();
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "",
        });
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "",
        });
        fetchMock.mockRejectedValueOnce(new Error("net"));

        vi.stubGlobal("fetch", fetchMock);
        const results = await fetchCopilotUsage({}, piAuth);
        expect(results[0].error).toBeDefined();
      });

      it("should handle tryExchange response ok but no token", async () => {
        const piAuth = { "github-copilot": { access: "gh_token" } };
        const fetchMock = vi.fn();
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "",
        });
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "",
        });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

        vi.stubGlobal("fetch", fetchMock);
        const results = await fetchCopilotUsage({}, piAuth);
        expect(results[0].error).toBeDefined();
      });

      it("should ignore unlimited chat snapshots", async () => {
        const piAuth = { "github-copilot": { access: "tok" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              quota_snapshots: { chat: { unlimited: true } },
            }),
          }),
        );
        const results = await fetchCopilotUsage({}, piAuth);
        expect(results[0].windows).toHaveLength(1);
        expect(results[0].windows[0].label).toBe("Access");
      });

      it("should find tokens in piAuth directly", async () => {
        const piAuth = { "github-copilot": { access: "direct_access" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ quota_snapshots: {} }),
          }),
        );
        const results = await fetchCopilotUsage({}, piAuth);
        expect(results[0].account).toBe("auth.json.access");
      });

      it("should handle gh auth token throwing", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (_cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            cb?.(new Error("fail"), "", "");
          },
        );
        const results = await fetchCopilotUsage({}, {});
        expect(results[0].error).toBe("No token found");
      });
    });

    describe("fetchGeminiUsage Branches", () => {
      it("should accept project_id snake_case in piAuth", async () => {
        const piAuth = {
          "google-gemini-cli": { access: "tok", project_id: "pid" },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ buckets: [] }),
          }),
        );
        const res = await fetchGeminiUsage({}, piAuth);
        expect(res[0].error).toBeUndefined();
      });

      it("should accept projectId (camelCase) in file creds", async () => {
        vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        vi.mocked(fs.promises.readFile).mockResolvedValue(
          JSON.stringify({
            access_token: "tok",
            projectId: "pid",
          }),
        );
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ buckets: [] }),
          }),
        );
        const res = await fetchGeminiUsage({}, {});
        expect(res[0].error).toBeUndefined();
      });

      it("should handle invalid file content gracefully", async () => {
        vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        vi.mocked(fs.promises.readFile).mockResolvedValue("invalid json");
        const res = await fetchGeminiUsage({}, {});
        expect(res[0].error).toBe("No credentials");
      });
    });

    describe("fetchAntigravityUsage Branches", () => {
      it("should fallback to anti-gravity (hyphenated) key in piAuth", async () => {
        const piAuth = { "anti-gravity": { access: "tok", projectId: "pid" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ models: {} }),
          }),
        );
        const res = await fetchAntigravityUsage({}, piAuth);
        expect(res.error).not.toBe("No credentials");
      });

      it("should handle missing access in piAuth creds", async () => {
        const piAuth = { "google-antigravity": { projectId: "pid" } };
        const res = await fetchAntigravityUsage({}, piAuth);
        expect(res.error).toBe("No credentials");
      });

      it("should handle model with no quotaInfo", async () => {
        const piAuth = {
          "google-antigravity": { access: "tok", projectId: "pid" },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ models: { "gemini-3-flash": {} } }),
          }),
        );
        const res = await fetchAntigravityUsage({}, piAuth);
        expect(res.error).toBe("No quota data");
      });

      it("should handle invalid registry response (empty)", async () => {
        const modelRegistry = {
          authStorage: {
            getApiKey: async () => undefined,
            get: async () => undefined,
          },
        };
        const res = await fetchAntigravityUsage(modelRegistry, {});
        expect(res.error).toBe("No credentials");
      });
    });

    describe("fetchCodexUsage Branches", () => {
      it("should handle unexpected piAuth structure", async () => {
        const piAuth = {
          "openai-codex-1": {
            tokens: { access_token: "tok", account_id: "acc" },
          },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              rate_limit: { primary_window: { used_percent: 10 } },
            }),
          }),
        );
        const res = await fetchAllCodexUsages({}, piAuth);
        expect(res).toHaveLength(1);
        expect(res[0].account).toBe("acc");
      });

      it("should handle file read error in discovery", async () => {
        vi.mocked(fs.promises.stat).mockResolvedValue({
          isDirectory: () => true,
        } as any);
        vi.mocked(fs.promises.readdir).mockResolvedValue(["auth.json"] as any);
        vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("fail"));

        const res = await fetchAllCodexUsages({}, {});
        expect(res[0].error).toBe("No credentials");
      });

      it("should handle fetch 403 (Forbidden)", async () => {
        const piAuth = { "openai-codex": { access: "tok" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({ ok: false, status: 403 }),
        );
        const res = await fetchAllCodexUsages({}, piAuth);
        expect(res[0].error).toBe("Permission denied");
      });

      it("should handle secondary window logic", async () => {
        const piAuth = { "openai-codex": { access: "tok" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 90,
                  limit_window_seconds: 3600,
                },
              },
            }),
          }),
        );
        const res = await fetchAllCodexUsages({}, piAuth);
        expect(res[0].windows[0].usedPercent).toBe(90);
      });

      it("should expose both windows when labels differ", async () => {
        const piAuth = { "openai-codex": { access: "tok" } };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 40,
                  limit_window_seconds: 604800,
                },
              },
            }),
          }),
        );
        const res = await fetchAllCodexUsages({}, piAuth);
        expect(res[0].windows).toHaveLength(2);
        expect(res[0].windows.map((w) => w.label)).toEqual(["1w", "1h"]);
      });

      it("should handle same usage percent but later reset", async () => {
        const piAuth = { "openai-codex": { access: "tok" } };
        const now = Date.now() / 1000;
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: 10,
                  reset_at: now + 100,
                  limit_window_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 10,
                  reset_at: now + 200,
                  limit_window_seconds: 3600,
                },
              },
            }),
          }),
        );
        const res = await fetchAllCodexUsages({}, piAuth);
        expect(res[0].windows[0].resetsAt?.getTime()).toBeGreaterThan(
          Date.now() + 150000,
        );
      });
    });

    describe("fetchKiroUsage Branches", () => {
      it("should handle 'Remaining' percentage format", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb) {
              if (cmd.includes("/usage")) cb(null, "Remaining: 40%", "");
              else cb(null, "ok", "");
            }
          },
        );
        const res = await fetchKiroUsage();
        expect(res.windows[0].usedPercent).toBe(60);
      });

      it("should handle 'Credits' percentage format", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb) {
              if (cmd.includes("/usage")) cb(null, "Credits: 10%", "");
              else cb(null, "ok", "");
            }
          },
        );
        const res = await fetchKiroUsage();
        expect(res.windows[0].usedPercent).toBe(90);
      });

      it("should handle ambiguous dates favoring future", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb) {
              if (cmd.includes("/usage"))
                cb(null, "Usage: 10% resets on 10/11", "");
              else cb(null, "ok", "");
            }
          },
        );
        const res = await fetchKiroUsage();
        expect(res.windows[0].resetsAt).toBeDefined();
      });

      it("should handle dates in the past (assume next year)", async () => {
        const child_process = await import("node:child_process");
        vi.mocked(child_process.exec).mockImplementation(
          (cmd, opts, cb): any => {
            if (typeof opts === "function") cb = opts as any;
            if (cb) {
              if (cmd.includes("/usage"))
                cb(null, "Usage: 10% resets on 01/01", "");
              else cb(null, "ok", "");
            }
          },
        );

        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 1, 1)); // Feb 1 2025

        const res = await fetchKiroUsage();
        const reset = res.windows[0].resetsAt;
        expect(reset?.getFullYear()).toBe(2026);

        vi.useRealTimers();
      });
    });

    describe("fetchZaiUsage Branches", () => {
      it("should handle minute units (unit=5)", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              success: true,
              code: 200,
              data: {
                limits: [
                  { type: "TOKENS_LIMIT", unit: 5, number: 10, percentage: 50 },
                ],
              },
            }),
          }),
        );
        const res = await fetchZaiUsage({ "z-ai": { access: "k" } });
        expect(res.windows[0].label).toBe("Tokens (10m)");
      });

      it("should ignore unknown limit types", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              success: true,
              code: 200,
              data: { limits: [{ type: "UNKNOWN_TYPE" }] },
            }),
          }),
        );
        const res = await fetchZaiUsage({ "z-ai": { access: "k" } });
        expect(res.windows).toHaveLength(0);
      });

      it("should handle API error response", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: false, msg: "failed" }),
          }),
        );
        const res = await fetchZaiUsage({ "z-ai": { access: "k" } });
        expect(res.error).toBe("failed");
      });
    });
  });
});
