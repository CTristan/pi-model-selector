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

describe("Anthropic credential detection (PR fix)", () => {
  let getApiKeyMock: ReturnType<
    typeof vi.fn<(id: string) => Promise<string | undefined>>
  >;
  let getMock: ReturnType<
    typeof vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>
  >;

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

    getApiKeyMock = vi.fn<(id: string) => Promise<string | undefined>>();
    getMock =
      vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>();

    ctx = {
      modelRegistry: {
        getAvailable: () => Promise.resolve([{ provider: "p1", id: "m1" }]),
        authStorage: {
          getApiKey: getApiKeyMock,
          get: getMock,
        },
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
    vi.restoreAllMocks();
  });

  it("detects Anthropic credentials from authStorage API key", async () => {
    getApiKeyMock.mockResolvedValue("sk-ant-test-key-123");
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

    expect(getApiKeyMock).toHaveBeenCalledWith("anthropic");
  });

  it("detects Anthropic credentials from authStorage data with access field", async () => {
    getApiKeyMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue({
      access: "test-access-token",
      refresh: "test-refresh-token",
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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(getMock).toHaveBeenCalledWith("anthropic");
  });

  it("detects Anthropic credentials from authStorage data with accessToken field", async () => {
    getApiKeyMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue({
      accessToken: "test-access-token",
      expires: Date.now() + 3600000,
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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);

    expect(getMock).toHaveBeenCalledWith("anthropic");
  });

  it("detects Anthropic credentials from authStorage data with token field", async () => {
    getApiKeyMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue({
      token: "test-token-value",
      expiry_date: Date.now() + 3600000,
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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });

  it("shows credentials: missing when no Anthropic credentials exist in authStorage", async () => {
    getApiKeyMock.mockResolvedValue(undefined);
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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: missing");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });

  it("falls back to piAuth when authStorage has no Anthropic credentials", async () => {
    getApiKeyMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue(undefined);
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
      anthropic: { access: "auth-json-token" },
    });

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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });

  it("handles authStorage access errors gracefully and falls back to piAuth", async () => {
    getApiKeyMock.mockRejectedValue(new Error("Registry access failed"));
    vi.mocked(usageFetchers.loadPiAuth).mockResolvedValue({
      anthropic: { access: "fallback-token" },
    });

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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });

  it("detects Anthropic from authStorage even without piAuth", async () => {
    getApiKeyMock.mockResolvedValue("sk-ant-registry-key");
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
        const anthropicOption = options.find((option) =>
          option.includes("Claude (anthropic)"),
        );
        expect(anthropicOption).toContain("credentials: detected");
        return Promise.resolve(anthropicOption);
      }
      return Promise.resolve(undefined);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx as unknown as Record<string, unknown>);
  });
});
