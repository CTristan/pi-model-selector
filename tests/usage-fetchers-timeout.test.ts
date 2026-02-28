import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_DISPLAY_NAMES } from "../src/fetchers/common.js";
import { fetchAllUsages } from "../src/usage-fetchers.js";

vi.mock("../src/fetchers/common.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/fetchers/common.js")
  >("../src/fetchers/common.js");
  return {
    ...actual,
    loadPiAuth: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("../src/fetchers/zai.js", () => ({
  fetchZaiUsage: vi.fn().mockRejectedValue(new Error("boom")),
}));

const disabledProviders = [
  "anthropic",
  "copilot",
  "gemini",
  "codex",
  "antigravity",
  "kiro",
];

describe("fetchAllUsages fallback branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses provider fallback display name and handles missing timer", async () => {
    const originalName = PROVIDER_DISPLAY_NAMES.zai;
    PROVIDER_DISPLAY_NAMES.zai = "";

    const setTimeoutSpy = vi
      .spyOn(global, "setTimeout")
      .mockImplementation(() => undefined as unknown as NodeJS.Timeout);

    try {
      const results = await fetchAllUsages({}, disabledProviders);

      expect(results).toHaveLength(1);
      expect(results[0]!.displayName).toBe("zai");
    } finally {
      PROVIDER_DISPLAY_NAMES.zai = originalName!;
      setTimeoutSpy.mockRestore();
    }
  });
});
