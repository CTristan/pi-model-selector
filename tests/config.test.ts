/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadConfig,
  upsertMapping,
  updateWidgetConfig,
  saveConfigFile,
  removeMapping,
} from "../src/config.js";
import { MappingEntry } from "../src/types.js";
import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// Mock pi-coding-agent ExtensionContext
const mockCtx = {
  cwd: "/mock/cwd",
  ui: {
    notify: vi.fn(),
  },
  hasUI: true,
} as unknown as ExtensionContext;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      access: vi.fn(),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(true),
  };
});

describe("Config Loading", () => {
  beforeEach(() => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockReset();
    vi.mocked(mockCtx.ui.notify).mockReset();
  });

  it("should merge global and project configs correctly", async () => {
    const globalConfig = JSON.stringify({
      priority: ["remainingPercent"],
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          model: { provider: "anthropic", id: "global-sonnet" },
        },
      ],
    });

    const projectConfig = JSON.stringify({
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          model: { provider: "anthropic", id: "project-sonnet" },
        },
      ],
      widget: { enabled: false },
      autoRun: true,
    });

    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(projectConfig); // Project

    const config = await loadConfig(mockCtx);

    expect(config).not.toBeNull();
    expect(config?.mappings[0].model?.id).toBe("project-sonnet");
    expect(config?.widget.enabled).toBe(false);
    expect(config?.autoRun).toBe(true);
  });

  it("should handle missing files and return default values", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(fs.promises.access).mockRejectedValue(enoent);

    const config = await loadConfig(mockCtx, { requireMappings: false });
    expect(config).not.toBeNull();
    expect(config?.priority).toEqual([
      "fullAvailability",
      "earliestReset",
      "remainingPercent",
    ]);
  });

  it("should handle invalid JSON in config files", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue("invalid json");

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
    expect(mockCtx.ui.notify).toHaveBeenCalled();
  });

  it("should validate priority rules and tiebreakers", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        priority: ["fullAvailability"], // NO tiebreaker
        mappings: [{ usage: { provider: "p1" }, ignore: true }],
      }),
    );
    expect(await loadConfig(mockCtx)).toBeNull();

    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        priority: ["invalidRule", "remainingPercent"],
        mappings: [{ usage: { provider: "p1" }, ignore: true }],
      }),
    );
    expect(await loadConfig(mockCtx)).toBeNull();
  });

  it("should handle invalid mapping entries", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        mappings: [
          { usage: { provider: 123 } }, // provider must be string
          { usage: { provider: "p1", windowPattern: "[" } }, // invalid regex
          { usage: { provider: "p1" }, model: { provider: "p1" } }, // missing id
        ],
      }),
    );
    expect(await loadConfig(mockCtx)).toBeNull();
  });

  it("should skip incomplete mappings", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          { usage: { provider: "p1" } }, // incomplete, no model or ignore
          { usage: { provider: "p2" }, ignore: true },
        ],
      }),
    );
    const config = await loadConfig(mockCtx);
    expect(config?.mappings).toHaveLength(1);
  });

  it("should handle non-object config or array config", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue("[]");
    expect(await loadConfig(mockCtx)).toBeNull();
  });

  it("should handle partial widget config", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        widget: { placement: "aboveEditor" },
        mappings: [{ usage: { provider: "p1" }, ignore: true }],
      }),
    ); // Project
    const config = await loadConfig(mockCtx);
    expect(config?.widget.placement).toBe("aboveEditor");
    expect(config?.widget.enabled).toBe(true);
  });

  it("should handle autoRun boolean", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        autoRun: true,
        mappings: [{ usage: { provider: "p1" }, ignore: true }],
      }),
    ); // Project
    const config = await loadConfig(mockCtx);
    expect(config?.autoRun).toBe(true);
  });

  it("should normalize debug log paths", async () => {
    const debugConfig = {
      debugLog: { enabled: true, path: "relative/path.log" },
      mappings: [{ usage: { provider: "p1", ignore: true } }],
    };
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify(debugConfig),
    );

    const config = await loadConfig(mockCtx);
    if (config?.debugLog) {
      expect(config.debugLog.enabled).toBe(true);
      expect(config.debugLog.path).toContain("relative/path.log");
    }
  });

  it("should seed global config from hardcoded defaults if global doesn't exist", async () => {
    // Reset mocks for this specific test
    vi.mocked(fs.promises.access).mockReset();
    vi.mocked(fs.promises.readFile).mockReset();
    vi.mocked(fs.promises.writeFile).mockReset();

    vi.mocked(fs.promises.access).mockImplementation(() => {
      // Global and project configs don't exist
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(enoent);
    });

    vi.mocked(fs.promises.readFile).mockImplementation(() => {
      return Promise.reject(new Error("ENOENT"));
    });

    const config = await loadConfig(mockCtx);

    expect(fs.promises.writeFile).toHaveBeenCalled();
    // Default mappings length is 11
    expect(config?.mappings).toHaveLength(11);
    expect(config?.mappings[0].usage.provider).toBe("anthropic");
  });

  it("should NOT seed global config if file exists but is invalid JSON", async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined); // File exists
    vi.mocked(fs.promises.readFile).mockResolvedValue("invalid { json"); // But is invalid
    vi.mocked(fs.promises.writeFile).mockReset();

    const config = await loadConfig(mockCtx);

    expect(config).toBeNull();
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read"),
      "error",
    );
  });

  it("should NOT seed global config if global is missing but project config is invalid", async () => {
    vi.mocked(fs.promises.access).mockImplementation(() => {
      return Promise.resolve(undefined);
    });

    vi.mocked(fs.promises.readFile).mockImplementation((path) => {
      if (typeof path === "string" && !path.includes("/mock/cwd")) {
        // Global config missing
        const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Promise.reject(enoent);
      }
      // Project config (in /mock/cwd) is invalid
      return Promise.resolve("invalid { json");
    });
    vi.mocked(fs.promises.writeFile).mockReset();

    const config = await loadConfig(mockCtx);

    expect(config).toBeNull();
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
  });

  it("should save config files and handle errors", async () => {
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.promises.rename).mockResolvedValue(undefined);

    await saveConfigFile("/mock/path.json", { a: 1 });
    expect(fs.promises.writeFile).toHaveBeenCalled();

    vi.mocked(fs.promises.rename).mockRejectedValueOnce(new Error("fail"));
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    await expect(saveConfigFile("/mock/path.json", { a: 1 })).rejects.toThrow(
      "fail",
    );
    expect(fs.promises.unlink).toHaveBeenCalled();
  });
});

