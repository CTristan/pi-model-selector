import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_WINDOW_SAFETY_RATIO,
  filterByContextWindow,
} from "../src/context.js";
import type { LoadedConfig, UsageCandidate } from "../src/types.js";

describe("filterByContextWindow", () => {
  const mockCtx = {
    getContextUsage: vi.fn(),
    modelRegistry: {
      find: vi.fn(),
    },
  } as any;

  const mockConfig: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "anthropic", window: "Sonnet" },
        model: { provider: "anthropic", id: "claude-3-5-sonnet" },
      },
      {
        usage: { provider: "anthropic", window: "Opus" },
        model: { provider: "anthropic", id: "claude-3-opus" },
      },
      {
        usage: { provider: "copilot", window: "Chat" },
        model: { provider: "github-copilot", id: "gpt-4o" },
      },
    ],
    priority: ["fullAvailability", "remainingPercent", "earliestReset"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    compactOnSwitch: false,
    disabledProviders: [],
    debugLog: { enabled: false, path: "/tmp/test.log" },
    sources: {
      globalPath: "/tmp/global.json",
      projectPath: "/tmp/project.json",
    },
    raw: { global: {}, project: {} },
  };

  const mockCandidates: UsageCandidate[] = [
    {
      provider: "anthropic",
      displayName: "Claude",
      windowLabel: "Sonnet",
      usedPercent: 30,
      remainingPercent: 70,
    },
    {
      provider: "anthropic",
      displayName: "Claude",
      windowLabel: "Opus",
      usedPercent: 50,
      remainingPercent: 50,
    },
    {
      provider: "copilot",
      displayName: "Copilot",
      windowLabel: "Chat",
      usedPercent: 10,
      remainingPercent: 90,
    },
    {
      provider: "anthropic",
      displayName: "Claude",
      windowLabel: "Unmapped",
      usedPercent: 20,
      remainingPercent: 80,
    },
  ];

  const mockModels = {
    claudeSonnet: {
      contextWindow: 200000,
      provider: { id: "anthropic" },
      id: "claude-3-5-sonnet",
    },
    claudeOpus: {
      contextWindow: 100000,
      provider: { id: "anthropic" },
      id: "claude-3-opus",
    },
    copilot: {
      contextWindow: 128000,
      provider: { id: "github-copilot" },
      id: "gpt-4o",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes candidates with adequate context window", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 100000,
      contextWindow: 200000,
      percent: 50,
    });
    mockCtx.modelRegistry.find.mockImplementation(
      (_provider: string, id: string) => {
        if (id === "claude-3-5-sonnet") return mockModels.claudeSonnet;
        if (id === "claude-3-opus") return mockModels.claudeOpus;
        if (id === "gpt-4o") return mockModels.copilot;
        return undefined;
      },
    );

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    expect(result.eligible).toHaveLength(3); // Sonnet, Chat, Unmapped
    expect(result.filtered).toHaveLength(1); // Opus filtered (100K > 80K)
  });

  it("filters candidates with too-small context window", () => {
    // 150K tokens, Claude Sonnet (200K) should pass, Claude Opus (100K) and Chat (128K) should be filtered
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    mockCtx.modelRegistry.find.mockImplementation(
      (_provider: string, id: string) => {
        if (id === "claude-3-5-sonnet") return mockModels.claudeSonnet;
        if (id === "claude-3-opus") return mockModels.claudeOpus;
        if (id === "gpt-4o") return mockModels.copilot;
        return undefined;
      },
    );

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    expect(result.eligible).toHaveLength(2); // Sonnet, Unmapped
    expect(result.filtered).toHaveLength(2); // Opus and Chat filtered
  });

  it("skips filtering when tokens is null (unknown context size)", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: null,
      contextWindow: 200000,
      percent: null,
    });

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    expect(result.eligible).toHaveLength(4); // All candidates pass
    expect(result.filtered).toHaveLength(0);
    expect(mockCtx.modelRegistry.find).not.toHaveBeenCalled();
  });

  it("respects safety buffer (80% threshold)", () => {
    // At exactly 80% (160K of 200K), should pass
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 160000,
      contextWindow: 200000,
      percent: 80,
    });
    mockCtx.modelRegistry.find.mockReturnValue(mockModels.claudeSonnet);

    const result1 = filterByContextWindow(
      [mockCandidates[0]!],
      mockConfig,
      mockCtx,
    );
    expect(result1.eligible).toHaveLength(1);
    expect(result1.filtered).toHaveLength(0);

    // At 81% (162K of 200K), should be filtered
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 162000,
      contextWindow: 200000,
      percent: 81,
    });
    const result2 = filterByContextWindow(
      [mockCandidates[0]!],
      mockConfig,
      mockCtx,
    );
    expect(result2.eligible).toHaveLength(0);
    expect(result2.filtered).toHaveLength(1);
  });

  it("does not filter candidates without model mappings", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 500000,
      contextWindow: 200000,
      percent: 250,
    });
    mockCtx.modelRegistry.find.mockImplementation(
      (_provider: string, id: string) => {
        if (id === "claude-3-5-sonnet") return mockModels.claudeSonnet;
        if (id === "claude-3-opus") return mockModels.claudeOpus;
        if (id === "gpt-4o") return mockModels.copilot;
        return undefined;
      },
    );

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    // Unmapped candidate should still be eligible (will fail later at mapping check)
    const unmapped = result.eligible.find((c) => c.windowLabel === "Unmapped");
    expect(unmapped).toBeDefined();
    expect(result.eligible).toHaveLength(1); // Only unmapped
    expect(result.filtered).toHaveLength(3); // All mapped filtered
  });

  it("marks filtered candidates with contextFiltered = true", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    mockCtx.modelRegistry.find.mockImplementation(
      (_provider: string, id: string) => {
        if (id === "claude-3-5-sonnet") return mockModels.claudeSonnet;
        if (id === "claude-3-opus") return mockModels.claudeOpus;
        if (id === "gpt-4o") return mockModels.copilot;
        return undefined;
      },
    );

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    expect(result.filtered[0]?.contextFiltered).toBe(true);
  });

  it("returns all candidates as filtered when all exceed context window", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 500000,
      contextWindow: 200000,
      percent: 250,
    });
    mockCtx.modelRegistry.find.mockImplementation(
      (_provider: string, id: string) => {
        if (id === "claude-3-5-sonnet") return mockModels.claudeSonnet;
        if (id === "claude-3-opus") return mockModels.claudeOpus;
        if (id === "gpt-4o") return mockModels.copilot;
        return undefined;
      },
    );

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    expect(result.eligible).toHaveLength(1); // Only Unmapped (no model to filter)
    expect(result.filtered).toHaveLength(3); // All mapped candidates filtered
  });

  it("handles model not found in registry", () => {
    mockCtx.getContextUsage.mockReturnValue({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    mockCtx.modelRegistry.find.mockReturnValue(undefined); // Model not found

    const result = filterByContextWindow(mockCandidates, mockConfig, mockCtx);

    // Candidates with unmapped/missing models should not be filtered
    expect(result.eligible).toHaveLength(4);
    expect(result.filtered).toHaveLength(0);
  });
});

describe("CONTEXT_WINDOW_SAFETY_RATIO", () => {
  it("is defined and within reasonable bounds", () => {
    expect(CONTEXT_WINDOW_SAFETY_RATIO).toBeDefined();
    expect(CONTEXT_WINDOW_SAFETY_RATIO).toBeGreaterThan(0);
    expect(CONTEXT_WINDOW_SAFETY_RATIO).toBeLessThanOrEqual(1);
    expect(CONTEXT_WINDOW_SAFETY_RATIO).toBe(0.8); // Current value
  });
});
