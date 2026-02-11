/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  fetchClaudeUsage,
  fetchGeminiUsage,
  refreshGoogleToken,
} from "../src/usage-fetchers.js";

describe("Provider auth fallback behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchClaudeUsage should use registry Anthropic token when available", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-token") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ five_hour: { utilization: 0.2 } }),
          } as Response;
        }

        return { ok: false, status: 401 } as Response;
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: async (id: string) =>
            id === "anthropic" ? "registry-token" : undefined,
          get: async () => undefined,
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
      .mockImplementation(async (_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-token") {
          return { ok: false, status: 401 } as Response;
        }

        if (auth === "Bearer auth-json-token") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ five_hour: { utilization: 0.1 } }),
          } as Response;
        }

        return { ok: false, status: 401 } as Response;
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: async (id: string) =>
            id === "anthropic" ? "registry-token" : undefined,
          get: async () => undefined,
        },
      },
      { anthropic: { access: "auth-json-token" } },
    );

    expect(result.error).toBeUndefined();
    expect(result.account).toBe("auth.json");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchClaudeUsage should return non-auth HTTP errors immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
    );

    const result = await fetchClaudeUsage(
      {
        authStorage: {
          getApiKey: async (id: string) =>
            id === "anthropic" ? "registry-token" : undefined,
          get: async () => undefined,
        },
      },
      {},
    );

    expect(result.error).toBe("HTTP 500");
    expect(result.account).toBe("registry:anthropic:apiKey");
  });

  it("fetchGeminiUsage should discover registry google-gemini-cli tokens", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, options?: RequestInit) => {
        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";

        if (auth === "Bearer registry-cli-token") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              buckets: [
                { modelId: "gemini-1.5-flash", remainingFraction: 0.5 },
              ],
            }),
          } as Response;
        }

        return { ok: false, status: 401 } as Response;
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGeminiUsage(
      {
        authStorage: {
          getApiKey: async (id: string) =>
            id === "google-gemini-cli" ? "registry-cli-token" : undefined,
          get: async () => undefined,
        },
      },
      {
        "google-gemini-cli": { projectId: "pid" },
      },
    );

    expect(result[0].error).toBeUndefined();
    expect(result[0].account).toBe("pid");
    expect(result[0].windows[0]?.label).toBe("Flash");
  });

  it("fetchGeminiUsage should return Missing projectId when none is discovered", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const result = await fetchGeminiUsage(
      {
        authStorage: {
          getApiKey: async (id: string) =>
            id === "google-gemini" ? "token-without-project" : undefined,
          get: async () => undefined,
        },
      },
      {},
    );

    expect(result[0].error).toBe("Missing projectId");
  });

  it("fetchGeminiUsage should proactively refresh expired tokens", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(new Error("no file"));

    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "refreshed-token",
              expires_in: 3600,
            }),
          } as Response;
        }

        const auth =
          (options?.headers as Record<string, string> | undefined)
            ?.Authorization || "";
        if (auth === "Bearer refreshed-token") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              buckets: [{ modelId: "gemini-1.5-pro", remainingFraction: 0.75 }],
            }),
          } as Response;
        }

        return { ok: false, status: 401 } as Response;
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

    expect(result[0].error).toBeUndefined();
    expect(result[0].account).toBe("pid");
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "oauth2.googleapis.com/token",
    );
  });

  it("refreshGoogleToken should include client_secret when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-token", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshGoogleToken("refresh-token", "client-id", "client-secret");

    const options = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = options?.body as URLSearchParams;
    expect(body.toString()).toContain("client_id=client-id");
    expect(body.toString()).toContain("client_secret=client-secret");
  });
});
