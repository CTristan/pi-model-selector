import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CLOUD_SHELL_CLIENT_ID,
  refreshGoogleToken,
} from "../src/fetchers/common.js";

describe("Google Auth (common.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should only include client_secret when clientId matches", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ access_token: "new-token", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // 1. Matching clientId
    await refreshGoogleToken("ref-token", "my-client-id", "my-secret");
    const body = (
      mockFetch.mock.calls![0]![1]! as { body: URLSearchParams }
    ).body.toString();
    expect(body).toContain("client_id=my-client-id");
    expect(body).toContain("client_secret=my-secret");

    // 2. Fallback to GOOGLE_CLOUD_SHELL_CLIENT_ID (clientId is undefined)
    // It should try undefined (no client_id/secret) then GOOGLE_CLOUD_SHELL_CLIENT_ID
    mockFetch.mockClear();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401 }) // Fail first attempt (undefined client_id)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "new-token", expires_in: 3600 }),
      });

    await refreshGoogleToken("ref-token", undefined, "my-secret");

    // First call (undefined client_id)
    const body1 = (
      mockFetch.mock.calls![0]![1]! as { body: URLSearchParams }
    ).body.toString();
    expect(body1).not.toContain("client_id=");
    expect(body1).not.toContain("client_secret=");

    // Second call (GOOGLE_CLOUD_SHELL_CLIENT_ID)
    const body2 = (
      mockFetch.mock.calls![1]![1]! as { body: URLSearchParams }
    ).body.toString();
    expect(body2).toContain(`client_id=${GOOGLE_CLOUD_SHELL_CLIENT_ID}`);
    expect(body2).not.toContain("client_secret=");
  });

  it("should try fallback client ID if explicit clientId fails", async () => {
    const attemptedClientIds: (string | undefined)[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        const body = (options as RequestInit).body as URLSearchParams;
        attemptedClientIds.push(body.get("client_id") ?? undefined);

        if (body.get("client_id") === GOOGLE_CLOUD_SHELL_CLIENT_ID) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                access_token: "fallback-token",
                expires_in: 3600,
              }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "invalid_client" }),
        });
      }),
    );

    const result = await refreshGoogleToken(
      "refresh-token",
      "explicit-client-id",
    );

    expect(attemptedClientIds).toContain("explicit-client-id");
    expect(attemptedClientIds).toContain(GOOGLE_CLOUD_SHELL_CLIENT_ID);
    expect(result?.accessToken).toBe("fallback-token");
  });
});
