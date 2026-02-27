import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import * as usageFetchers from "../src/usage-fetchers.js";
import { resetGlobalState } from "../src/types.js";

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

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Last-Resort Model", () => {
  let pi: any;
  let ctx: any;
  let commands: Record<string, (...args: any[]) => any> = {};
  let events: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (
        typeof filePath === "string" &&
        filePath.includes("model-selector-cooldowns.json")
      ) {
        return JSON.stringify({ cooldowns: {}, lastSelected: null });
      }
      return "{}";
    });
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
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
      model: { provider: "p1", id: "m1" },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        setStatus: vi.fn(),
      },
      hasUI: true,
      cwd: "/mock/project",
    };
  });

  afterEach(() => {
    resetGlobalState();
  });

  it("uses last-resort model when all buckets are exhausted", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
      lastResort: { provider: "fallback", id: "fallback-model" },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    // All buckets are 100% used (0% remaining)
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    await events["session_start"]?.({}, ctx);

    expect(pi.setModel).toHaveBeenCalledWith({ provider: "fallback", id: "fallback-model" });

    const notifyCall = ctx.ui.notify.mock.calls.find((call: any[]) =>
      call[0].includes("last-resort"),
    );
    expect(notifyCall).toBeDefined();
    expect(notifyCall[0]).toContain("fallback/fallback-model");
  });

  it("shows error when all buckets exhausted and no last-resort configured", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
    ]);

    modelSelectorExtension(pi);
    await events["session_start"]?.({}, ctx);

    expect(pi.setModel).not.toHaveBeenCalled();
    const notifyCall = ctx.ui.notify.mock.calls.find((call: any[]) =>
      call[0].includes("exhausted"),
    );
    expect(notifyCall).toBeDefined();
  });

  it("does not switch to last-resort when buckets still have capacity", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
      lastResort: { provider: "fallback", id: "fallback-model" },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 50, resetsAt: new Date() }],
      },
    ]);

    // Start with a different model so setModel gets called on switch
    ctx.model = { provider: "other", id: "other-model" };

    modelSelectorExtension(pi);
    await events["session_start"]?.({}, ctx);

    // Should select p1/m1, not fallback
    expect(pi.setModel).toHaveBeenCalledWith({ provider: "p1", id: "m1" });
    const notifyCall = ctx.ui.notify.mock.calls.find((call: any[]) =>
      call[0].includes("last-resort"),
    );
    expect(notifyCall).toBeUndefined();
  });

  it("shows error when last-resort model is not found in registry", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
      lastResort: { provider: "unknown-provider", id: "unknown-model" },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
    ]);

    // Registry returns null for the unknown model
    ctx.modelRegistry.find.mockImplementation((p: string, id: string) => {
      if (p === "unknown-provider" && id === "unknown-model") return null;
      return { provider: p, id };
    });

    modelSelectorExtension(pi);
    await events["session_start"]?.({}, ctx);

    expect(pi.setModel).not.toHaveBeenCalled();
    const notifyCall = ctx.ui.notify.mock.calls.find((call: any[]) =>
      call[0].includes("Last-resort model not found"),
    );
    expect(notifyCall).toBeDefined();
  });

  it("reports already using last-resort when it is the current model", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
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
      lastResort: { provider: "fallback", id: "fallback-model" },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    });

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValueOnce([
      {
        provider: "p1",
        displayName: "Provider 1",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
    ]);

    // Simulate last-resort already selected
    ctx.model = { provider: "fallback", id: "fallback-model" };

    modelSelectorExtension(pi);
    await events["session_start"]?.({}, ctx);

    expect(pi.setModel).not.toHaveBeenCalled();
    const notifyCall = ctx.ui.notify.mock.calls.find((call: any[]) =>
      call[0].includes("Already using"),
    );
    expect(notifyCall).toBeDefined();
    expect(notifyCall[0]).toContain("last-resort");
  });
});