describe("Config Mutation", () => {
  it("should upsert mappings correctly", () => {
    const raw: Record<string, unknown> = { mappings: [] };
    const mapping: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    };

    upsertMapping(raw, mapping);
    expect(raw.mappings).toHaveLength(1);

    const updated: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m2" },
    };
    upsertMapping(raw, updated);
    expect(raw.mappings).toHaveLength(1);
    expect((raw.mappings as MappingEntry[])[0].model?.id).toBe("m2");
  });

  it("should update widget config", () => {
    const raw: Record<string, unknown> = { widget: { enabled: true } };
    updateWidgetConfig(raw, { enabled: false, showCount: 5 });
    expect((raw.widget as Record<string, unknown>).enabled).toBe(false);
    expect((raw.widget as Record<string, unknown>).showCount).toBe(5);
  });

  it("should remove mappings correctly", () => {
    const raw: Record<string, unknown> = { mappings: [] };
    const mapping: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    };

    upsertMapping(raw, mapping);
    expect(raw.mappings).toHaveLength(1);

    const removed = removeMapping(raw, {
      usage: { provider: "p1", window: "w1" },
    } as MappingEntry);
    expect(removed.removed).toBe(true);
    expect(raw.mappings).toHaveLength(0);
  });

  it("should remove only ignore mappings when onlyIgnore is true", () => {
    const raw: Record<string, unknown> = { mappings: [] };
    const ignoreMapping: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      ignore: true,
    };
    const modelMapping: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    };

    // Insert both entries into the raw mappings
    raw.mappings = [ignoreMapping, modelMapping];
    // Sanity check
    expect(raw.mappings as MappingEntry[]).toHaveLength(2);

    const res = removeMapping(
      raw,
      { usage: { provider: "p1", window: "w1" } } as MappingEntry,
      { onlyIgnore: true },
    );
    expect(res.removed).toBe(true);
    // Only the ignore mapping should have been removed, leaving the model mapping
    const remaining = raw.mappings as MappingEntry[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].model).toBeDefined();
    expect(remaining[0].ignore).not.toBe(true);
  });
});
