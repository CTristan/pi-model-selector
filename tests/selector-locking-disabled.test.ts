import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configMod from "../src/config.js";
import type { CooldownManager } from "../src/cooldown.js";
import { createModelLockCoordinator } from "../src/model-locks.js";
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

describe("Selector with enableModelLocking: false", () => {
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
    enableModelLocking: false,
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

  const createContext = (): ExtensionContext =>
    ({
      signal: new AbortController().signal,
      modelRegistry: {
        find: vi.fn(
          (provider: string, id: string) =>
            ({
              provider,
              id,
            }) as ExtensionContext["model"],
        ),
      } as unknown as ExtensionContext["modelRegistry"],
      model: {
        provider: "other",
        id: "other-model",
      } as ExtensionContext["model"],
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      } as unknown as ExtensionContext["ui"],
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
    }) as ExtensionContext;

  const createPi = (): ExtensionAPI =>
    ({
      setModel: vi.fn().mockResolvedValue(true),
    }) as unknown as ExtensionAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configMod.loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(baseUsages);
  });

  it("never calls coordinator.acquire when enableModelLocking is false", async () => {
    const coordinator = {
      acquire: vi.fn().mockResolvedValue({ acquired: true }),
      refresh: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      releaseAll: vi.fn().mockResolvedValue(0),
    };

    const result = await runSelector(
      createContext(),
      createCooldownManager(),
      coordinator,
      { current: null },
      { current: null },
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      createPi(),
    );

    expect(result).toBe(true);
    expect(coordinator.acquire).not.toHaveBeenCalled();
    expect(coordinator.release).not.toHaveBeenCalled();
    expect(coordinator.refresh).not.toHaveBeenCalled();
  });

  it("releases pre-existing active lock and clears heartbeat when enableModelLocking is false", async () => {
    const coordinator = {
      acquire: vi.fn().mockResolvedValue({ acquired: true }),
      refresh: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      releaseAll: vi.fn().mockResolvedValue(0),
    };

    // Simulate a prior run that acquired a lock and started a heartbeat
    // before the user flipped enableModelLocking to false.
    const preexistingTimer = setInterval(() => {}, 1_000_000);
    const lockHeartbeatTimer: { current: NodeJS.Timeout | null } = {
      current: preexistingTimer,
    };
    const activeModelLockKey: { current: string | null } = {
      current: "p1/prior-lock",
    };

    const result = await runSelector(
      createContext(),
      createCooldownManager(),
      coordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      false,
      "command",
      { acquireModelLock: true, waitForModelLock: false },
      createPi(),
    );

    expect(result).toBe(true);
    expect(coordinator.release).toHaveBeenCalledWith("p1/prior-lock");
    expect(activeModelLockKey.current).toBeNull();
    expect(lockHeartbeatTimer.current).toBeNull();
    expect(coordinator.acquire).not.toHaveBeenCalled();
  });

  describe("integration with real coordinator files", () => {
    let tmpDir: string;
    let statePath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "selector-locking-disabled-"),
      );
      statePath = path.join(tmpDir, "model-selector-model-locks.json");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates no lock files when enableModelLocking is false", async () => {
      const coordinator = createModelLockCoordinator({
        statePath,
        instanceId: "test-instance",
        pid: 12345,
        isPidAlive: () => true,
      });

      const result = await runSelector(
        createContext(),
        createCooldownManager(),
        coordinator,
        { current: null },
        { current: null },
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        createPi(),
      );

      expect(result).toBe(true);

      const entries = fs.readdirSync(tmpDir);
      expect(entries).toEqual([]);
    });
  });
});
