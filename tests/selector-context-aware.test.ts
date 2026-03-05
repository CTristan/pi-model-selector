import { beforeEach, describe, expect, it, vi } from "vitest";
import * as configMod from "../src/config.js";
import type { CooldownManager } from "../src/cooldown.js";
import { runSelector } from "../src/selector.js";
import type { LoadedConfig, UsageSnapshot } from "../src/types.js";
import * as usageFetchers from "../src/usage-fetchers.js";

vi.mock("../src/config.js");
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Selector Context-Aware Integration", () => {
  const baseConfig: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
      },
      {
        usage: { provider: "p2", window: "w2" },
        model: { provider: "p2", id: "m2" },
      },
    ],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    compactOnSwitch: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  const baseUsages: UsageSnapshot[] = [
    {
      provider: "p1",
      displayName: "P1",
      windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
    },
    {
      provider: "p2",
      displayName: "P2",
      windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
    },
  ];

  const mockModels = {
    m1: { contextWindow: 100000, provider: { id: "p1" }, id: "m1" },
    m2: { contextWindow: 200000, provider: { id: "p2" }, id: "m2" },
  };

  const createCooldownManager = (): CooldownManager =>
    ({
      loadPersistedCooldowns: vi.fn().mockResolvedValue(undefined),
      pruneExpiredCooldowns: vi.fn(),
      setOrExtendProviderCooldown: vi.fn().mockReturnValue(false),
      getWildcardExpiry: vi.fn().mockReturnValue(undefined),
      isOnCooldown: vi.fn().mockReturnValue(false),
      clear: vi.fn(),
      setLastSelectedKey: vi.fn(),
      persistCooldowns: vi.fn().mockResolvedValue(undefined),
    }) as unknown as CooldownManager;

  const createModelLockCoordinator = () => ({
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    releaseAll: vi.fn().mockResolvedValue(0),
  });

  const createContext = (): any => ({
    modelRegistry: {
      find: vi.fn((_p, id) => {
        if (id === "m1") return mockModels.m1;
        if (id === "m2") return mockModels.m2;
        return undefined;
      }),
    },
    model: { provider: "p1", id: "m1" },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    hasUI: true,
    getContextUsage: vi
      .fn()
      .mockReturnValue({ tokens: 10000, contextWindow: 100000, percent: 10 }),
    compact: vi.fn().mockImplementation((opts) => opts.onComplete()),
  });

  const createPi = (): any => ({
    setModel: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configMod.loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(baseUsages);
  });

  it("switches to the best candidate when context window is adequate", async () => {
    const ctx = createContext();
    ctx.model = { provider: "other", id: "other" }; // Start on different model
    const pi = createPi();
    const result = await runSelector(
      ctx,
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(mockModels.m1); // m1 is better (10% used vs 20%)
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("filters out candidates with too-small context windows", async () => {
    const ctx = createContext();
    ctx.model = { provider: "other", id: "other" }; // Start on different model
    // 90K tokens -> m1 (100K window, 80K max) is too small
    ctx.getContextUsage.mockReturnValue({
      tokens: 90000,
      contextWindow: 100000,
      percent: 90,
    });
    const pi = createPi();

    const result = await runSelector(
      ctx,
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(mockModels.m2); // m1 filtered, m2 chosen
  });

  it("attempts compaction when all candidates are filtered by context and compactOnSwitch is true", async () => {
    const config = { ...baseConfig, compactOnSwitch: true };
    vi.mocked(configMod.loadConfig).mockResolvedValue(config);

    const ctx = createContext();
    ctx.model = { provider: "other", id: "other" }; // Start on different model
    // 1st call to filterByContextWindow: 180K tokens -> m1 (80K max) and m2 (160K max) are both too small
    ctx.getContextUsage.mockReturnValueOnce({
      tokens: 180000,
      contextWindow: 200000,
      percent: 90,
    });
    // 2nd call to filterByContextWindow (after compaction): 50K tokens -> both fit
    ctx.getContextUsage.mockReturnValueOnce({
      tokens: 50000,
      contextWindow: 200000,
      percent: 25,
    });

    const pi = createPi();

    const result = await runSelector(
      ctx,
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(ctx.compact).toHaveBeenCalled();
    expect(pi.setModel).toHaveBeenCalledWith(mockModels.m1);
  });

  it("compacts before switching model when compactOnSwitch is enabled", async () => {
    const config = { ...baseConfig, compactOnSwitch: true };
    vi.mocked(configMod.loadConfig).mockResolvedValue(config);

    const ctx = createContext();
    ctx.model = { provider: "p2", id: "m2" }; // Currently on m2
    const pi = createPi();

    const result = await runSelector(
      ctx,
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(mockModels.m1); // Switching to m1
    expect(ctx.compact).toHaveBeenCalled(); // Should compact because model changed and enabled
  });

  it("does not compact when model has not changed even if compactOnSwitch is enabled", async () => {
    const config = { ...baseConfig, compactOnSwitch: true };
    vi.mocked(configMod.loadConfig).mockResolvedValue(config);

    const ctx = createContext();
    ctx.model = { provider: "p1", id: "m1" }; // Currently on m1
    const pi = createPi();

    const result = await runSelector(
      ctx,
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(ctx.compact).not.toHaveBeenCalled(); // No switch, no compaction
  });
});
