import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Provider Credential Detection", () => {
  // Snapshot only the specific env vars we modify, not the entire process.env
  const originalZaiKey = process.env.Z_AI_API_KEY;
  const originalAntigravityKey = process.env.ANTIGRAVITY_API_KEY;
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  type WizardContext = {
    modelRegistry: {
      getAvailable: () => Promise<Array<{ provider: string; id: string }>>;
      authStorage?: {
        getApiKey?: (id: string) => Promise<string | undefined>;
        get?: (id: string) => Promise<Record<string, unknown> | undefined>;
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
    hasUI: boolean;
  };

  let commands: Record<string, CommandHandler> = {};
  let ctx: WizardContext;

  const baseConfig: LoadedConfig = {
    mappings: [],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  beforeEach(() => {
    // Clear only the specific environment variables we modify
    delete process.env.Z_AI_API_KEY;
    delete process.env.ANTIGRAVITY_API_KEY;

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
    vi.mocked(configMod.loadConfig).mockResolvedValue(baseConfig);
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  afterEach(() => {
    // Restore only the specific environment variables we modified
    if (originalZaiKey !== undefined) {
      process.env.Z_AI_API_KEY = originalZaiKey;
    } else {
      delete process.env.Z_AI_API_KEY;
    }
    if (originalAntigravityKey !== undefined) {
      process.env.ANTIGRAVITY_API_KEY = originalAntigravityKey;
    } else {
      delete process.env.ANTIGRAVITY_API_KEY;
    }
  });

  describe("Gemini credential detection", () => {
    it("detects credentials from google-gemini (PR fix)", async () => {
      const piAuthGemini = {
        "google-gemini": { access: "ya29.test-token" },
      };

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue(piAuthGemini);

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const geminiOption = options.find((option) =>
            option.includes("Gemini (gemini)"),
          );
          expect(geminiOption).toBeDefined();
          expect(geminiOption).toContain("credentials: detected");
          return Promise.resolve(geminiOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      expect(ctx.ui.select).toHaveBeenCalled();
      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      expect(providerSelectCall).toBeDefined();
      const options = providerSelectCall?.[1] as string[];
      const geminiOption = options.find((o) => o.includes("Gemini"));
      expect(geminiOption).toContain("credentials: detected");
    });

    it("detects credentials from google-gemini-cli", async () => {
      const piAuthGemini = {
        "google-gemini-cli": { access: "ya29.test-token" },
      };

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue(piAuthGemini);

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const geminiOption = options.find((option) =>
            option.includes("Gemini (gemini)"),
          );
          return Promise.resolve(geminiOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const geminiOption = options.find((o) => o.includes("Gemini"));
      expect(geminiOption).toContain("credentials: detected");
    });
  });

  describe("Antigravity credential detection", () => {
    it("detects credentials from anti-gravity (PR fix)", async () => {
      const piAuthAntigravity = {
        "anti-gravity": { access: "ya29.test-token" },
      };

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue(piAuthAntigravity);

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const antigravityOption = options.find((option) =>
            option.includes("Antigravity (antigravity)"),
          );
          expect(antigravityOption).toBeDefined();
          expect(antigravityOption).toContain("credentials: detected");
          return Promise.resolve(antigravityOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const antigravityOption = options.find((o) => o.includes("Antigravity"));
      expect(antigravityOption).toContain("credentials: detected");
    });

    it("detects credentials from ANTIGRAVITY_API_KEY env var (PR fix)", async () => {
      process.env.ANTIGRAVITY_API_KEY = "test-api-key-123";

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const antigravityOption = options.find((option) =>
            option.includes("Antigravity (antigravity)"),
          );
          expect(antigravityOption).toBeDefined();
          expect(antigravityOption).toContain("credentials: detected");
          return Promise.resolve(antigravityOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const antigravityOption = options.find((o) => o.includes("Antigravity"));
      expect(antigravityOption).toContain("credentials: detected");
    });
  });

  describe("Copilot credential detection", () => {
    it("detects credentials from github-copilot", async () => {
      const piAuthCopilot = {
        "github-copilot": { access: "ghp_123456" },
      };

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue(piAuthCopilot);

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const copilotOption = options.find((option) =>
            option.includes("Copilot (copilot)"),
          );
          expect(copilotOption).toBeDefined();
          expect(copilotOption).toContain("credentials: detected");
          return Promise.resolve(copilotOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const copilotOption = options.find((o) => o.includes("Copilot"));
      expect(copilotOption).toContain("credentials: detected");
    });
  });

  describe("z.ai credential detection", () => {
    it("detects credentials from Z_AI_API_KEY env var", async () => {
      process.env.Z_AI_API_KEY = "zai-api-key-123";

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          expect(zaiOption).toBeDefined();
          expect(zaiOption).toContain("credentials: detected");
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: detected");
    });
  });

  describe("Missing credentials", () => {
    it("shows credentials: missing when no credentials are found", async () => {
      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          return Promise.resolve(
            menuVisits === 1 ? "Configure providers" : "Done",
          );
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          // Check all providers show "credentials: missing"
          for (const option of options) {
            expect(option).toContain("credentials: missing");
          }
          return Promise.resolve(options[0]);
        }
        return Promise.resolve(undefined);
      });

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx as unknown as Record<string, unknown>);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find(
        (call) => call[0] && call[0].includes("Configure providers in Global"),
      );
      expect(providerSelectCall).toBeDefined();
    });
  });

  describe("authStorage credential detection (PR fix)", () => {
    let getApiKeyMock: ReturnType<
      typeof vi.fn<(id: string) => Promise<string | undefined>>
    >;
    let getMock: ReturnType<
      typeof vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>
    >;

    beforeEach(() => {
      // Add authStorage to modelRegistry
      getApiKeyMock = vi.fn<(id: string) => Promise<string | undefined>>();
      getMock =
        vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>();
      ctx.modelRegistry.authStorage = {
        getApiKey: getApiKeyMock as (id: string) => Promise<string | undefined>,
        get: getMock as (
          id: string,
        ) => Promise<Record<string, unknown> | undefined>,
      };
    });

    describe("Copilot authStorage", () => {
      it("detects credentials from registry github-copilot API key", async () => {
        getApiKeyMock.mockResolvedValue("ghu_copilot_token_123");
        getMock.mockResolvedValue(undefined);
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const copilotOption = options.find((option) =>
              option.includes("Copilot (copilot)"),
            );
            expect(copilotOption).toContain("credentials: detected");
            return Promise.resolve(copilotOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getApiKeyMock).toHaveBeenCalledWith("github-copilot");
      });

      it("detects credentials from registry github API key", async () => {
        getApiKeyMock.mockResolvedValue("ghu_github_token_123");
        getMock.mockResolvedValue(undefined);
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const copilotOption = options.find((option) =>
              option.includes("Copilot (copilot)"),
            );
            expect(copilotOption).toContain("credentials: detected");
            return Promise.resolve(copilotOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getApiKeyMock).toHaveBeenCalledWith("github");
      });

      it("detects credentials from registry github-copilot data", async () => {
        getApiKeyMock.mockResolvedValue(undefined);
        getMock.mockResolvedValue({
          access: "ghu_data_token_123",
        });
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const copilotOption = options.find((option) =>
              option.includes("Copilot (copilot)"),
            );
            expect(copilotOption).toContain("credentials: detected");
            return Promise.resolve(copilotOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getMock).toHaveBeenCalledWith("github-copilot");
      });
    });

    describe("Gemini authStorage", () => {
      it("detects credentials from registry google-gemini API key", async () => {
        getApiKeyMock.mockResolvedValue("ya29.gemini_token_123");
        getMock.mockResolvedValue(undefined);
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const geminiOption = options.find((option) =>
              option.includes("Gemini (gemini)"),
            );
            expect(geminiOption).toContain("credentials: detected");
            return Promise.resolve(geminiOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getApiKeyMock).toHaveBeenCalledWith("google-gemini");
      });

      it("detects credentials from registry google-gemini-cli API key", async () => {
        getApiKeyMock.mockResolvedValue("ya29.gemini_cli_token_123");
        getMock.mockResolvedValue(undefined);
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const geminiOption = options.find((option) =>
              option.includes("Gemini (gemini)"),
            );
            expect(geminiOption).toContain("credentials: detected");
            return Promise.resolve(geminiOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getApiKeyMock).toHaveBeenCalledWith("google-gemini-cli");
      });

      it("detects credentials from registry google-gemini data", async () => {
        getApiKeyMock.mockResolvedValue(undefined);
        getMock.mockResolvedValue({
          access: "ya29.gemini_data_token_123",
        });
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const geminiOption = options.find((option) =>
              option.includes("Gemini (gemini)"),
            );
            expect(geminiOption).toContain("credentials: detected");
            return Promise.resolve(geminiOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getMock).toHaveBeenCalledWith("google-gemini");
      });
    });

    describe("Antigravity authStorage", () => {
      it("detects credentials from registry google-antigravity API key", async () => {
        getApiKeyMock.mockResolvedValue("ya29.antigravity_token_123");
        getMock.mockResolvedValue(undefined);
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const antigravityOption = options.find((option) =>
              option.includes("Antigravity (antigravity)"),
            );
            expect(antigravityOption).toContain("credentials: detected");
            return Promise.resolve(antigravityOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getApiKeyMock).toHaveBeenCalledWith("google-antigravity");
      });

      it("detects credentials from registry google-antigravity data", async () => {
        getApiKeyMock.mockResolvedValue(undefined);
        getMock.mockResolvedValue({
          access: "ya29.antigravity_data_token_123",
        });
        vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

        let menuVisits = 0;
        ctx.ui.select = vi.fn((message: string, options: string[]) => {
          if (message === "Model selector configuration") {
            menuVisits++;
            return Promise.resolve(
              menuVisits === 1 ? "Configure providers" : "Done",
            );
          }
          if (message === "Select configuration scope") {
            return Promise.resolve("Global (global.json)");
          }
          if (message.includes("Configure providers in Global")) {
            const antigravityOption = options.find((option) =>
              option.includes("Antigravity (antigravity)"),
            );
            expect(antigravityOption).toContain("credentials: detected");
            return Promise.resolve(antigravityOption);
          }
          return Promise.resolve(undefined);
        });

        const runWizard = commands["model-select-config"];
        await runWizard({}, ctx as unknown as Record<string, unknown>);

        expect(getMock).toHaveBeenCalledWith("google-antigravity");
      });
    });
  });
});
