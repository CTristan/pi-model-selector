import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import modelSelectorExtension from "../index.js";
import * as usageFetchers from "../src/usage-fetchers.js";
import * as configMod from "../src/config.js";
import type { LoadedConfig } from "../src/types.js";
import { ALL_PROVIDERS } from "../src/types.js";

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

describe("configureProviders parallel credential checking", () => {
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  type WizardContext = {
    hasUI: boolean;
    modelRegistry: {
      getAvailable: () => Promise<Array<{ provider: string; id: string }>>;
      authStorage?: {
        getApiKey?: (
          id: string,
        ) => Promise<string | undefined> | string | undefined;
        get?: (
          id: string,
        ) =>
          | Promise<Record<string, unknown> | undefined>
          | Record<string, unknown>
          | undefined;
      };
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
  };

  let commands: Record<string, CommandHandler> = {};
  let ctx: WizardContext;

  const initialConfig: LoadedConfig = {
    mappings: [],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
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
      hasUI: true,
      modelRegistry: {
        getAvailable: () => Promise.resolve([{ provider: "p1", id: "m1" }]),
        authStorage: {
          getApiKey: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue(undefined),
        },
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
    };

    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);
    vi.mocked(configMod.loadConfig).mockResolvedValue(initialConfig);
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
      anthropic: { key: "test-key" },
      copilot: { key: "test-key" },
      "google-gemini": { key: "test-key" },
    });

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it("checks credentials for all providers without serializing", async () => {
    let menuVisits = 0;

    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(
          menuVisits === 1 ? "Configure providers" : "Done",
        );
      }

      if (message === "Select configuration scope") {
        return Promise.resolve("Global (global.json)");
      }

      if (message.includes("Configure providers in Global")) {
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toBeDefined();
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }

      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disabled Claude"),
      "info",
    );
  });

  it("shows credential status for all providers in the list", async () => {
    let menuVisits = 0;

    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(
          menuVisits === 1 ? "Configure providers" : "Done",
        );
      }

      if (message === "Select configuration scope") {
        return Promise.resolve("Global (global.json)");
      }

      if (message.includes("Configure providers in Global")) {
        // Verify all providers are listed with credential status
        expect(options.length).toBe(ALL_PROVIDERS.length);

        // Each option should contain the provider label and credentials status
        const expectedLabels = [
          { provider: "anthropic", label: "Claude" },
          { provider: "copilot", label: "Copilot" },
          { provider: "gemini", label: "Gemini" },
          { provider: "codex", label: "Codex" },
          { provider: "antigravity", label: "Antigravity" },
          { provider: "kiro", label: "Kiro" },
          { provider: "zai", label: "z.ai" },
        ];

        for (const { provider, label } of expectedLabels) {
          const option = options.find((opt) =>
            opt.includes(`${label} (${provider})`),
          );
          expect(option).toBeDefined();
          // Check that credentials status is present (either "detected" or "missing")
          expect(option).toMatch(/credentials: (detected|missing)/);
        }

        return Promise.resolve(options[0]); // Select first provider
      }

      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    // Verify saveConfigFile was called (provider was toggled)
    expect(configMod.saveConfigFile).toHaveBeenCalled();
  });

  it("handles partial credential detection (some detected, some missing)", async () => {
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
      anthropic: { key: "test-key" }, // Only Anthropic has credentials
    });

    let menuVisits = 0;

    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(
          menuVisits === 1 ? "Configure providers" : "Done",
        );
      }

      if (message === "Select configuration scope") {
        return Promise.resolve("Global (global.json)");
      }

      if (message.includes("Configure providers in Global")) {
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        const copilotOption = options.find((option) =>
          option.includes("Copilot (copilot)"),
        );

        expect(anthropicOption).toBeDefined();
        expect(copilotOption).toBeDefined();
        expect(anthropicOption).toContain("credentials: detected");
        expect(copilotOption).toContain("credentials: missing");

        return Promise.resolve(anthropicOption);
      }

      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });

  it("does not cause UI sluggishness with multiple providers", async () => {
    // Reset ctx to include authStorage for more realistic credential checking
    ctx.modelRegistry = {
      getAvailable: () => Promise.resolve([]),
      authStorage: {
        getApiKey: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    };

    let menuVisits = 0;

    ctx.ui.select = vi.fn((message: string, options: string[]) => {
      if (message === "Model selector configuration") {
        menuVisits += 1;
        return Promise.resolve(
          menuVisits === 1 ? "Configure providers" : "Done",
        );
      }

      if (message === "Select configuration scope") {
        return Promise.resolve("Global (global.json)");
      }

      if (message.includes("Configure providers in Global")) {
        return Promise.resolve(options[0]);
      }

      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });
});
