import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configMod from "../src/config.js";
import type { CooldownManager } from "../src/cooldown.js";
import { type ModelLockCoordinator, runSelector } from "../src/selector.js";
import type { LoadedConfig } from "../src/types.js";
import * as usageFetchers from "../src/usage-fetchers.js";

// Mock dependencies
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Selector Heartbeat and Error Handling", () => {
  let pi: any;
  let ctx: any;
  let mockConfig: LoadedConfig;
  let mockCooldownManager: CooldownManager;
  let mockModelLockCoordinator: ModelLockCoordinator;
  let lockHeartbeatTimer: { current: NodeJS.Timeout | null };
  let activeModelLockKey: { current: string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    pi = {
      setModel: vi.fn().mockResolvedValue(true),
    };

    ctx = {
      modelRegistry: {
        find: vi.fn().mockImplementation((p, id) => ({ provider: p, id })),
      },
      model: { provider: "other", id: "other-model" },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      hasUI: true,
    };

    mockConfig = {
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        },
      ],
      priority: ["remainingPercent"],
      widget: { enabled: true, placement: "belowEditor", showCount: 3 },
      autoRun: false,
      disabledProviders: [],
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    };

    mockCooldownManager = {
      loadPersistedCooldowns: vi.fn().mockResolvedValue(undefined),
      pruneExpiredCooldowns: vi.fn(),
      setOrExtendProviderCooldown: vi.fn(),
      getWildcardExpiry: vi.fn(),
      isOnCooldown: vi.fn().mockReturnValue(false),
      clear: vi.fn(),
      setLastSelectedKey: vi.fn(),
      persistCooldowns: vi.fn().mockResolvedValue(undefined),
    } as unknown as CooldownManager;

    mockModelLockCoordinator = {
      acquire: vi.fn().mockResolvedValue({ acquired: true }),
      refresh: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
      releaseAll: vi.fn().mockResolvedValue(0),
    };

    lockHeartbeatTimer = { current: null };
    activeModelLockKey = { current: null };

    vi.mocked(configMod.loadConfig).mockResolvedValue(mockConfig);
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "anthropic",
        displayName: "Anthropic",
        windows: [
          {
            label: "Sonnet",
            usedPercent: 10,
            resetsAt: new Date(Date.now() + 3600000),
          },
        ],
      },
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (lockHeartbeatTimer.current) {
      clearInterval(lockHeartbeatTimer.current);
    }
    await mockModelLockCoordinator.releaseAll();
  });

  describe("Heartbeat - Lock Lost Scenario", () => {
    it("should stop heartbeat when lock refresh returns false (lock lost)", async () => {
      vi.mocked(mockModelLockCoordinator.acquire).mockResolvedValue({
        acquired: true,
      });
      // Initially refresh succeeds
      vi.mocked(mockModelLockCoordinator.refresh)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        // Third refresh returns false (lock lost)
        .mockResolvedValueOnce(false)
        // Subsequent refreshes shouldn't be called since heartbeat stopped
        .mockResolvedValue(true);

      const result = await runSelector(
        ctx,
        mockCooldownManager,
        mockModelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        pi,
      );

      expect(result).toBe(true);
      expect(activeModelLockKey.current).toBeTruthy();

      // Initial acquire
      expect(mockModelLockCoordinator.acquire).toHaveBeenCalledTimes(1);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(0); // Heartbeat not started yet

      // Advance time to trigger heartbeats
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(1); // First heartbeat at 5s

      // Advance more time to trigger more heartbeats
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(2); // Second heartbeat at 10s

      // Advance more time - this heartbeat should detect lock lost and stop
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(3); // Third heartbeat at 15s (returns false)

      // Advance more time - heartbeat should have stopped
      await vi.advanceTimersByTimeAsync(10000);
      // Should still be 3 because heartbeat stopped after lock was lost
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(3);
      expect(activeModelLockKey.current).toBeNull();
    });

    it("should clear heartbeat timer when lock is lost", async () => {
      vi.mocked(mockModelLockCoordinator.acquire).mockResolvedValue({
        acquired: true,
      });
      vi.mocked(mockModelLockCoordinator.refresh)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await runSelector(
        ctx,
        mockCooldownManager,
        mockModelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        pi,
      );

      expect(lockHeartbeatTimer.current).toBeTruthy();

      // Trigger first heartbeat (success)
      await vi.advanceTimersByTimeAsync(6000);
      expect(lockHeartbeatTimer.current).toBeTruthy();

      // Trigger second heartbeat (lock lost, should clear timer)
      await vi.advanceTimersByTimeAsync(5000);
      expect(lockHeartbeatTimer.current).toBeNull();
    });
  });

  describe("Heartbeat - Error Scenarios", () => {
    it("should stop heartbeat when refresh throws an error", async () => {
      vi.mocked(mockModelLockCoordinator.acquire).mockResolvedValue({
        acquired: true,
      });
      vi.mocked(mockModelLockCoordinator.refresh)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        // Third refresh throws error
        .mockRejectedValueOnce(new Error("Lock file corrupted"));

      const result = await runSelector(
        ctx,
        mockCooldownManager,
        mockModelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        pi,
      );

      expect(result).toBe(true);
      expect(activeModelLockKey.current).toBeTruthy();

      // Trigger heartbeats
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(2);

      // Trigger third heartbeat that should error
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(3);

      // Advance more time - heartbeat should have stopped
      await vi.advanceTimersByTimeAsync(10000);
      // Should still be 3 because heartbeat stopped after error
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(3);
    });

    it("should clear heartbeat timer when refresh throws an error", async () => {
      vi.mocked(mockModelLockCoordinator.acquire).mockResolvedValue({
        acquired: true,
      });
      vi.mocked(mockModelLockCoordinator.refresh)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("Network error"));

      await runSelector(
        ctx,
        mockCooldownManager,
        mockModelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        pi,
      );

      expect(lockHeartbeatTimer.current).toBeTruthy();

      // Trigger first heartbeat (success)
      await vi.advanceTimersByTimeAsync(6000);
      expect(lockHeartbeatTimer.current).toBeTruthy();

      // Trigger second heartbeat (error, should clear timer)
      await vi.advanceTimersByTimeAsync(5000);
      expect(lockHeartbeatTimer.current).toBeNull();
    });
  });

  describe("Heartbeat - In-Flight Flag", () => {
    it("should skip refresh if previous refresh is still in progress", async () => {
      vi.mocked(mockModelLockCoordinator.acquire).mockResolvedValue({
        acquired: true,
      });

      let refreshResolve: ((value: boolean) => void) | null = null;
      vi.mocked(mockModelLockCoordinator.refresh).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            refreshResolve = resolve;
          }),
      );

      await runSelector(
        ctx,
        mockCooldownManager,
        mockModelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        false,
        "command",
        { acquireModelLock: true, waitForModelLock: false },
        pi,
      );

      // Trigger first heartbeat (will hang)
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(1);

      // Advance time again - should skip because in-progress flag is set
      await vi.advanceTimersByTimeAsync(5000);
      // Still only 1 call because the second heartbeat skipped
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(1);

      // Resolve the hanging refresh
      refreshResolve!(true);

      // Wait for next heartbeat
      await vi.advanceTimersByTimeAsync(5000);
      // Now we should have a second call
      expect(mockModelLockCoordinator.refresh).toHaveBeenCalledTimes(2);
    });
  });
});
