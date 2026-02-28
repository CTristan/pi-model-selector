import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import type {
  LoadedConfig,
  MappingEntry,
  UsageSnapshot,
} from "../src/types.js";
import * as usageFetchers from "../src/usage-fetchers.js";

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
  platform: () => "linux",
}));

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js");

describe("mapping wizard actions", () => {
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  type WizardContext = {
    modelRegistry: {
      getAvailable: () => Promise<Array<{ provider: string; id: string }>>;
    };
    ui: {
      notify: (message: string, level: "info" | "warning" | "error") => void;
      select: (
        message: string,
        options: string[],
      ) => Promise<string | undefined>;
      confirm: (title: string, message: string) => Promise<boolean>;
      input: (prompt: string) => Promise<string | undefined>;
    };
    hasUI: boolean;
  };

  let commands: Record<string, CommandHandler> = {};
  let ctx: WizardContext;

  const usageSnapshots: UsageSnapshot[] = [
    {
      provider: "p1",
      displayName: "P1",
      account: "acc1",
      windows: [{ label: "w1", usedPercent: 5, resetsAt: new Date() }],
    },
  ];

  const baseConfigFor = (projectMapping: MappingEntry): LoadedConfig => ({
    mappings: [projectMapping],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: {
      global: {},
      project: { mappings: [projectMapping] },
    },
  });

  const mockWizardSelectionFlow = (
    action: "Stop ignoring" | "Remove mapping",
  ) => {
    let menuVisits = 0;
    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(menuVisits === 1 ? "Edit mappings" : "Done");
      }
      if (message === "Select a usage bucket to map") {
        expect(options).toHaveLength(1);
        return Promise.resolve(options[0]);
      }
      if (message === "Modify mapping in") {
        return Promise.resolve("Project (project.json)");
      }
      if (message.startsWith("Select action for")) {
        expect(options).toContain(action);
        return Promise.resolve(action);
      }
      return Promise.resolve(undefined);
    });

    ctx.ui.confirm = vi.fn(() => Promise.resolve(false));
    ctx.ui.input = vi.fn(() => Promise.resolve(undefined));
  };

  const mockReserveChangeFlow = (reserveInput: string) => {
    let menuVisits = 0;
    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(menuVisits === 1 ? "Edit mappings" : "Done");
      }
      if (message === "Select a usage bucket to map") {
        expect(options).toHaveLength(1);
        return Promise.resolve(options[0]);
      }
      if (message === "Modify mapping in") {
        return Promise.resolve("Project (project.json)");
      }
      if (message.startsWith("Select action for")) {
        expect(options).toContain("Change reserve");
        return Promise.resolve("Change reserve");
      }
      if (message.startsWith("Set reserve for")) {
        expect(options).toEqual(["No reserve (0)", "Set reserve"]);
        return Promise.resolve("Set reserve");
      }
      return Promise.resolve(undefined);
    });

    ctx.ui.confirm = vi.fn(() => Promise.resolve(false));
    ctx.ui.input = vi.fn(() => Promise.resolve(reserveInput));
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
        getAvailable: () => Promise.resolve([{ provider: "p1", id: "m1" }]),
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
      hasUI: true,
    };

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(usageSnapshots);
    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);
    vi.mocked(configMod.getRawMappings).mockImplementation(
      (raw: Record<string, unknown>): MappingEntry[] => {
        const mappings = raw.mappings;
        return Array.isArray(mappings) ? (mappings as MappingEntry[]) : [];
      },
    );

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it.each([
    {
      name: "generic exact-window ignore",
      mapping: { usage: { provider: "p1", window: "w1" }, ignore: true },
    },
    {
      name: "pattern ignore",
      mapping: {
        usage: { provider: "p1", windowPattern: "^w1$" },
        ignore: true,
      },
    },
    {
      name: "catch-all ignore",
      mapping: { usage: { provider: "p1" }, ignore: true },
    },
  ])("uses the matched $name entry for Stop ignoring", async ({ mapping }) => {
    const initialConfig = baseConfigFor(mapping),
      reloadedConfig: LoadedConfig = {
        ...initialConfig,
        mappings: [],
        raw: { global: {}, project: { mappings: [] } },
      };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(reloadedConfig);
    vi.mocked(configMod.removeMapping).mockReturnValue({ removed: true });

    mockWizardSelectionFlow("Stop ignoring");

    const runWizard = commands["model-select-config"];
    if (!runWizard) throw new Error("Command not found: model-select-config");
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.removeMapping).toHaveBeenCalledTimes(1);
    const [, removedMapping, options] = vi.mocked(configMod.removeMapping).mock
      .calls[0] as [
      Record<string, unknown>,
      MappingEntry,
      { onlyIgnore?: boolean },
    ];

    expect(removedMapping).toEqual(mapping);
    expect(options.onlyIgnore).toBe(true);
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      initialConfig.raw.project,
    );
    expect(configMod.loadConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "generic exact-window model",
      mapping: {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
      },
    },
    {
      name: "pattern model",
      mapping: {
        usage: { provider: "p1", windowPattern: "^w1$" },
        model: { provider: "p1", id: "m1" },
      },
    },
    {
      name: "catch-all model",
      mapping: {
        usage: { provider: "p1" },
        model: { provider: "p1", id: "m1" },
      },
    },
  ])("uses the matched $name entry for Remove mapping", async ({ mapping }) => {
    const initialConfig = baseConfigFor(mapping),
      reloadedConfig: LoadedConfig = {
        ...initialConfig,
        mappings: [],
        raw: { global: {}, project: { mappings: [] } },
      };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(reloadedConfig);
    vi.mocked(configMod.removeMapping).mockReturnValue({ removed: true });

    mockWizardSelectionFlow("Remove mapping");

    const runWizard = commands["model-select-config"];
    if (!runWizard) throw new Error("Command not found: model-select-config");
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.removeMapping).toHaveBeenCalledTimes(1);
    const [, removedMapping, options] = vi.mocked(configMod.removeMapping).mock
      .calls[0] as [
      Record<string, unknown>,
      MappingEntry,
      { onlyIgnore?: boolean },
    ];

    expect(removedMapping).toEqual(mapping);
    expect(options.onlyIgnore).toBe(false);
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      initialConfig.raw.project,
    );
    expect(configMod.loadConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "pattern model",
      mapping: {
        usage: { provider: "p1", windowPattern: "^w1$" },
        model: { provider: "p1", id: "m1" },
      },
    },
    {
      name: "catch-all model",
      mapping: {
        usage: { provider: "p1" },
        model: { provider: "p1", id: "m1" },
      },
    },
  ])("updates reserve for matched $name entry", async ({ mapping }) => {
    const initialConfig = baseConfigFor(mapping),
      updatedMapping: MappingEntry = {
        ...mapping,
        reserve: 25,
      },
      reloadedConfig: LoadedConfig = {
        ...initialConfig,
        mappings: [updatedMapping],
        raw: { global: {}, project: { mappings: [updatedMapping] } },
      };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(reloadedConfig);

    mockReserveChangeFlow("25");

    const runWizard = commands["model-select-config"];
    if (!runWizard) throw new Error("Command not found: model-select-config");
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    const projectMappings = (initialConfig.raw.project.mappings ??
      []) as Array<MappingEntry>;
    expect(projectMappings[0]!.reserve).toBe(25);
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "project.json",
      initialConfig.raw.project,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Reserve updated to 25%"),
      "info",
    );
  });

  it("rejects whitespace-only reserve input", async () => {
    const mapping: MappingEntry = {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
        reserve: 40,
      },
      initialConfig = baseConfigFor(mapping);

    vi.mocked(configMod.loadConfig).mockResolvedValueOnce(initialConfig);
    mockReserveChangeFlow("   ");

    const runWizard = commands["model-select-config"];
    if (!runWizard) throw new Error("Command not found: model-select-config");
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    const projectMappings = (initialConfig.raw.project.mappings ??
      []) as Array<MappingEntry>;
    expect(projectMappings[0]!.reserve).toBe(40);
    expect(configMod.saveConfigFile).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid reserve value"),
      "error",
    );
  });
});
