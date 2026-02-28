import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CooldownManager } from "../src/cooldown.js";
import { runSelector } from "../src/selector.js";
import type { LoadedConfig, UsageSnapshot } from "../src/types.js";

vi.mock("../src/config.js");
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Selector Reserve Threshold", () => {
  const baseConfig: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
        reserve: 20,
      },
    ],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  type MockExtensionContext = ExtensionContext & {
    ui: ExtensionContext["ui"] & {
      notify: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
    };
    modelRegistry: ExtensionContext["modelRegistry"] & {
      find: ReturnType<typeof vi.fn>;
    };
  };

  type MockExtensionAPI = ExtensionAPI & {
    setModel: ReturnType<typeof vi.fn>;
  };

  const createCooldownManager = (
    overrides: Partial<CooldownManager> = {},
  ): CooldownManager =>
    ({
      loadPersistedCooldowns: vi.fn().mockResolvedValue(undefined),
      pruneExpiredCooldowns: vi.fn(),
      setOrExtendProviderCooldown: vi.fn().mockReturnValue(false),
      getWildcardExpiry: vi.fn().mockReturnValue(undefined),
      isOnCooldown: vi.fn().mockReturnValue(false),
      clear: vi.fn(),
      setLastSelectedKey: vi.fn(),
      persistCooldowns: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as unknown as CooldownManager;

  const createModelLockCoordinator = () => ({
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    releaseAll: vi.fn().mockResolvedValue(0),
  });

  const createContext = (): MockExtensionContext =>
    ({
      modelRegistry: {
        find: vi.fn(
          (provider: string, id: string) =>
            ({
              provider,
              id,
            }) as ExtensionContext["model"],
        ),
      } as unknown as MockExtensionContext["modelRegistry"],
      model: {
        provider: "other",
        id: "other-model",
      } as ExtensionContext["model"],
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      } as unknown as MockExtensionContext["ui"],
      hasUI: true,
      cwd: "/mock/cwd",
    }) as MockExtensionContext;

  const createPi = (): MockExtensionAPI =>
    ({
      setModel: vi.fn().mockResolvedValue(true),
    }) as MockExtensionAPI;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should filter out candidate at 15% with reserve 20%", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 85,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // Candidate at 15% remaining, reserve is 20%, so should be filtered out
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 20,
        },
      ],
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    // Candidate is below reserve, no fallback configured, should fail
    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("at or below their reserve thresholds"),
      "error",
    );
  });

  it("should select candidate at 25% with reserve 20%", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 75,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // Candidate at 25% remaining, reserve is 20%, so should be selected
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 20,
        },
      ],
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Set model to p1/m1"),
      "info",
    );
  });

  it("should filter out candidate at exactly reserve threshold (exclusive)", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 80,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // Candidate at exactly 20% remaining, reserve is 20%, so should be filtered out
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 20,
        },
      ],
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("at or below their reserve thresholds"),
      "error",
    );
  });

  it("should trigger fallback when all candidates below reserve", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 85,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // Candidate at 15% remaining, reserve is 20%, with fallback configured
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 20,
        },
      ],
      fallback: {
        provider: "fallback",
        id: "fallback-model",
        lock: false,
      },
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fallback",
        id: "fallback-model",
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("last-resort fallback"),
      "info",
    );
  });

  it("should select best candidate when some below reserve and some above", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 85,
            resetsAt: new Date(Date.now() + 3600000),
          },
          {
            label: "w2",
            usedPercent: 50,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // w1 at 15% (below reserve 20%), w2 at 50% (above reserve)
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 20,
        },
        {
          usage: { provider: "p1", window: "w2" },
          model: { provider: "p1", id: "m2" },
          reserve: 10,
        },
      ],
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "p1",
        id: "m2", // w2 at 50% should be selected over w1 at 15%
      }),
    );
  });

  it("should treat reserve 0 identically to no reserve (backward compatibility)", async () => {
    const ctx = createContext();
    const pi = createPi();
    const cooldownManager = createCooldownManager();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null };
    const activeModelLockKey = { current: null };

    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 99,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ];

    // Candidate at 1% remaining, reserve is 0%, should be selected (like no reserve)
    const config: LoadedConfig = {
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
          reserve: 0,
        },
      ],
    };

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {
        preloadedConfig: config,
        preloadedUsages: usages,
      },
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalled();
  });
});
