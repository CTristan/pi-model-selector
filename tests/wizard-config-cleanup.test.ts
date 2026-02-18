import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import type { LoadedConfig } from "../src/types.js";

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
vi.mock("../src/widget.js");

describe("mapping wizard config cleanup", () => {
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  let commands: Record<string, CommandHandler> = {};
  let ctx: {
    modelRegistry: {
      getAvailable: () => Promise<Array<{ provider: string; id: string }>>;
      find: (
        provider: string,
        id: string,
      ) => { provider: string; id: string } | undefined;
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

  const initialConfig: LoadedConfig = {
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
    raw: {
      global: {
        examples: [{ usage: { provider: "p1", window: "w1" } }],
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
      },
      project: {},
    },
  };

  const reloadedConfig: LoadedConfig = {
    ...initialConfig,
    raw: {
      global: {
        mappings: [
          {
            usage: {
              provider: "p1",
              account: undefined,
              window: "w1",
              windowPattern: undefined,
            },
            model: { provider: "p1", id: "m1" },
            ignore: false,
            combine: undefined,
          },
        ],
      },
      project: {},
    },
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
        find: (provider: string, id: string) =>
          provider === "p1" && id === "m1" ? { provider, id } : undefined,
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
      hasUI: true,
    };

    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(reloadedConfig);
    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);
    vi.mocked(configMod.cleanupConfigRaw).mockImplementation((raw) => {
      delete raw.examples;
      return {
        changed: true,
        summary: ['Removed unused top-level "examples" block.'],
        removedExamples: true,
        fixedDebugLogPath: false,
        removedInvalidMappings: 0,
        removedDuplicateMappings: 0,
        removedUnavailableModelMappings: 0,
      };
    });

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it("applies cleanup to selected config file", async () => {
    let menuVisits = 0;
    ctx.ui.select = vi.fn((message: string, _options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(menuVisits === 1 ? "Clean up config" : "Done");
      }

      if (message === "Select config file to clean") {
        return Promise.resolve("Global (global.json)");
      }

      return Promise.resolve(undefined);
    });

    ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.cleanupConfigRaw).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        scope: "global",
        modelExists: expect.any(Function),
      }),
    );
    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.not.objectContaining({ examples: expect.anything() }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Config cleanup applied to global.json"),
      "info",
    );
  });

  it("disables mapped providers with missing credentials during cleanup", async () => {
    const credentiallessConfig: LoadedConfig = {
      ...initialConfig,
      disabledProviders: [],
      raw: {
        global: {
          mappings: [
            {
              usage: { provider: "gemini", window: "Flash" },
              model: { provider: "google", id: "gemini-1.5-flash" },
            },
          ],
        },
        project: {},
      },
    };

    const reloadedWithDisabled: LoadedConfig = {
      ...credentiallessConfig,
      disabledProviders: ["gemini"],
    };

    vi.mocked(configMod.loadConfig)
      .mockReset()
      .mockResolvedValueOnce(credentiallessConfig)
      .mockResolvedValueOnce(reloadedWithDisabled);

    vi.mocked(configMod.cleanupConfigRaw).mockReset();
    vi.mocked(configMod.cleanupConfigRaw).mockImplementation(() => ({
      changed: false,
      summary: [],
      removedExamples: false,
      fixedDebugLogPath: false,
      removedInvalidMappings: 0,
      removedDuplicateMappings: 0,
      removedUnavailableModelMappings: 0,
    }));

    let menuVisits = 0;
    ctx.ui.select = vi.fn((message: string) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(menuVisits === 1 ? "Clean up config" : "Done");
      }
      if (message === "Select config file to clean") {
        return Promise.resolve("Global (global.json)");
      }
      return Promise.resolve(undefined);
    });
    ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.objectContaining({
        disabledProviders: expect.arrayContaining(["gemini"]),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disabled 1 provider with missing credentials"),
      "info",
    );
  });
});
