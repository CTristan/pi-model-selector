import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execAsync } from "../src/fetchers/common.js";
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

describe("Copilot Token Fetch Isolation & Uniqueness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should isolate failures so one throwing token doesn't crash all", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Network failure for token 1"));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              login: "user2",
              quota_snapshots: { chat: { percent_remaining: 100 } },
            }),
        });
      }),
    );

    const results = await fetchCopilotUsage(
      {
        authStorage: {
          getApiKey: (id: string) => {
            if (id === "github-copilot") return Promise.resolve("tid=t1");
            if (id === "github") return Promise.resolve("tid=t2");
            return Promise.resolve(undefined);
          },
          get: () => Promise.resolve({}),
        },
      },
      {},
    );

    // One failed (t1), one succeeded (t2 -> user2).
    // The failure from t1 is suppressed because user2 succeeded and t1 is anonymous (registry).
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("user2");
    expect(results[0]!.error).toBeUndefined();
  });

  it("should use unique identifiers for fallback accounts", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

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
          getApiKey: (id: string) => {
            if (id === "github-copilot") return Promise.resolve("tid=t1");
            if (id === "github") return Promise.resolve("tid=t2");
            return Promise.resolve(undefined);
          },
          get: () => Promise.resolve({}),
        },
      },
      {},
    );

    // Both are 304 (success-ish), so they should both be included as long as they have unique accounts
    expect(results).toHaveLength(2);
    expect(results[0]!.account).not.toBe(results[1]!.account);
  });

  it("should suppress errors if at least one successful snapshot is found", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: false, status: 401 });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              login: "user2",
              quota_snapshots: { chat: { percent_remaining: 100 } },
            }),
        });
      }),
    );

    const results = await fetchCopilotUsage(
      {
        authStorage: {
          getApiKey: (id: string) => {
            if (id === "github-copilot") return Promise.resolve("tid=t1");
            if (id === "github") return Promise.resolve("tid=t2");
            return Promise.resolve(undefined);
          },
          get: () => Promise.resolve({}),
        },
      },
      {},
    );

    // One failed (t1 -> 401), one succeeded (t2 -> user2).
    // The failure from t1 is suppressed because user2 succeeded.
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("user2");
    expect(results[0]!.error).toBeUndefined();
  });

  it("should handle null modelRegistry gracefully", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    const results = await fetchCopilotUsage(null, {});

    // Should not throw, should return "No token found" snapshot if no other tokens
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBe("No token found");
  });

  it("should suppress error from second token for same account when first succeeds", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First token succeeds
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                login: "user1",
                quota_snapshots: { chat: { percent_remaining: 100 } },
              }),
          });
        }
        // Second token fails, but it's for the same account
        return Promise.resolve({ ok: false, status: 401 });
      }),
    );

    const results = await fetchCopilotUsage(
      {
        authStorage: {
          getApiKey: (id: string) => {
            if (id === "github-copilot") return Promise.resolve("tid=t1");
            if (id === "github") return Promise.resolve("tid=t2");
            return Promise.resolve(undefined);
          },
          get: () => Promise.resolve({}),
        },
      },
      {},
    );

    // Should only include the successful snapshot for user1
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("user1");
    expect(results[0]!.error).toBeUndefined();
  });

  it("should suppress error from first token for same account when second succeeds", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First token fails
          return Promise.resolve({ ok: false, status: 401 });
        }
        // Second token succeeds, but it's for the same account
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              login: "user1",
              quota_snapshots: { chat: { percent_remaining: 100 } },
            }),
        });
      }),
    );

    const results = await fetchCopilotUsage(
      {
        authStorage: {
          getApiKey: (id: string) => {
            if (id === "github-copilot") return Promise.resolve("tid=t1");
            if (id === "github") return Promise.resolve("tid=t2");
            return Promise.resolve(undefined);
          },
          get: () => Promise.resolve({}),
        },
      },
      {},
    );

    // Should only include the successful snapshot for user1
    expect(results).toHaveLength(1);
    expect(results[0]!.account).toBe("user1");
    expect(results[0]!.error).toBeUndefined();
  });
});
