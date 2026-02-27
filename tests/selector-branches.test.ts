import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as configMod from "../src/config.js";
import type { CooldownManager } from "../src/cooldown.js";
import { runSelector } from "../src/selector.js";
import type { LoadedConfig, UsageSnapshot } from "../src/types.js";
import * as usageFetchers from "../src/usage-fetchers.js";
import * as widgetMod from "../src/widget.js";

vi.mock("../src/config.js");
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Selector Branch Coverage", () => {
  const baseConfig: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
      },
    ],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  const baseUsages: UsageSnapshot[] = [
    {
      provider: "p1",
      displayName: "Provider 1",
      windows: [
        {
          label: "w1",
          usedPercent: 50,
          resetsAt: new Date(Date.now() + 3600000),
        },
      ],
    },
  ];

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
      cwd: "/mock",
      sessionManager: {} as ExtensionContext["sessionManager"],
      isIdle: vi.fn().mockReturnValue(true),
      abort: vi.fn(),
      hasPendingMessages: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
      getContextUsage: vi.fn().mockReturnValue(undefined),
      compact: vi.fn(),
      getSystemPrompt: vi.fn().mockReturnValue(""),
    }) as MockExtensionContext;

  const createModelLockCoordinator = () => ({
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    releaseAll: vi.fn().mockResolvedValue(0),
  });

  const createPi = (): MockExtensionAPI =>
    ({
      setModel: vi.fn().mockResolvedValue(true),
    }) as MockExtensionAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configMod.loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(baseUsages);
  });

  it("resets cooldowns when all candidates are on cooldown", async () => {
    const cooldownManager = createCooldownManager({
      isOnCooldown: vi.fn().mockReturnValue(true),
    });
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(cooldownManager.clear).toHaveBeenCalled();
    expect(cooldownManager.persistCooldowns).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cooldown"),
      "warning",
    );
  });

  it("returns error when no usage windows are available", async () => {
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([]);
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(widgetMod.clearWidget).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No usage windows found"),
      "error",
    );
  });

  it("returns error when all buckets are ignored", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          ignore: true,
        },
      ],
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(widgetMod.clearWidget).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("All usage buckets are ignored"),
      "error",
    );
  });

  it("returns error when fallback model is missing", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: { provider: "p1", id: "missing", lock: true },
    });
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100 }],
      },
    ]);
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    ctx.modelRegistry.find = vi.fn((provider: string, id: string) =>
      provider === "p1" && id === "m1"
        ? ({ provider, id } as ExtensionContext["model"])
        : undefined,
    );
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Fallback model not found"),
      "error",
    );
  });

  it("returns error when fallback lock is busy", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: { provider: "p1", id: "fallback", lock: true },
    });
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100 }],
      },
    ]);
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    ctx.modelRegistry.find = vi.fn(
      (provider: string, id: string) =>
        ({
          provider,
          id,
        }) as ExtensionContext["model"],
    );
    const modelLockCoordinator = createModelLockCoordinator();
    modelLockCoordinator.acquire = vi
      .fn()
      .mockResolvedValue({ acquired: false });
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Fallback model lock is busy"),
      "error",
    );
  });

  it("uses fallback without acquiring a lock when lock is disabled", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: { provider: "p1", id: "fallback", lock: false },
    });
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100 }],
      },
    ]);
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    ctx.modelRegistry.find = vi.fn(
      (provider: string, id: string) =>
        ({
          provider,
          id,
        }) as ExtensionContext["model"],
    );
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: "p1/old" };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(modelLockCoordinator.acquire).not.toHaveBeenCalled();
    expect(modelLockCoordinator.release).toHaveBeenCalledWith("p1/old");
    expect(activeModelLockKey.current).toBeNull();
    expect(cooldownManager.setLastSelectedKey).toHaveBeenCalledWith(
      "fallback:p1/fallback",
    );
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p1", id: "fallback" }),
    );
  });

  it("returns false when no lockable candidates are available", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      mappings: [],
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      pi,
    );

    expect(result).toBe(false);
    expect(modelLockCoordinator.acquire).not.toHaveBeenCalled();
  });

  it("handles usage errors and rate-limit cooldowns", async () => {
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 20,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [],
        error: "429 Too Many Requests",
      },
      {
        provider: "p3",
        displayName: "Provider 3",
        windows: [],
        error: "500",
      },
    ]);

    const cooldownManager = createCooldownManager({
      setOrExtendProviderCooldown: vi.fn().mockReturnValue(true),
    });
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(cooldownManager.persistCooldowns).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Rate limit (429) detected"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage check failed"),
      "warning",
    );
  });

  it("skips usage error warnings when usages are preloaded", async () => {
    const preloadedUsages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [
          {
            label: "w1",
            usedPercent: 10,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [],
        error: "500",
      },
    ];

    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { preloadedUsages },
      pi,
    );

    expect(result).toBe(true);
    const warned = ctx.ui.notify.mock.calls.some((call) => {
      const [message, level] = call as [string, string];
      return (
        String(message).includes("Usage check failed") && level === "warning"
      );
    });
    expect(warned).toBe(false);
  });

  it("returns error when best candidate has no mapping", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      mappings: [],
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No model mapping"),
      "error",
    );
  });

  it("returns error when mapped model is missing", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "missing" },
        },
      ],
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    ctx.modelRegistry.find = vi.fn((provider: string, id: string) =>
      id === "missing"
        ? undefined
        : ({ provider, id } as ExtensionContext["model"]),
    );
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Mapped model not found"),
      "error",
    );
  });

  it("returns error when setting the model fails", async () => {
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();
    pi.setModel.mockResolvedValue(false);

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to set model"),
      "error",
    );
  });

  it("returns error when exhausted and no fallback is configured", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: undefined,
    });
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100 }],
      },
    ]);

    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("All non-ignored usage buckets are exhausted"),
      "error",
    );
  });

  it("keeps current model when fallback is already selected", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: { provider: "p1", id: "fallback", lock: true },
    });
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100 }],
      },
    ]);

    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    ctx.model = { provider: "p1", id: "fallback" } as ExtensionContext["model"];
    const modelLockCoordinator = createModelLockCoordinator();
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: "p1/old" };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      {},
      pi,
    );

    expect(result).toBe(true);
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(modelLockCoordinator.release).toHaveBeenCalledWith("p1/old");
  });

  it("handles lock release errors without throwing", async () => {
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    modelLockCoordinator.release = vi
      .fn()
      .mockRejectedValue(new Error("release failed"));
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: "p1/old" };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      pi,
    );

    expect(result).toBe(true);
    expect(modelLockCoordinator.release).toHaveBeenCalledWith("p1/old");
  });

  it("uses fallback when all locks are busy and fallback lock is disabled", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: { provider: "p1", id: "fallback", lock: false },
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    modelLockCoordinator.acquire = vi
      .fn()
      .mockResolvedValue({ acquired: false });
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: "p1/old" };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      pi,
    );

    expect(result).toBe(true);
    expect(modelLockCoordinator.release).toHaveBeenCalledWith("p1/old");
    expect(activeModelLockKey.current).toBeNull();
    expect(cooldownManager.setLastSelectedKey).toHaveBeenCalledWith(
      "fallback:p1/fallback",
    );
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p1", id: "fallback" }),
    );
  });

  it("returns error when all locks are busy without fallback", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue({
      ...baseConfig,
      fallback: undefined,
    });
    const cooldownManager = createCooldownManager();
    const ctx = createContext();
    const modelLockCoordinator = createModelLockCoordinator();
    modelLockCoordinator.acquire = vi
      .fn()
      .mockResolvedValue({ acquired: false });
    const lockHeartbeatTimer = { current: null } as {
      current: NodeJS.Timeout | null;
    };
    const activeModelLockKey = { current: null };
    const pi = createPi();

    const result = await runSelector(
      ctx,
      cooldownManager,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      pi,
    );

    expect(result).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("All mapped models are busy"),
      "error",
    );
  });
});
