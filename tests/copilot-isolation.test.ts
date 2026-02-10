import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCopilotUsage } from "../src/fetchers/copilot.js";
import { execAsync } from "../src/fetchers/common.js";

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

    // If isolation works, we should get one error snapshot and one success snapshot
    expect(results).toHaveLength(2);
    expect(
      results.some((r) => r.error && r.error.includes("Network failure")),
    ).toBe(true);
    expect(results.some((r) => r.account === "user2")).toBe(true);
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

    // If they are unique, we should have 2 snapshots even though both are 304-fallback
    // Wait, the current implementation deduplicates successful ones by account.
    // If they have the same account "304-fallback", one will be dropped.
    // So we expect 2 if they are unique.
    expect(results).toHaveLength(2);
    expect(results[0].account).not.toBe(results[1].account);
  });

  it("should not suppress errors if at least one successful snapshot is found", async () => {
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

    // We expect both the error from t1 and the success from t2
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.error)).toBe(true);
    expect(results.some((r) => r.account === "user2")).toBe(true);
  });

  it("should handle null modelRegistry gracefully", async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error("gh-cli fail"));

    const results = await fetchCopilotUsage(null, {});

    // Should not throw, should return "No token found" snapshot if no other tokens
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe("No token found");
  });
});
