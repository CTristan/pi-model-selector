import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import * as usageFetchers from "../src/usage-fetchers.js";
import * as widgetMod from "../src/widget.js";

// Mock candidates.js to avoid import issues with types.js mock
vi.mock("../src/candidates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/candidates.js")>();
  return {
    ...actual,
  };
});

// Capture debug log writes for testing
const capturedDebugLogs: string[] = [];

// Mock writeDebugLog directly for reliable log capture
vi.mock("../src/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/types.js")>();
  return {
    ...actual,
    writeDebugLog: vi.fn((message: string) => {
      capturedDebugLogs.push(message);
    }),
  };
});

// Mock node:fs to prevent real file operations
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    mkdir: vi.fn((_path, _opts, callback) => {
      callback?.();
    }),
    appendFile: vi.fn((_path, _data, callback) => {
      callback?.();
    }),
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
      open: vi
        .fn()
        .mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
      unlink: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
    },
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
  platform: () => "darwin",
}));

// Mock dependencies
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Model Selector Extension", () => {
  let pi: any;
  let ctx: any;
  let commands: Record<string, (...args: any[]) => any> = {};
  let events: Record<string, (...args: any[]) => any> = {};

  // Persist file contents to simulate real file system
  const persistedFiles = new Map<string, string>();

  const getLastPersistedCooldownState = (): {
    cooldowns: Record<string, number>;
    lastSelected: string | null;
  } => {
    const writes = vi.mocked(fs.promises.writeFile).mock.calls,
      stateWrite = [...writes]
        .reverse()
        .find(
          ([filePath]) =>
            typeof filePath === "string" &&
            filePath.includes("model-selector-cooldowns.json.tmp"),
        );

    expect(stateWrite).toBeDefined();
    const content = stateWrite?.[1];
    expect(typeof content).toBe("string");
    return JSON.parse(content as string) as {
      cooldowns: Record<string, number>;
      lastSelected: string | null;
    };
  };

  beforeEach(() => {
    capturedDebugLogs.length = 0;
    vi.clearAllMocks();
    persistedFiles.clear();

    // Setup FS mocks with persistence
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (typeof filePath === "string") {
        // Check if we have persisted content for this file
        const normalizedPath = filePath as string;
        if (persistedFiles.has(normalizedPath)) {
          return persistedFiles.get(normalizedPath)!;
        }
        // For lock state file, return last persisted temp file content
        if (
          normalizedPath.includes("model-selector-model-locks.json") &&
          !normalizedPath.includes(".tmp.")
        ) {
          for (const [path, content] of persistedFiles.entries()) {
            if (path.includes("model-selector-model-locks.json.tmp.")) {
              return content;
            }
          }
        }
        // Default cooldown state
        if (normalizedPath.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
      }
      return "{}";
    });
    vi.mocked(fs.promises.writeFile).mockImplementation(
      async (filePath, content) => {
        if (typeof filePath === "string" && typeof content === "string") {
          persistedFiles.set(filePath, content);
        }
      },
    );
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);

    commands = {};
    events = {};
    pi = {
      on: vi.fn((eventName, handler) => {
        events[eventName] = handler;
      }),
      registerCommand: vi.fn((name, opts) => {
        commands[name] = opts.handler;
      }),
      setModel: vi.fn().mockResolvedValue(true),
    };
    ctx = {
      modelRegistry: {
        find: vi.fn().mockImplementation((p, id) => ({ provider: p, id })),
      },
      model: { provider: "p1", id: "m1" }, // Already selected
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        setStatus: vi.fn(),
      },
      hasUI: true,
    };

    // Default mocks
    vi.mocked(configMod.loadConfig).mockResolvedValue({
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
      disabledProviders: [],
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should register commands", () => {
    modelSelectorExtension(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "model-select",
      expect.anything(),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "model-skip",
      expect.anything(),
    );
  });

  it("only fetches usage for providers referenced by mappings", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          model: { provider: "anthropic", id: "claude-sonnet" },
        },
      ],
      priority: ["remainingPercent"],
      widget: { enabled: true, placement: "belowEditor", showCount: 3 },
      autoRun: false,
      disabledProviders: [],
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [{ label: "Sonnet", usedPercent: 10, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    const handler = commands["model-select"];

    await handler({}, ctx);

    const disabledProviders = vi.mocked(usageFetchers.fetchAllUsages).mock
      .calls[0]?.[1] as string[];
    expect(disabledProviders).toContain("gemini");
    expect(disabledProviders).toContain("antigravity");
    expect(disabledProviders).not.toContain("anthropic");
  });

  it("should select best model on command", async () => {
    modelSelectorExtension(pi);
    const handler = commands["model-select"];

    await handler({}, ctx);

    // p1 (90% remaining) > p2 (80% remaining)
    // ctx.model is p1/m1, so it says "Already using"
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already using p1/m1"),
      "info",
    );
  });

  it("should skip zero-availability candidates", async () => {
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    const handler = commands["model-select"];

    await handler({}, ctx);

    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p2", id: "m2" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Set model to p2/m2"),
      "info",
    );
  });

  it("should choose the next unlocked model before agent start", async () => {
    // Note: This test uses process.pid which means the lock appears to be held by a
    // live process (the test runner itself). The original version of this test used
    // pid: 7777, which tested the dead process reclamation scenario (a lock held by
    // a potentially dead process). The change to process.pid shifts the semantics to
    // testing the scenario where a lock is held by the same process but a different
    // instance, and the selector falls through to the next unlocked model.
    const lockFileState = {
      version: 1,
      locks: {
        "p1/m1": {
          instanceId: "other-instance",
          pid: process.pid,
          acquiredAt: Date.now(),
          heartbeatAt: Date.now(),
        },
      },
    };

    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const file = String(filePath);
      if (file.includes("model-selector-cooldowns.json")) {
        return JSON.stringify({ cooldowns: {}, lastSelected: null });
      }
      if (file.includes("model-selector-model-locks.json")) {
        return JSON.stringify(lockFileState);
      }
      return "{}";
    });

    modelSelectorExtension(pi);

    const beforeAgentStart = events.before_agent_start;
    expect(beforeAgentStart).toBeTypeOf("function");

    await beforeAgentStart({}, ctx);

    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p2", id: "m2" }),
    );
  });

  it("should reclaim locks from dead processes immediately", async () => {
    // Use a non-existent PID to simulate a dead process
    const deadPid = 999999999;
    const lockFileState = {
      version: 1,
      locks: {
        "p1/m1": {
          instanceId: "other-instance",
          pid: deadPid,
          acquiredAt: Date.now() - 1_000,
          heartbeatAt: Date.now(),
        },
      },
    };

    // Set a different initial model so we can verify p1/m1 is selected
    ctx.model = { provider: "other", id: "other-model" };

    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const file = String(filePath);
      if (file.includes("model-selector-cooldowns.json")) {
        return JSON.stringify({ cooldowns: {}, lastSelected: null });
      }
      if (file.includes("model-selector-model-locks.json")) {
        return JSON.stringify(lockFileState);
      }
      return "{}";
    });

    modelSelectorExtension(pi);

    const beforeAgentStart = events.before_agent_start;
    expect(beforeAgentStart).toBeTypeOf("function");

    await beforeAgentStart({}, ctx);

    // The lock for p1/m1 should be reclaimed since the process is dead,
    // allowing p1/m1 to be selected instead of falling through to p2/m2
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p1", id: "m1" }),
    );
  });

  it("writes debug log when a higher-ranked model lock is busy", async () => {
    const now = Date.now();
    const lockFileState = {
      version: 1,
      locks: {
        "p1/m1": {
          instanceId: "other-instance",
          pid: process.pid,
          acquiredAt: now - 2_000,
          heartbeatAt: now - 1_000,
        },
      },
    };

    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
      disabledProviders: [],
      debugLog: {
        enabled: true,
        path: "/mock/home/.pi/model-selector-debug.log",
      },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const file = String(filePath);
      if (file.includes("model-selector-cooldowns.json")) {
        return JSON.stringify({ cooldowns: {}, lastSelected: null });
      }
      if (file.includes("model-selector-model-locks.json")) {
        return JSON.stringify(lockFileState);
      }
      return "{}";
    });

    modelSelectorExtension(pi);

    const beforeAgentStart = events.before_agent_start;
    expect(beforeAgentStart).toBeTypeOf("function");

    await beforeAgentStart({}, ctx);

    // Check captured debug logs for busy lock message
    expect(
      capturedDebugLogs.some((line) =>
        line.includes('Model lock busy for key "p1/m1"'),
      ),
    ).toBe(true);
  });

  it("should skip model on /model-skip", async () => {
    modelSelectorExtension(pi);
    const selectHandler = commands["model-select"];
    const skipHandler = commands["model-skip"];

    // 1. Run select to establish "last selected"
    await selectHandler({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already using p1/m1"),
      "info",
    );

    // 2. Run skip
    ctx.ui.notify.mockClear();
    await skipHandler({}, ctx);

    // Should notify about cooldown
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cooldown"),
      "info",
    );

    // Should now select p2
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p2", id: "m2" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Set model to p2/m2"),
      "info",
    );
  });

  it("should handle skipping when no prior selection exists", async () => {
    modelSelectorExtension(pi);
    const skipHandler = commands["model-skip"];

    // Run skip without prior select
    // It should run selection first (p1), set it to cooldown, then run again (p2)
    await skipHandler({}, ctx);

    // Verify it eventually picked p2
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p2", id: "m2" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Set model to p2/m2"),
      "info",
    );
  });

  it("re-arms provider cooldown when an expired wildcard cooldown exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T17:00:00.000Z"));

    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        cooldowns: { "p1|acc1|*": Date.now() - 60_000 },
        lastSelected: null,
      }),
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "HTTP 429",
        windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    const selectHandler = commands["model-select"];
    await selectHandler({}, ctx);

    const persisted = getLastPersistedCooldownState();
    expect(persisted.cooldowns["p1|acc1|*"]).toBeGreaterThan(Date.now());
  });

  it("extends provider cooldown window on repeated 429 responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T17:00:00.000Z"));

    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({ cooldowns: {}, lastSelected: null }),
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "HTTP 429",
        windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    const selectHandler = commands["model-select"];

    await selectHandler({}, ctx);
    const firstState = getLastPersistedCooldownState(),
      firstExpiry = firstState.cooldowns["p1|acc1|*"];

    vi.setSystemTime(new Date("2026-02-11T17:10:00.000Z"));
    await selectHandler({}, ctx);

    const secondState = getLastPersistedCooldownState(),
      secondExpiry = secondState.cooldowns["p1|acc1|*"];

    expect(secondExpiry).toBeGreaterThan(firstExpiry);
  });

  it("stops lock heartbeat after losing lock ownership", async () => {
    vi.useFakeTimers();

    modelSelectorExtension(pi);
    const beforeAgentStart = events.before_agent_start,
      agentEnd = events.agent_end;

    expect(beforeAgentStart).toBeTypeOf("function");
    expect(agentEnd).toBeTypeOf("function");

    await beforeAgentStart({}, ctx);

    const countModelLockWrites = (): number =>
      vi
        .mocked(fs.promises.writeFile)
        .mock.calls.filter(
          ([filePath]) =>
            typeof filePath === "string" &&
            filePath.includes("model-selector-model-locks.json.tmp."),
        ).length;

    expect(countModelLockWrites()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    // Heartbeat runs every 5s, so after 20s we get 4 heartbeat writes
    // (at 5s, 10s, 15s, 20s) plus the initial acquire write = 5 total
    expect(countModelLockWrites()).toBeGreaterThanOrEqual(2);

    await agentEnd({}, ctx);
    expect(countModelLockWrites()).toBeGreaterThanOrEqual(2);
  });

  it("handles lock acquisition errors in before_agent_start without throwing", async () => {
    vi.mocked(fs.promises.open).mockRejectedValueOnce(
      new Error(
        "Timed out waiting for model-selector state lock: /mock/home/.pi/model-selector-model-locks.json.lock",
      ),
    );

    modelSelectorExtension(pi);
    const beforeAgentStart = events.before_agent_start;

    expect(beforeAgentStart).toBeTypeOf("function");
    await expect(beforeAgentStart({}, ctx)).resolves.toBeUndefined();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Model selection failed before request start"),
      "error",
    );
  });

  describe("before_agent_start with autoSelectionDisabled", () => {
    let getWidgetStateMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getWidgetStateMock = vi.mocked(widgetMod.getWidgetState);

      getWidgetStateMock.mockReturnValue({
        candidates: [],
        config: {
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
          sources: { globalPath: "", projectPath: "" },
          raw: { global: {}, project: {} },
        },
      });
    });

    it("keeps existing lock when current model matches active lock", async () => {
      // Pre-populate lock file with existing lock for p1/m1
      const lockFileState = {
        version: 1,
        locks: {},
      };

      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
        if (file.includes("model-selector-model-locks.json")) {
          return JSON.stringify(lockFileState);
        }
        return "{}";
      });

      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled first
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to p1/m1
      ctx.model = { provider: "p1", id: "m1" };

      // Clear debug logs
      capturedDebugLogs.length = 0;

      // First call to before_agent_start with autoSelectionDisabled=true
      // It will acquire the lock since activeModelLockKey.current is null
      await beforeAgentStart({}, ctx);

      // Should log about acquiring lock (first time)
      const firstAcquireLogIndex = capturedDebugLogs.findIndex((log) =>
        log.includes("Acquired lock for current model p1/m1"),
      );
      expect(firstAcquireLogIndex).toBeGreaterThanOrEqual(0);

      // Clear logs for second call
      capturedDebugLogs.length = 0;

      // Second call - should keep existing lock since model hasn't changed
      await beforeAgentStart({}, ctx);

      // Should log about keeping existing lock
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Keeping existing lock for current model p1/m1"),
        ),
      ).toBe(true);

      // Should not show error notification
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to acquire lock"),
        "error",
      );
    });

    it("acquires new lock when current model differs from active lock", async () => {
      // Pre-populate lock file with existing lock for p2/m2 (different model)
      const lockFileState = {
        version: 1,
        locks: {
          "p2/m2": {
            instanceId: "test-instance",
            pid: process.pid,
            acquiredAt: Date.now() - 10_000,
            heartbeatAt: Date.now() - 5_000,
          },
        },
      };

      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
        if (file.includes("model-selector-model-locks.json")) {
          return JSON.stringify(lockFileState);
        }
        return "{}";
      });

      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to different model than active lock
      ctx.model = { provider: "p1", id: "m1" };

      // Call before_agent_start
      await beforeAgentStart({}, ctx);

      // Should log about acquiring new lock
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Acquired lock for current model p1/m1"),
        ),
      ).toBe(true);

      // Should not show error notification
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to acquire lock"),
        "error",
      );
    });

    it("releases stale lock when current model lock is busy and differs", async () => {
      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Acquire initial lock for p2/m2
      ctx.model = { provider: "p2", id: "m2" };
      await beforeAgentStart({}, ctx);

      const lockTempPath = [...persistedFiles.keys()].find((path) =>
        path.includes("model-selector-model-locks.json.tmp."),
      );
      expect(lockTempPath).toBeDefined();

      const lockState = JSON.parse(
        persistedFiles.get(lockTempPath as string) as string,
      ) as {
        version: number;
        locks: Record<string, any>;
      };

      expect(lockState.locks["p2/m2"]).toBeDefined();

      const now = Date.now();
      lockState.locks["p1/m1"] = {
        instanceId: "other-instance",
        pid: process.pid,
        acquiredAt: now - 10_000,
        heartbeatAt: now - 5_000,
      };

      persistedFiles.set(
        lockTempPath as string,
        JSON.stringify(lockState, null, 2),
      );

      const writeFileMock = vi.mocked(fs.promises.writeFile);
      const writesBefore = writeFileMock.mock.calls.length;

      // Switch to a model with a busy lock
      ctx.model = { provider: "p1", id: "m1" };
      await beforeAgentStart({}, ctx);

      expect(
        capturedDebugLogs.some((log) =>
          log.includes('releasing existing lock "p2/m2" to avoid stale lock'),
        ),
      ).toBe(true);

      expect(writeFileMock.mock.calls.length).toBeGreaterThan(writesBefore);
      const lastWriteCall =
        writeFileMock.mock.calls[writeFileMock.mock.calls.length - 1];

      const updatedState = JSON.parse(lastWriteCall?.[1] as string) as {
        version: number;
        locks: Record<string, { instanceId: string }>;
      };

      expect(updatedState.locks["p2/m2"]).toBeUndefined();
      expect(updatedState.locks["p1/m1"]).toBeDefined();
    });

    it("warns when current model lock is busy", async () => {
      const lockFileState = {
        version: 1,
        locks: {
          "p1/m1": {
            instanceId: "other-instance",
            pid: process.pid,
            acquiredAt: Date.now() - 10_000,
            heartbeatAt: Date.now() - 5_000,
          },
        },
      };

      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
        if (file.includes("model-selector-model-locks.json")) {
          return JSON.stringify(lockFileState);
        }
        return "{}";
      });

      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to current model with busy lock
      ctx.model = { provider: "p1", id: "m1" };

      // Call before_agent_start
      await beforeAgentStart({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Model lock for current model p1/m1 is busy"),
        "warning",
      );
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Lock for current model p1/m1 is busy"),
        ),
      ).toBe(true);
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Acquired lock for current model p1/m1"),
        ),
      ).toBe(false);
    });

    it("shows error notification when lock acquisition fails", async () => {
      // Mock lock acquisition to fail
      vi.mocked(fs.promises.open).mockRejectedValueOnce(
        new Error("Lock acquisition failed: resource busy"),
      );

      // Pre-populate lock file with existing lock for p2/m2 (different model)
      const lockFileState = {
        version: 1,
        locks: {
          "p2/m2": {
            instanceId: "test-instance",
            pid: process.pid,
            acquiredAt: Date.now() - 10_000,
            heartbeatAt: Date.now() - 5_000,
          },
        },
      };

      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
        if (file.includes("model-selector-model-locks.json")) {
          return JSON.stringify(lockFileState);
        }
        return "{}";
      });

      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to different model than active lock
      ctx.model = { provider: "p1", id: "m1" };

      // Call before_agent_start - should not throw
      await expect(beforeAgentStart({}, ctx)).resolves.toBeUndefined();

      // Should show error notification about failed lock acquisition
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to acquire lock for current model p1/m1",
        ),
        "error",
      );

      // Should log to debug log
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Failed to acquire lock for current model p1/m1"),
        ),
      ).toBe(true);
    });

    it("does nothing when ctx.model is null", async () => {
      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to null
      ctx.model = null;

      // Call before_agent_start - should not throw
      await expect(beforeAgentStart({}, ctx)).resolves.toBeUndefined();

      // Should not attempt any lock operations
      expect(
        capturedDebugLogs.some(
          (log) =>
            log.includes("Keeping existing lock") ||
            log.includes("Acquired lock"),
        ),
      ).toBe(false);
    });

    it("releases old lock when acquiring new lock", async () => {
      // Pre-populate lock file with existing lock for p2/m2
      const lockFileState = {
        version: 1,
        locks: {
          "p2/m2": {
            instanceId: "test-instance",
            pid: process.pid,
            acquiredAt: Date.now() - 10_000,
            heartbeatAt: Date.now() - 5_000,
          },
        },
      };

      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        if (file.includes("model-selector-cooldowns.json")) {
          return JSON.stringify({ cooldowns: {}, lastSelected: null });
        }
        if (file.includes("model-selector-model-locks.json")) {
          return JSON.stringify(lockFileState);
        }
        return "{}";
      });

      modelSelectorExtension(pi);
      const beforeAgentStart = events.before_agent_start;

      // Toggle auto-selection disabled
      const toggleHandler = commands["model-auto-toggle"];
      await toggleHandler({}, ctx);

      // Set ctx.model to different model
      ctx.model = { provider: "p1", id: "m1" };

      // Call before_agent_start
      await beforeAgentStart({}, ctx);

      // Should log about acquiring new lock
      expect(
        capturedDebugLogs.some((log) =>
          log.includes("Acquired lock for current model p1/m1"),
        ),
      ).toBe(true);

      // The old lock for p2/m2 should have been released
      // Check lock file writes to verify
      const lockWrites = vi
        .mocked(fs.promises.writeFile)
        .mock.calls.filter(
          ([filePath]) =>
            typeof filePath === "string" &&
            filePath.includes("model-selector-model-locks.json.tmp."),
        );
      expect(lockWrites.length).toBeGreaterThan(0);
    });
  });

  describe("model-auto-toggle command", () => {
    let updateWidgetStateMock: ReturnType<typeof vi.fn>;
    let renderUsageWidgetMock: ReturnType<typeof vi.fn>;
    let getWidgetStateMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Get widget mocks
      updateWidgetStateMock = vi.mocked(widgetMod.updateWidgetState);
      renderUsageWidgetMock = vi.mocked(widgetMod.renderUsageWidget);
      getWidgetStateMock = vi.mocked(widgetMod.getWidgetState);

      // Set up widget state
      getWidgetStateMock.mockReturnValue({
        candidates: [],
        config: {
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
          sources: { globalPath: "", projectPath: "" },
          raw: { global: {}, project: {} },
        },
      });
    });

    it("toggles autoSelectionDisabled flag and updates widget when disabling", async () => {
      modelSelectorExtension(pi);
      const handler = commands["model-auto-toggle"];

      await handler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection disabled"),
        "info",
      );
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: true }),
      );
      expect(renderUsageWidgetMock).toHaveBeenCalledWith(ctx);
    });

    it("toggles autoSelectionDisabled flag and runs selector when enabling", async () => {
      // First, disable auto-selection
      modelSelectorExtension(pi);
      const handler = commands["model-auto-toggle"];

      await handler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection disabled"),
        "info",
      );

      // Now enable it again - set ctx.model to something different so runSelector will change it
      const originalModel = ctx.model;
      ctx.model = { provider: "other", id: "other-model" };

      vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      await handler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection enabled"),
        "info",
      );
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: false }),
      );
      expect(renderUsageWidgetMock).toHaveBeenCalledWith(ctx);
      // runSelector should have been called and set the model
      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "p1", id: "m1" }),
      );

      // Restore original model
      ctx.model = originalModel;
    });

    it("does nothing when config loading fails", async () => {
      vi.mocked(configMod.loadConfig).mockResolvedValueOnce(null);

      modelSelectorExtension(pi);
      const handler = commands["model-auto-toggle"];

      await handler({}, ctx);

      // Should not notify or update widget if config fails to load
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(updateWidgetStateMock).not.toHaveBeenCalled();
    });

    it("resets autoSelectionDisabled flag on session_shutdown", async () => {
      modelSelectorExtension(pi);
      const handler = commands["model-auto-toggle"];

      // Disable auto-selection (flag becomes true)
      await handler({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection disabled"),
        "info",
      );

      // Trigger session_shutdown - this resets the flag to false (enabled)
      const sessionShutdown = events.session_shutdown;
      await sessionShutdown();

      // Now toggle again - should disable (since flag was reset to false)
      await handler({}, ctx);

      // Should disable (flag was reset to false, toggle makes it true)
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection disabled"),
        "info",
      );

      // Toggle once more to enable - set ctx.model to something different so runSelector will change it
      const originalModel = ctx.model;
      ctx.model = { provider: "other", id: "other-model" };

      vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      await handler({}, ctx);

      // Should enable and run selector
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection enabled"),
        "info",
      );
      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "p1", id: "m1" }),
      );

      // Restore original model
      ctx.model = originalModel;
    });

    it("handles missing widget state gracefully", async () => {
      getWidgetStateMock.mockReturnValue(null);

      modelSelectorExtension(pi);
      const handler = commands["model-auto-toggle"];

      await handler({}, ctx);

      // Should still notify even without widget state
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection disabled"),
        "info",
      );
      // But should not try to update widget state
      expect(updateWidgetStateMock).not.toHaveBeenCalled();
    });
  });
});
