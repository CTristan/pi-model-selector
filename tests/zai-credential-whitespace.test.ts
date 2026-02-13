import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import type { LoadedConfig } from "../src/types.js";
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
  platform: () => "darwin",
}));

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js");

describe("Z.ai Credential Whitespace Handling", () => {
  const originalZaiKey = process.env.Z_AI_API_KEY;
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
    delete process.env.Z_AI_API_KEY;

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
    if (originalZaiKey !== undefined) {
      process.env.Z_AI_API_KEY = originalZaiKey;
    } else {
      delete process.env.Z_AI_API_KEY;
    }
  });

  describe("Environment variable with whitespace", () => {
    it("detects credentials from Z_AI_API_KEY with leading/trailing spaces", async () => {
      process.env.Z_AI_API_KEY = "  zai-key-123  ";

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
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

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: detected");
    });

    it("detects credentials from Z_AI_API_KEY with tabs and newlines", async () => {
      process.env.Z_AI_API_KEY = "  \tzai-key-456\n  ";

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: detected");
    });
  });

  describe("piAuth with whitespace", () => {
    it("detects credentials from piAuth z-ai.access with whitespace", async () => {
      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
        "z-ai": { access: "  zai-access-key  " },
      });

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: detected");
    });

    it("detects credentials from piAuth zai.key with whitespace", async () => {
      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
        zai: { key: "  \tzai-key-field  \n" },
      });

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: detected");
    });
  });

  describe("Empty after trimming", () => {
    it("reports credentials: missing when env var contains only whitespace", async () => {
      process.env.Z_AI_API_KEY = "   \t\n  ";

      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({});

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: missing");
    });

    it("reports credentials: missing when piAuth field contains only whitespace", async () => {
      vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
        "z-ai": { access: "   \t  " },
      });

      let menuVisits = 0;
      ctx.ui.select = vi.fn((message: string, options: string[]) => {
        if (message === "Model selector configuration") {
          menuVisits++;
          if (menuVisits === 1) {
            return Promise.resolve("Configure providers");
          }
          if (menuVisits === 2) {
            return Promise.resolve("Done");
          }
        }
        if (message === "Select configuration scope") {
          return Promise.resolve("Global (global.json)");
        }
        if (message.includes("Configure providers in Global")) {
          const zaiOption = options.find((option) =>
            option.includes("z.ai (zai)"),
          );
          return Promise.resolve(zaiOption);
        }
        return Promise.resolve(undefined);
      });

      ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

      const runWizard = commands["model-select-config"];
      await runWizard({}, ctx);

      const selectCalls = vi.mocked(ctx.ui.select).mock.calls;
      const providerSelectCall = selectCalls.find((call) =>
        call[0]?.includes("Configure providers in Global"),
      );
      const options = providerSelectCall?.[1] as string[];
      const zaiOption = options.find((o) => o.includes("z.ai"));
      expect(zaiOption).toContain("credentials: missing");
    });
  });
});
