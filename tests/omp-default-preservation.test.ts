import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CooldownManager } from "../src/cooldown.js";
import type { LoadedConfig, UsageSnapshot } from "../src/types.js";

interface FakeOmpSettings {
  roles: Record<string, unknown>;
  getModelRole: Mock<(role: string) => string | undefined>;
  setModelRole: Mock<(role: string, modelId: string) => void>;
  get: Mock<(path: "modelRoles") => unknown>;
  set: Mock<(path: "modelRoles", value: Record<string, unknown>) => void>;
  flush: Mock<() => Promise<void>>;
}

describe("OMP default model preservation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../src/adapter.js");
    vi.doUnmock("../src/widget.js");
  });

  it("restores an existing OMP default role after selector-driven model changes", async () => {
    const settings = createFakeOmpSettings({
      default: "anthropic/claude-opus",
      review: "google/gemini-pro",
    });
    const { runSelector } = await loadSelectorWithSettings(settings);
    const pi = createPi(settings);

    const result = await runSelector(
      createContext(),
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "startup",
      {
        preloadedConfig: createConfig(true),
        preloadedUsages: createUsages(),
      },
      pi,
      { current: false },
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p1", id: "m1" }),
    );
    expect(settings.roles).toEqual({
      default: "anthropic/claude-opus",
      review: "google/gemini-pro",
    });
    expect(settings.setModelRole.mock.calls.at(-1)).toEqual([
      "default",
      "anthropic/claude-opus",
    ]);
    expect(settings.flush).toHaveBeenCalledTimes(1);
  });

  it("removes modelRoles.default again when it was absent before selection", async () => {
    const settings = createFakeOmpSettings({ review: "google/gemini-pro" });
    const { runSelector } = await loadSelectorWithSettings(settings);
    const pi = createPi(settings);

    const result = await runSelector(
      createContext(),
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "command",
      {
        preloadedConfig: createConfig(true),
        preloadedUsages: createUsages(),
      },
      pi,
      { current: false },
    );

    expect(result).toBe(true);
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "p1", id: "m1" }),
    );
    expect(Object.hasOwn(settings.roles, "default")).toBe(false);
    expect(settings.roles).toEqual({ review: "google/gemini-pro" });
    expect(settings.set).toHaveBeenCalledWith("modelRoles", {
      review: "google/gemini-pro",
    });
    expect(settings.flush).toHaveBeenCalledTimes(1);
  });

  it("leaves OMP default changes intact when preservation is disabled", async () => {
    const settings = createFakeOmpSettings({
      default: "anthropic/claude-opus",
    });
    const { runSelector } = await loadSelectorWithSettings(settings);
    const pi = createPi(settings);

    const result = await runSelector(
      createContext(),
      createCooldownManager(),
      createModelLockCoordinator(),
      { current: null },
      { current: null },
      false,
      "auto",
      {
        preloadedConfig: createConfig(false),
        preloadedUsages: createUsages(),
      },
      pi,
      { current: false },
    );

    expect(result).toBe(true);
    expect(settings.roles.default).toBe("p1/m1");
    expect(settings.flush).not.toHaveBeenCalled();
  });

  it("throws the restore error when preservation fails after a successful action", async () => {
    const { withPreservedOmpDefaultModelRole } = await import(
      "../src/adapter.js"
    );
    const settings = createSettingsWithoutDirectSet({});

    await expect(
      withPreservedOmpDefaultModelRole(true, async () => true, settings),
    ).rejects.toThrow("absent default model role");
  });

  it("rethrows the action error after a successful restore", async () => {
    const { withPreservedOmpDefaultModelRole } = await import(
      "../src/adapter.js"
    );
    const settings = createFakeOmpSettings({
      default: "anthropic/claude-opus",
    });

    await expect(
      withPreservedOmpDefaultModelRole(
        true,
        async () => {
          settings.setModelRole("default", "p1/m1");
          throw new Error("set failed");
        },
        settings,
      ),
    ).rejects.toThrow("set failed");

    expect(settings.roles.default).toBe("anthropic/claude-opus");
  });

  it("preserves the action error when both action and restoration fail", async () => {
    const { withPreservedOmpDefaultModelRole } = await import(
      "../src/adapter.js"
    );
    const settings = createSettingsWithoutDirectSet({});

    await expect(
      withPreservedOmpDefaultModelRole(
        true,
        async () => {
          throw new Error("set failed");
        },
        settings,
      ),
    ).rejects.toThrow("set failed");
  });
});

