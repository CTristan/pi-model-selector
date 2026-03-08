import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as common from "../src/fetchers/common.js";
import { fetchMinimaxUsage } from "../src/fetchers/minimax.js";

vi.mock("../src/fetchers/common.js", async () => {
  const actual = await vi.importActual("../src/fetchers/common.js");
  return {
    ...(actual as any),
    fetchWithTimeout: vi.fn(),
  };
});

describe("Minimax Fetcher", () => {
  const mockPiAuth = {
    minimax: {
      key: "sk-cp-test-key",
    },
  };
  const mockGroupId = "test-group-id";

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.MINIMAX_API_KEY = "";
    process.env.MINIMAX_GROUP_ID = "";
  });

  afterEach(() => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_GROUP_ID;
  });

  it("should return error if no API key is found", async () => {
    const result = await fetchMinimaxUsage({}, mockGroupId);
    expect(result.error).toContain("No API key found");
    expect(result.windows).toHaveLength(0);
  });

  it("should return error if no GroupId is found", async () => {
    const result = await fetchMinimaxUsage(mockPiAuth);
    expect(result.error).toContain("No GroupId found");
    expect(result.windows).toHaveLength(0);
  });

  it("should fetch usage successfully with multiple models", async () => {
    const mockResponse = {
      model_remains: [
        {
          model_name: "MiniMax-M2",
          current_interval_total_count: 1500,
          current_interval_usage_count: 150,
          end_time: 1772859600000,
        },
        {
          model_name: "MiniMax-M2.5",
          current_interval_total_count: 1000,
          current_interval_usage_count: 900,
          end_time: 1772859600000,
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    };

    vi.mocked(common.fetchWithTimeout).mockResolvedValue({
      res: { ok: true } as Response,
      data: mockResponse,
    });

    const result = await fetchMinimaxUsage(mockPiAuth, mockGroupId);

    expect(result.provider).toBe("minimax");
    expect(result.error).toBeUndefined();
    expect(result.windows).toHaveLength(2);

    const window0 = result.windows[0];
    const window1 = result.windows[1];
    if (!window0 || !window1) throw new Error("Windows not found");

    expect(window0.label).toBe("MiniMax-M2");
    expect(window0.usedPercent).toBe(90); // (1500-150)/1500*100
    expect(window0.resetsAt?.getTime()).toBe(1772859600000);

    expect(window1.label).toBe("MiniMax-M2.5");
    expect(window1.usedPercent).toBe(10); // (1000-900)/1000*100
  });

  it("should handle API errors", async () => {
    const mockResponse = {
      base_resp: { status_code: 1001, status_msg: "Invalid GroupId" },
    };

    vi.mocked(common.fetchWithTimeout).mockResolvedValue({
      res: { ok: true } as Response,
      data: mockResponse,
    });

    const result = await fetchMinimaxUsage(mockPiAuth, mockGroupId);
    expect(result.error).toContain("API Error: Invalid GroupId (code: 1001)");
  });

  it("should handle HTTP errors", async () => {
    vi.mocked(common.fetchWithTimeout).mockResolvedValue({
      res: { ok: false, status: 401, statusText: "Unauthorized" } as Response,
    });

    const result = await fetchMinimaxUsage(mockPiAuth, mockGroupId);
    expect(result.error).toBe("HTTP 401 Unauthorized");
  });

  it("should prioritize environment variables", async () => {
    process.env.MINIMAX_API_KEY = "env-key";
    process.env.MINIMAX_GROUP_ID = "env-group";

    vi.mocked(common.fetchWithTimeout).mockResolvedValue({
      res: { ok: true } as Response,
      data: {
        model_remains: [],
        base_resp: { status_code: 0, status_msg: "success" },
      },
    });

    await fetchMinimaxUsage(mockPiAuth, mockGroupId);

    const callArgs = vi.mocked(common.fetchWithTimeout).mock.calls[0];
    if (!callArgs) throw new Error("fetchWithTimeout was not called");
    const callUrl = callArgs[0] as string;
    const callOptions = callArgs[1] as any;
    const callHeaders = callOptions?.headers as any;

    expect(callUrl).toContain("GroupId=env-group");
    expect(callHeaders.Authorization).toBe("Bearer env-key");
  });
});
