import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import type { LoadedConfig } from "../src/types.js";
import * as widgetMod from "../src/widget.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
  platform: () => "darwin",
}));

vi.mock("../src/config.js");
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Wizard Settings", () => {
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  let commands: Record<string, CommandHandler> = {};
  let ctx: {
    modelRegistry: {
      getAvailable: ReturnType<typeof vi.fn>;
    };
    ui: {
      notify: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      confirm: ReturnType<typeof vi.fn>;
      input: ReturnType<typeof vi.fn>;
    };
    hasUI: boolean;
    cwd: string;
  };

  const baseConfig: LoadedConfig = {
    mappings: [],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
    debugLog: { enabled: false, path: "model-selector.log" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    commands = {};

    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(
        (name: string, options: { handler: CommandHandler }) => {
          commands[name] = options.handler;
        },
      ),
    };

    ctx = {
      modelRegistry: {
        getAvailable: vi.fn().mockResolvedValue([{ provider: "p1", id: "m1" }]),
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
      hasUI: true,
      cwd: "/mock/cwd",
    };

    vi.mocked(configMod.loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);
    vi.mocked(configMod.updateWidgetConfig).mockImplementation(() => {});

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it("notifies when UI is unavailable", async () => {
    ctx.hasUI = false;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.loadConfig).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("requires interactive mode"),
    );

    errorSpy.mockRestore();
  });

  it("updates widget placement and refreshes widget", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure widget")
      .mockResolvedValueOnce("Configure placement")
      .mockResolvedValueOnce("Above editor")
      .mockResolvedValueOnce("Project (project.json)")
      .mockResolvedValueOnce("Done");

    vi.mocked(widgetMod.getWidgetState).mockReturnValue({
      candidates: [],
      config: baseConfig,
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.updateWidgetConfig).toHaveBeenCalledWith(
      baseConfig.raw.project,
      { placement: "aboveEditor" },
    );
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      expect.any(Object),
    );
    expect(widgetMod.updateWidgetState).toHaveBeenCalled();
    expect(widgetMod.renderUsageWidget).toHaveBeenCalledWith(ctx);
  });

  it("updates widget count", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure widget")
      .mockResolvedValueOnce("Configure count")
      .mockResolvedValueOnce("4")
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.updateWidgetConfig).toHaveBeenCalledWith(
      baseConfig.raw.global,
      { showCount: 4 },
    );
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.any(Object),
    );
  });

  it("disables the widget", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure widget")
      .mockResolvedValueOnce("Disable widget")
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.updateWidgetConfig).toHaveBeenCalledWith(
      baseConfig.raw.global,
      { enabled: false },
    );
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.any(Object),
    );
  });

  it("enables the widget", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure widget")
      .mockResolvedValueOnce("Enable widget")
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.updateWidgetConfig).toHaveBeenCalledWith(
      baseConfig.raw.global,
      { enabled: true },
    );
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.any(Object),
    );
  });

  it("updates priority ordering", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure priority")
      .mockResolvedValueOnce(
        "fullAvailability → remainingPercent → earliestReset",
      )
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.objectContaining({
        priority: ["fullAvailability", "remainingPercent", "earliestReset"],
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Priority updated"),
      "info",
    );
  });

  it("toggles auto-run settings", async () => {
    ctx.ui.select
      .mockResolvedValueOnce("Configure auto-run")
      .mockResolvedValueOnce("Enable auto-run")
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.objectContaining({ autoRun: true }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Auto-run enabled"),
      "info",
    );
  });

  it("updates debug log path", async () => {
    const configWithDebug: LoadedConfig = {
      ...baseConfig,
      debugLog: { enabled: true, path: "old.log" },
    };
    const reloadedDebug: LoadedConfig = {
      ...configWithDebug,
      debugLog: { enabled: true, path: "logs/selector.log" },
    };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(configWithDebug)
      .mockResolvedValueOnce(reloadedDebug);

    ctx.ui.select
      .mockResolvedValueOnce("Configure debug log")
      .mockResolvedValueOnce("Change log file path")
      .mockResolvedValueOnce("Project (project.json)")
      .mockResolvedValueOnce("Done");
    ctx.ui.input.mockResolvedValueOnce("logs/selector.log");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      expect.objectContaining({
        debugLog: expect.objectContaining({ path: "logs/selector.log" }),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Debug logging enabled"),
      "info",
    );
  });

  it("disables debug logging", async () => {
    const configWithDebug: LoadedConfig = {
      ...baseConfig,
      debugLog: { enabled: true, path: "active.log" },
    };
    const reloadedDebug: LoadedConfig = {
      ...configWithDebug,
      debugLog: { enabled: false, path: "active.log" },
    };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(configWithDebug)
      .mockResolvedValueOnce(reloadedDebug);

    ctx.ui.select
      .mockResolvedValueOnce("Configure debug log")
      .mockResolvedValueOnce("Disable logging")
      .mockResolvedValueOnce("Global (global.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.objectContaining({
        debugLog: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Debug logging disabled"),
      "info",
    );
  });

  it("clears the fallback model", async () => {
    const configWithFallback: LoadedConfig = {
      ...baseConfig,
      fallback: { provider: "p1", id: "m1", lock: true },
      raw: {
        global: {},
        project: { fallback: { provider: "p1", id: "m1", lock: true } },
      },
    };
    const reloadedConfig: LoadedConfig = {
      ...configWithFallback,
      fallback: undefined,
      raw: { global: {}, project: {} },
    };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(configWithFallback)
      .mockResolvedValueOnce(reloadedConfig);

    ctx.ui.select
      .mockResolvedValueOnce("Configure fallback")
      .mockResolvedValueOnce("Clear fallback model")
      .mockResolvedValueOnce("Project (project.json)")
      .mockResolvedValueOnce("Done");

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      expect.not.objectContaining({ fallback: expect.anything() }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Fallback model cleared"),
      "info",
    );
  });
});
