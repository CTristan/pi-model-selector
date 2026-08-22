import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types.js";
import {
  fetchAllCodexUsages,
  fetchClaudeUsage,
  fetchCopilotUsage,
  fetchGeminiUsage,
  refreshGoogleToken,
} from "../src/usage-fetchers.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn(),
  };
});

vi.mock("../src/fetchers/common.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/fetchers/common.js")>();
  return {
    ...actual,
    execFileAsync: vi.fn().mockRejectedValue(new Error("gh unavailable")),
  };
});

describe("Provider auth fallback behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(os.platform).mockReturnValue("linux");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchClaudeUsage should resolve Anthropic OAuth through Pi's public registry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ five_hour: { utilization: 20 } }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const getProviderAuth = vi.fn(async () => ({
      auth: { apiKey: "registry-oauth-token" },
      source: "OAuth",
    }));
    const result = await fetchClaudeUsage({ getProviderAuth }, {});

    expect(result.error).toBeUndefined();
    expect(getProviderAuth).toHaveBeenCalledWith("anthropic");
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected an Anthropic usage request");
    const request = firstCall[1];
    if (!request) throw new Error("Expected Anthropic request options");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer registry-oauth-token",
    );
  });

  it("fetchClaudeUsage should not send non-OAuth Anthropic credentials to the OAuth usage endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const getApiKey = vi.fn().mockResolvedValue("legacy-api-key");
    const get = vi.fn().mockResolvedValue({ access: "legacy-oauth-token" });

    const result = await fetchClaudeUsage(
      {
        getProviderAuth: vi.fn(async () => ({
          auth: { apiKey: "api-key" },
          source: "stored credential",
        })),
        authStorage: { getApiKey, get },
      },
      { anthropic: { access: "legacy-auth-json-token" } },
    );

    expect(result.error).toBe("Anthropic usage requires OAuth authentication");
    expect(JSON.stringify(result)).not.toContain("legacy-auth-json-token");
    expect(JSON.stringify(result)).not.toContain("legacy-api-key");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not log a failed Copilot auth resolution", async () => {
    const secret = "copilot-auth-resolution-secret";
    const debugLog = vi.spyOn(types, "writeDebugLog");

    await fetchCopilotUsage(
      {
        getProviderAuth: vi.fn().mockRejectedValue(new Error(secret)),
      },
      {},
    );

    expect(
      debugLog.mock.calls.every(([message]) => !message.includes(secret)),
    ).toBe(true);
  });

  it("does not treat Anthropic auth-token Bearer headers as OAuth usage auth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClaudeUsage(
      {
        getProviderAuth: vi.fn().mockResolvedValue({
          auth: { headers: { Authorization: "Bearer auth-token" } },
          source: "ANTHROPIC_AUTH_TOKEN",
        }),
      },
      {},
    );

    expect(result.error).toBe("Anthropic usage requires OAuth authentication");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose a failed Pi auth resolution in Claude usage output", async () => {
    const secret = "oauth-resolution-secret";
    const result = await fetchClaudeUsage(
      {
        getProviderAuth: vi.fn().mockRejectedValue(new Error(secret)),
      },
      {},
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.error).toBe("No credentials");
  });

  it("fetchCopilotUsage should use Pi API-key auth without using the minted OAuth token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          login: "octocat",
          copilot_plan: "individual",
          quota_reset_date_utc: "2026-03-01T00:00:00Z",
          quota_snapshots: {
            premium_interactions: { percent_remaining: 80 },
          },
        }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const getProviderAuth = vi.fn(async () => ({
      auth: { apiKey: "github-oauth-token" },
      source: "environment",
    }));
    const result = await fetchCopilotUsage({ getProviderAuth }, {});

    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(getProviderAuth).toHaveBeenCalledWith("github-copilot");
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected a Copilot usage request");
    const request = firstCall[1];
    if (!request) throw new Error("Expected Copilot request options");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "token github-oauth-token",
    );
  });

  it("fetchCopilotUsage should not add a minted Copilot token from legacy auth storage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const getApiKey = vi.fn(async (providerId: string) =>
      providerId === "github-copilot" ? "minted-copilot-token" : undefined,
    );
    const getProviderAuth = vi.fn(async () => ({
      auth: { apiKey: "minted-copilot-token" },
      source: "OAuth",
    }));

    const result = await fetchCopilotUsage(
      {
        getProviderAuth,
        authStorage: {
          getApiKey,
          get: vi.fn().mockResolvedValue(undefined),
        },
      },
      {},
    );

    expect(getProviderAuth).toHaveBeenCalledWith("github-copilot");
    expect(result[0]?.error).not.toContain("minted-copilot-token");
    expect(
      fetchMock.mock.calls.every(
        ([, options]) =>
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization !== "token minted-copilot-token",
      ),
    ).toBe(true);
    expect(getApiKey).toHaveBeenCalledWith("github-copilot");
  });

  it("fetchCopilotUsage should use the stored GitHub token behind Pi's OAuth credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          login: "octocat",
          copilot_plan: "individual",
          quota_snapshots: {
            premium_interactions: { percent_remaining: 80 },
          },
        }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotUsage(
      {
        getProviderAuth: vi.fn(async () => ({
          auth: { apiKey: "minted-copilot-token" },
          source: "OAuth",
        })),
      },
      {
        "github-copilot": {
          type: "oauth",
          access: "minted-copilot-token",
          refresh: "github-oauth-token",
        },
      },
    );

    expect(result[0]?.error).toBeUndefined();
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected a Copilot usage request");
    const request = firstCall[1];
    if (!request) throw new Error("Expected Copilot request options");
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "token github-oauth-token",
    );
  });

  it("fetchClaudeUsage should use registry Anthropic token when available", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ five_hour: { utilization: 20 } }),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 401 } as Response);
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: (id: string) =>
            id === "anthropic"
              ? Promise.resolve("registry-token")
              : Promise.resolve(undefined),
          get: () => Promise.resolve(undefined),
        },
      },
      { anthropic: { access: "stale-auth-json-token" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.account).toBe("registry:anthropic:apiKey");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchClaudeUsage should fall back from registry token to auth.json token", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-token") {
          return Promise.resolve({ ok: false, status: 401 } as Response);
        }

        if (auth === "Bearer auth-json-token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ five_hour: { utilization: 10 } }),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 401 } as Response);
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: (id: string) =>
            id === "anthropic"
              ? Promise.resolve("registry-token")
              : Promise.resolve(undefined),
          get: () => Promise.resolve(undefined),
        },
      },
      { anthropic: { access: "auth-json-token" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.account).toBe("auth.json");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchClaudeUsage should return non-auth HTTP errors after exhausting credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
    );

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: (id: string) =>
            id === "anthropic"
              ? Promise.resolve("registry-token")
              : Promise.resolve(undefined),
          get: () => Promise.resolve(undefined),
        },
      },
      {},
    );

    expect(result.error).toBe("HTTP 500");
    expect(result.account).toBe("registry:anthropic:apiKey");
  });

  it("fetchAllCodexUsages should use Pi's resolved OAuth token and derive its account ID", async () => {
    vi.spyOn(fs.promises, "stat").mockRejectedValue(new Error("no codex home"));

    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "jwt-account",
        },
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          rate_limit: {
            primary_window: { used_percent: 20 },
          },
        }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const getProviderAuth = vi.fn(async () => ({
      auth: { apiKey: token },
      source: "OAuth",
    }));
    const result = await fetchAllCodexUsages({ getProviderAuth }, {});

    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBeUndefined();
    expect(result[0]?.account).toBe("jwt-account");
    expect(getProviderAuth).toHaveBeenCalledWith("openai-codex");
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("Expected a Codex usage request");
    const request = firstCall[1];
    if (!request) throw new Error("Expected Codex request options");
    expect(
      (request.headers as Record<string, string>)["ChatGPT-Account-Id"],
    ).toBe("jwt-account");
  });

  it("fetchGeminiUsage should discover registry google-gemini-cli tokens", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-cli-token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                buckets: [
                  { modelId: "gemini-1.5-flash", remainingFraction: 0.5 },
                ],
              }),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 401 } as Response);
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGeminiUsage(
      {
        authStorage: {
          getApiKey: (id: string) =>
            id === "google-gemini-cli"
              ? Promise.resolve("registry-cli-token")
              : Promise.resolve(undefined),
          get: () => Promise.resolve(undefined),
        },
      },
      {
        "google-gemini-cli": { projectId: "pid" },
      },
    );

    expect(result[0]!.error).toBeUndefined();
    expect(result[0]!.account).toBe("pid");
    expect(result[0]!.windows[0]?.label).toBe("Flash");
  });

  it("fetchGeminiUsage should return Missing projectId when none is discovered", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const result = await fetchGeminiUsage(
      {
        authStorage: {
          getApiKey: (id: string) =>
            id === "google-gemini"
              ? Promise.resolve("token-without-project")
              : Promise.resolve(undefined),
          get: () => Promise.resolve(undefined),
        },
      },
      {},
    );

    expect(result[0]!.error).toBe("Missing projectId");
  });

  it("fetchGeminiUsage should proactively refresh expired tokens", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                access_token: "refreshed-token",
                expires_in: 3600,
              }),
          } as Response);
        }

        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";
        if (auth === "Bearer refreshed-token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                buckets: [
                  { modelId: "gemini-1.5-pro", remainingFraction: 0.75 },
                ],
              }),
          } as Response);
        }

        return Promise.resolve({ ok: false, status: 401 } as Response);
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGeminiUsage(
      {},
      {
        "google-gemini-cli": {
          access: "expired-token",
          refresh: "refresh-token",
          projectId: "pid",
          clientId: "client-id",
          clientSecret: "client-secret",
          expires: Date.now() - 60_000,
        },
      },
    );

    expect(result[0]!.error).toBeUndefined();
    expect(result[0]!.account).toBe("pid");
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "oauth2.googleapis.com/token",
    );
  });

  it("refreshGoogleToken should include client_secret when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ access_token: "new-token", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshGoogleToken("refresh-token", "client-id", "client-secret");

    const options = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = options?.body as URLSearchParams;
    expect(body.toString()).toContain("client_id=client-id");
    expect(body.toString()).toContain("client_secret=client-secret");
  });
});