async function loadSelectorWithSettings(settings: FakeOmpSettings) {
  vi.doMock("../src/adapter.js", async () => {
    const actual =
      await vi.importActual<typeof import("../src/adapter.js")>(
        "../src/adapter.js",
      );
    return {
      ...actual,
      EXTENSION_DIR: ".omp",
      isOmp: true,
      withPreservedOmpDefaultModelRole: <T>(
        preserveDefaultModel: boolean | undefined,
        action: () => Promise<T>,
      ): Promise<T> =>
        actual.withPreservedOmpDefaultModelRole(
          preserveDefaultModel,
          action,
          settings,
        ),
    };
  });

  vi.doMock("../src/widget.js", () => ({
    updateWidgetState: vi.fn(),
    renderUsageWidget: vi.fn(),
    clearWidget: vi.fn(),
    getWidgetState: vi.fn(),
  }));

  return await import("../src/selector.js");
}

function createFakeOmpSettings(
  initialRoles: Record<string, unknown>,
): FakeOmpSettings {
  const roles = { ...initialRoles };
  return {
    roles,
    getModelRole: vi.fn((role: string) => {
      const value = roles[role];
      return typeof value === "string" ? value : undefined;
    }),
    setModelRole: vi.fn((role: string, modelId: string) => {
      roles[role] = modelId;
    }),
    get: vi.fn((path: "modelRoles") => {
      if (path !== "modelRoles") return undefined;
      return roles;
    }),
    set: vi.fn((path: "modelRoles", value: Record<string, unknown>) => {
      if (path !== "modelRoles") return;
      for (const key of Object.keys(roles)) {
        delete roles[key];
      }
      Object.assign(roles, value);
    }),
    flush: vi.fn(async () => {}),
  };
}

function createSettingsWithoutDirectSet(
  initialRoles: Record<string, unknown>,
): FakeOmpSettings {
  const settings = createFakeOmpSettings(initialRoles);
  return {
    roles: settings.roles,
    getModelRole: settings.getModelRole,
    setModelRole: settings.setModelRole,
    get: settings.get,
    set: undefined,
    flush: settings.flush,
  } as unknown as FakeOmpSettings;
}

function createConfig(preserveDefaultModel: boolean): LoadedConfig {
  return {
    mappings: [
      {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "p1", id: "m1" },
      },
    ],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    enableModelLocking: true,
    preserveDefaultModel,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };
}

function createUsages(): UsageSnapshot[] {
  return [
    {
      provider: "p1",
      displayName: "Provider 1",
      windows: [
        {
          label: "w1",
          usedPercent: 10,
          resetsAt: new Date(Date.now() + 60_000),
        },
      ],
    },
  ];
}

function createCooldownManager(): CooldownManager {
  return {
    loadPersistedCooldowns: vi.fn().mockResolvedValue(undefined),
    pruneExpiredCooldowns: vi.fn(),
    setOrExtendProviderCooldown: vi.fn().mockReturnValue(false),
    getWildcardExpiry: vi.fn().mockReturnValue(undefined),
    isOnCooldown: vi.fn().mockReturnValue(false),
    clear: vi.fn(),
    setLastSelectedKey: vi.fn(),
    persistCooldowns: vi.fn().mockResolvedValue(undefined),
  } as unknown as CooldownManager;
}

function createModelLockCoordinator() {
  return {
    acquire: vi.fn().mockResolvedValue({ acquired: true }),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    releaseAll: vi.fn().mockResolvedValue(0),
  };
}

function createContext(): ExtensionContext {
  return {
    signal: new AbortController().signal,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    } as unknown as ExtensionContext["modelRegistry"],
    model: {
      provider: "other",
      id: "other-model",
    } as ExtensionContext["model"],
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ExtensionContext["ui"],
    hasUI: true,
    cwd: "/mock",
    sessionManager: {} as ExtensionContext["sessionManager"],
    isIdle: vi.fn().mockReturnValue(true),
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn().mockReturnValue(undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue(""),
  } as ExtensionContext;
}

function createPi(settings: FakeOmpSettings): ExtensionAPI {
  return {
    setModel: vi.fn(async (model: { provider: string; id: string }) => {
      settings.setModelRole("default", `${model.provider}/${model.id}`);
      return true;
    }),
  } as unknown as ExtensionAPI;
}
