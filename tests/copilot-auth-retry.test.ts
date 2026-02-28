import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execAsync, URLS } from "../src/fetchers/common.js";
import { fetchCopilotUsage } from "../src/fetchers/copilot.js";

vi.mock("../src/fetchers/common.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/fetchers/common.js")
  >("../src/fetchers/common.js");
  return {
    ...actual,
    execAsync: vi.fn(),
  };
});

describe("Copilot 401 Error Regression", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should retry with Bearer in tryExchange if token header fails with 401", async () => {
    // Mock gh-cli token
    vi.mocked(execAsync).mockResolvedValue({ stdout: "gho_token", stderr: "" });

    const fetchMock = vi.mocked(fetch);

    // 1st call: user endpoint with "token gho_token" -> 401
    // 2nd call: user endpoint with "Bearer gho_token" -> 401
    // 3rd call: token exchange endpoint with "token gho_token" -> 401 (This is what we want to fix)
    // 4th call: token exchange endpoint with "Bearer gho_token" -> 200 (Success after fix)
    // 5th call: user endpoint with "Bearer tid_token" -> 200 (Success)

    fetchMock.mockImplementation((url, options) => {
      const headers = options?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization;

      if (url === URLS.COPILOT_USER) {
        if (auth === "token gho_token" || auth === "Bearer gho_token") {
          return Promise.resolve({ ok: false, status: 401 } as Response);
        }
        if (auth === "Bearer tid_token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                login: "test-user",
                quota_snapshots: { chat: { percent_remaining: 80 } },
              }),
          } as Response);
        }
      }

      if (url === URLS.COPILOT_TOKEN) {
        if (auth === "token gho_token") {
          return Promise.resolve({ ok: false, status: 401 } as Response);
        }
        if (auth === "Bearer gho_token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ token: "tid_token", sku: "monthly" }),
          } as Response);
        }
      }

      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const results = await fetchCopilotUsage({}, {});

    // If the fix is NOT implemented, it will fail to exchange and return 401.
    // We want it to succeed.
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.account).toBe("test-user");
    expect(results[0]!.windows[0]!.usedPercent).toBe(20);
  });

  it("should suppress 401 errors from invalid tokens if at least one token succeeds", async () => {
    // 1 valid token from gh-cli, 1 invalid from registry
    vi.mocked(execAsync).mockResolvedValue({
      stdout: "valid_gh_token",
      stderr: "",
    });

    const mr = {
      authStorage: {
        getApiKey: (id: string) =>
          id === "github-copilot"
            ? Promise.resolve("tid=invalid_token")
            : Promise.resolve(undefined),
        get: () => Promise.resolve(undefined),
      },
    };

    const fetchMock = vi.mocked(fetch);

    fetchMock.mockImplementation((url, options) => {
      const headers = options?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization;

      if (url === URLS.COPILOT_USER) {
        if (auth === "Bearer tid=invalid_token") {
          return Promise.resolve({ ok: false, status: 401 } as Response);
        }
        if (auth === "token valid_gh_token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                login: "valid-user",
                quota_snapshots: { chat: { percent_remaining: 100 } },
              }),
          } as Response);
        }
      }
      if (url === URLS.COPILOT_TOKEN) {
        return Promise.resolve({ ok: false, status: 401 } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const results = await fetchCopilotUsage(mr, {});

    // Should contain ONLY the success from valid token
    // The invalid token error is suppressed because one account succeeded and the error is anonymous.
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("valid-user");
    expect(results[0]!.error).toBeUndefined();
  });

  it("should suppress stale auth.json token errors when gh-cli succeeds", async () => {
    vi.mocked(execAsync).mockResolvedValue({
      stdout: "valid_gh_token",
      stderr: "",
    });

    const fetchMock = vi.mocked(fetch);

    fetchMock.mockImplementation((url, options) => {
      const headers = options?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization;

      if (url === URLS.COPILOT_USER) {
        if (auth === "Bearer tid=stale_token") {
          return Promise.resolve({ ok: false, status: 401 } as Response);
        }

        if (auth === "token valid_gh_token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                login: "valid-user",
                quota_snapshots: { chat: { percent_remaining: 100 } },
              }),
          } as Response);
        }
      }

      if (url === URLS.COPILOT_TOKEN) {
        return Promise.resolve({ ok: false, status: 401 } as Response);
      }

      return Promise.resolve({ ok: false, status: 404 } as Response);
    });

    const results = await fetchCopilotUsage(
      {},
      {
        "github-copilot": { access: "tid=stale_token" },
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("valid-user");
    expect(results[0]!.error).toBeUndefined();
  });
});
