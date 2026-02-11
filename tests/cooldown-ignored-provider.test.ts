import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
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

describe("429 cooldown and ignored provider behavior", () => {
  type CommandHandler = (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<void>;

  type SelectorContext = {
    hasUI: boolean;
    model: { provider: string; id: string } | undefined;
    modelRegistry: {
      find: (
        provider: string,
        id: string,
      ) => { provider: string; id: string } | undefined;
      getAvailable: () => Promise<Array<{ provider: string; id: string }>>;
    };
    ui: {
      notify: (message: string, level: "info" | "warning" | "error") => void;
    };
  };

  let commands: Record<string, CommandHandler> = {};
  let ctx: SelectorContext;
  let persistedCooldownState: { cooldowns: Record<string, number> };
  const writeFileCallback: (path: string, data: string) => void = vi.fn();

  const configWithIgnoredProvider: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "p1", account: "acc1" },
        ignore: true,
      },
      {
        usage: { provider: "anthropic" },
        ignore: true,
      },
      {
        usage: { provider: "p2" },
        model: { provider: "p2", id: "model2" },
      },
      {
        usage: { provider: "p3" },
        model: { provider: "p3", id: "model3" },
      },
    ],
    priority: ["fullAvailability", "remainingPercent", "earliestReset"],
    widget: { enabled: false, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  const configWithoutIgnoredProvider: LoadedConfig = {
    mappings: [
      {
        usage: { provider: "p2" },
        model: { provider: "p2", id: "model2" },
      },
      {
        usage: { provider: "p3" },
        model: { provider: "p3", id: "model3" },
      },
    ],
    priority: ["fullAvailability", "remainingPercent", "earliestReset"],
    widget: { enabled: false, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  const getCurrentTimestamp = () => Date.now();

  const getCooldownKey = (provider: string, account?: string) =>
    `${provider}|${account ?? ""}|*`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T17:00:00.000Z"));

    persistedCooldownState = { cooldowns: {} };
    commands = {};

    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(
        (name: string, options: { handler: CommandHandler }) => {
          commands[name] = options.handler;
        },
      ),
      setModel: vi.fn().mockResolvedValue(true),
    };

    ctx = {
      hasUI: true,
      model: undefined,
      modelRegistry: {
        find: vi.fn(
          (provider: string, id: string): { provider: string; id: string } => ({
            provider,
            id,
          }),
        ),
        getAvailable: () =>
          Promise.resolve([
            { provider: "p1", id: "model1" },
            { provider: "p2", id: "model2" },
            { provider: "p3", id: "model3" },
            { provider: "anthropic", id: "claude" },
          ]),
      },
      ui: {
        notify: vi.fn(),
      },
    };

    // Mock file system for cooldown persistence
    vi.mocked(fs.promises.readFile).mockImplementation(
      (filePath: string | { toString(): string }) => {
        const pathStr =
          typeof filePath === "string" ? filePath : String(filePath);
        if (pathStr.includes("model-selector-cooldowns.json")) {
          return Promise.resolve(
            Buffer.from(
              JSON.stringify({
                cooldowns: persistedCooldownState.cooldowns,
                lastSelected: null,
              }),
            ),
          );
        }
        return Promise.resolve(Buffer.from("{}"));
      },
    );

    vi.mocked(fs.promises.writeFile).mockImplementation(
      (file: string | { toString(): string }, data: unknown) => {
        const pathStr = typeof file === "string" ? file : String(file);
        const dataStr = typeof data === "string" ? data : String(data);
        if (pathStr.includes("model-selector-cooldowns")) {
          const parsed = JSON.parse(dataStr) as {
            cooldowns: Record<string, number>;
          };
          persistedCooldownState.cooldowns = parsed.cooldowns;
        }
        writeFileCallback(pathStr, dataStr);
        return Promise.resolve(undefined);
      },
    );

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("skips 429 cooldown for providers with catch-all ignore mappings", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue(
      configWithIgnoredProvider,
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "HTTP 429 Too Many Requests",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        account: "acc2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);

    const selectHandler = commands["model-select"];
    await selectHandler({}, ctx as unknown as Record<string, unknown>);

    // No 429 notification should be shown for ignored provider
    const notifications = vi.mocked(ctx.ui.notify).mock.calls;
    const fourTwoNineNotifications = notifications.filter(
      (call) => call[0].includes("429") || call[0].includes("Rate limit"),
    );

    expect(fourTwoNineNotifications).toHaveLength(0);

    // No cooldown should be set for ignored provider
    const cooldownKey = getCooldownKey("p1", "acc1");
    expect(persistedCooldownState.cooldowns[cooldownKey]).toBeUndefined();
  });

  it("applies 429 cooldown for providers without ignore mappings", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue(
      configWithoutIgnoredProvider,
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "HTTP 429 Too Many Requests",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        account: "acc2",
        windows: [{ label: "w2", usedPercent: 20, resetsAt: new Date() }],
      },
    ]);

    const selectHandler = commands["model-select"];
    await selectHandler({}, ctx as unknown as Record<string, unknown>);

    // 429 notification should be shown for non-ignored provider
    const notifications = vi.mocked(ctx.ui.notify).mock.calls;
    const fourTwoNineNotifications = notifications.filter(
      (call) => call[0].includes("429") || call[0].includes("Rate limit"),
    );

    expect(fourTwoNineNotifications.length).toBeGreaterThan(0);
    expect(fourTwoNineNotifications[0][0]).toContain("Rate limit (429)");
    expect(fourTwoNineNotifications[0][0]).toContain("Provider 1");
    expect(fourTwoNineNotifications[0][1]).toBe("warning");

    // Cooldown should be set for non-ignored provider
    const cooldownKey = getCooldownKey("p1", "acc1");
    expect(persistedCooldownState.cooldowns[cooldownKey]).toBeDefined();
    expect(persistedCooldownState.cooldowns[cooldownKey]).toBeGreaterThan(
      getCurrentTimestamp(),
    );
  });

  it("handles mixed scenario: ignored providers skip cooldown, others apply it", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue(
      configWithIgnoredProvider,
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "HTTP 429 Too Many Requests",
        windows: [{ label: "w1", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        account: "acc2",
        error: "HTTP 429 Too Many Requests",
        windows: [{ label: "w2", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        error: "HTTP 429 Too Many Requests",
        windows: [{ label: "w3", usedPercent: 100, resetsAt: new Date() }],
      },
      {
        provider: "p3",
        displayName: "Provider 3",
        account: "acc3",
        windows: [{ label: "w4", usedPercent: 10, resetsAt: new Date() }],
      },
    ]);

    const selectHandler = commands["model-select"];
    await selectHandler({}, ctx as unknown as Record<string, unknown>);

    // Check cooldown state
    const p1CooldownKey = getCooldownKey("p1", "acc1");
    const p2CooldownKey = getCooldownKey("p2", "acc2");
    const anthropicCooldownKey = getCooldownKey("anthropic");

    // p1 and anthropic are ignored, should NOT have cooldowns
    expect(persistedCooldownState.cooldowns[p1CooldownKey]).toBeUndefined();
    expect(
      persistedCooldownState.cooldowns[anthropicCooldownKey],
    ).toBeUndefined();

    // p2 is NOT ignored, should have a cooldown
    expect(persistedCooldownState.cooldowns[p2CooldownKey]).toBeDefined();
    expect(persistedCooldownState.cooldowns[p2CooldownKey]).toBeGreaterThan(
      getCurrentTimestamp(),
    );

    // Only p2 should have a 429 notification
    const notifications = vi.mocked(ctx.ui.notify).mock.calls;
    const fourTwoNineNotifications = notifications.filter(
      (call) => call[0].includes("429") || call[0].includes("Rate limit"),
    );

    expect(fourTwoNineNotifications.length).toBe(1);
    expect(fourTwoNineNotifications[0][0]).toContain("Provider 2");
  });

  it("skips error notifications for ignored providers (non-429 errors)", async () => {
    vi.mocked(configMod.loadConfig).mockResolvedValue(
      configWithIgnoredProvider,
    );

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue([
      {
        provider: "p1",
        displayName: "Provider 1",
        account: "acc1",
        error: "API Key invalid",
        windows: [],
      },
      {
        provider: "p2",
        displayName: "Provider 2",
        account: "acc2",
        error: "Network error",
        windows: [],
      },
    ]);

    const selectHandler = commands["model-select"];
    await selectHandler({}, ctx as unknown as Record<string, unknown>);

    const notifications = vi.mocked(ctx.ui.notify).mock.calls;
    const errorNotifications = notifications.filter(
      (call) => call[1] === "warning" || call[1] === "error",
    );

    // p1 is ignored, should NOT have error notification
    const p1ErrorNotification = errorNotifications.filter((call) =>
      call[0].includes("Provider 1"),
    );
    expect(p1ErrorNotification).toHaveLength(0);

    // p2 is NOT ignored, SHOULD have error notification
    const p2ErrorNotification = errorNotifications.filter((call) =>
      call[0].includes("Provider 2"),
    );
    expect(p2ErrorNotification).toHaveLength(1);
    expect(p2ErrorNotification[0][0]).toContain("Network error");
  });
});
