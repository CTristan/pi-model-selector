import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import * as usageFetchers from "../src/usage-fetchers.js";

// Mock node:fs to prevent real file operations
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
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
    vi.clearAllMocks();

    // Setup FS mocks
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({ cooldowns: {}, lastSelected: null }),
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
    const lockFileState = {
      version: 1,
      locks: {
        "p1/m1": {
          instanceId: "other-instance",
          pid: 7777,
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
});
