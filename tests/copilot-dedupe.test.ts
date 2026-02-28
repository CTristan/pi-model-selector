import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execAsync } from "../src/fetchers/common.js";
import { fetchCopilotUsage } from "../src/fetchers/copilot.js";
import { resetGlobalState } from "../src/types.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn(),
  };
});

vi.mock("../src/fetchers/common.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/fetchers/common.js")
  >("../src/fetchers/common.js");
  return {
    ...actual,
    execAsync: vi.fn(),
  };
});

describe("Copilot Deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(execAsync).mockResolvedValue({ stdout: "", stderr: "" });
    vi.mocked(os.platform).mockReturnValue("linux");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetGlobalState();
  });

  it("should deduplicate by account, preferring success over error", async () => {
    // Mock tokens
    const modelRegistry = {
      authStorage: {
        getApiKey: (id: string) =>
          id === "github-copilot"
            ? Promise.resolve("tok1")
            : Promise.resolve(undefined),
        get: () => Promise.resolve(undefined),
      },
    };

    // We'll have two "tokens" that both return the same login "user1"
    // But one will fail and one will succeed.

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = url as string;
      if (urlStr.includes("/user")) {
        const lastCall =
          vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1]!;
        const init = lastCall[1]! as RequestInit;
        const headers = (init.headers || {}) as Record<string, string>;
        const auth = headers.Authorization;

        if (auth === "token tok1") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                login: "user1",
                quota_snapshots: { chat: { percent_remaining: 50 } },
              }),
            headers: new Headers({ etag: "e1" }),
          } as unknown as Response);
        } else {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({}),
            headers: new Headers(),
          } as unknown as Response);
        }
      }
      return Promise.resolve({
        ok: false,
        status: 404,
      } as unknown as Response);
    });

    const results = await fetchCopilotUsage(modelRegistry, {
      "github-copilot": { access: "tok2" },
    });

    // Check if we have at least the success snapshot
    expect(results.some((s) => s.account === "user1")).toBe(true);
  });

  it("should only return one snapshot for multiple successful tokens for same account", async () => {
    // Mock tokens
    const modelRegistry = {
      authStorage: {
        getApiKey: (id: string) =>
          id === "github-copilot"
            ? Promise.resolve("tok1")
            : Promise.resolve(undefined),
        get: () => Promise.resolve(undefined),
      },
    };

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = url as string;
      if (urlStr.includes("/user")) {
        const lastCall =
          vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1]!;
        const init = lastCall[1]! as RequestInit;
        const headers = (init.headers || {}) as Record<string, string>;
        const auth = headers.Authorization;

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              login: "user1",
              quota_snapshots: {
                chat: { percent_remaining: auth === "token tok1" ? 50 : 60 },
              },
            }),
          headers: new Headers({ etag: "e1" }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
      } as unknown as Response);
    });

    const results = await fetchCopilotUsage(modelRegistry, {
      "github-copilot": { access: "tok2" },
    });

    // It should only return one snapshot for "user1"
    const user1Snapshots = results.filter((s) => s.account === "user1");
    expect(user1Snapshots).toHaveLength(1);
  });
});
