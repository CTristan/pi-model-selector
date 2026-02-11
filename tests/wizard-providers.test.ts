import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import modelSelectorExtension from "../index.js";
import * as usageFetchers from "../src/usage-fetchers.js";
import * as configMod from "../src/config.js";
import type { LoadedConfig } from "../src/types.js";

vi.mock("node:fs", () => ({
  promises: {
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
  platform: () => "darwin",
}));

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js");

describe("mapping wizard provider configuration", () => {
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

  const initialConfig: LoadedConfig = {
    mappings: [],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: ["zai"],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: {
      global: { disabledProviders: ["zai"] },
      project: {},
    },
  };

  const enabledConfig: LoadedConfig = {
    ...initialConfig,
    disabledProviders: [],
    raw: {
      global: { disabledProviders: [] },
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
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
      hasUI: true,
    };

    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);
    vi.mocked(configMod.loadConfig)
      .mockResolvedValueOnce(initialConfig)
      .mockResolvedValueOnce(enabledConfig);
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
      zai: { key: "secret" },
    });

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it("enables z.ai and shows detected credentials", async () => {
    let menuVisits = 0;

    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(
          menuVisits === 1 ? "Configure providers" : "Done",
        );
      }

      if (message === "Select provider to enable/disable") {
        const zaiOption = options.find((option) =>
          option.includes("z.ai (zai)"),
        );
        expect(zaiOption).toBeDefined();
        expect(zaiOption).toContain("credentials: detected");
        return Promise.resolve(zaiOption);
      }

      if (message === "Save provider setting to") {
        return Promise.resolve("Global (global.json)");
      }

      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(configMod.saveConfigFile).toHaveBeenCalledWith(
      "global.json",
      expect.objectContaining({ disabledProviders: [] }),
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Enabled z.ai"),
      "info",
    );
  });
});
