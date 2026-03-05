import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactAndAwait, handleCompactOnSwitch } from "../src/context.js";

describe("compactAndAwait", () => {
  const mockCtx = {
    compact: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("resolves with success on compaction completion", async () => {
    mockCtx.compact.mockImplementation((options: any) => {
      options.onComplete();
    });

    const result = await compactAndAwait(mockCtx);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockCtx.compact).toHaveBeenCalled();
  });

  it("resolves with error on compaction failure", async () => {
    mockCtx.compact.mockImplementation((options: any) => {
      options.onError(new Error("Compaction failed"));
    });

    const result = await compactAndAwait(mockCtx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Compaction failed");
  });

  it("handles compaction throwing an error", async () => {
    mockCtx.compact.mockImplementation(() => {
      throw new Error("Internal error");
    });

    const result = await compactAndAwait(mockCtx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Error: Internal error");
  });

  it("passes custom instructions to ctx.compact", async () => {
    let receivedOptions: any = null;
    mockCtx.compact.mockImplementation((options: any) => {
      receivedOptions = options;
      options.onComplete();
    });

    const result = await compactAndAwait(mockCtx, {
      customInstructions: "Custom instructions",
    });

    expect(result.success).toBe(true);
    expect(receivedOptions.customInstructions).toBe("Custom instructions");
  });
});

describe("handleCompactOnSwitch", () => {
  const mockCtx = {
    compact: vi.fn(),
    model: undefined as any,
  } as any;

  const mockConfig: any = {
    compactOnSwitch: true,
  };

  const selectedModel = { provider: "anthropic", id: "claude-3-5-sonnet" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockConfig.compactOnSwitch = true;
  });

  it("skips when compactOnSwitch is disabled", async () => {
    mockConfig.compactOnSwitch = false;

    const result = await handleCompactOnSwitch(
      mockCtx,
      undefined,
      selectedModel,
      mockConfig,
    );

    expect(result.compacted).toBe(false);
    expect(mockCtx.compact).not.toHaveBeenCalled();
  });

  it("skips when model has not changed", async () => {
    mockCtx.model = {
      provider: "anthropic",
      id: "claude-3-5-sonnet",
    };

    const result = await handleCompactOnSwitch(
      mockCtx,
      mockCtx.model,
      selectedModel,
      mockConfig,
    );

    expect(result.compacted).toBe(false);
    expect(mockCtx.compact).not.toHaveBeenCalled();
  });

  it("attempts compaction when model changes and compactOnSwitch is enabled", async () => {
    mockCtx.model = {
      provider: "github-copilot",
      id: "gpt-4o",
    };
    mockCtx.compact.mockImplementation((options: any) => {
      options.onComplete();
    });

    const result = await handleCompactOnSwitch(
      mockCtx,
      mockCtx.model,
      selectedModel,
      mockConfig,
    );

    expect(result.compacted).toBe(true);
    expect(mockCtx.compact).toHaveBeenCalled();
  });

  it("returns compacted=false on compaction failure", async () => {
    mockCtx.model = {
      provider: "github-copilot",
      id: "gpt-4o",
    };
    mockCtx.compact.mockImplementation((options: any) => {
      options.onError(new Error("Compaction failed"));
    });

    const result = await handleCompactOnSwitch(
      mockCtx,
      mockCtx.model,
      selectedModel,
      mockConfig,
    );

    expect(result.compacted).toBe(false);
    expect(result.error).toBe("Compaction failed");
  });

  it("handles case when current model is undefined", async () => {
    mockCtx.model = undefined;
    mockCtx.compact.mockImplementation((options: any) => {
      options.onComplete();
    });

    const result = await handleCompactOnSwitch(
      mockCtx,
      undefined,
      selectedModel,
      mockConfig,
    );

    expect(result.compacted).toBe(true);
    expect(mockCtx.compact).toHaveBeenCalled();
  });
});
