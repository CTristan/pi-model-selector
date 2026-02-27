import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupConfigRaw, loadConfig } from "../src/config.js";

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

describe("Fallback Configuration", () => {
  beforeEach(() => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockReset();
    vi.mocked(mockCtx.ui.notify).mockReset();
  });

  describe("Config Parsing", () => {
    it("should load fallback from global config", async () => {
      const globalConfig = JSON.stringify({
        fallback: {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          lock: true,
        },
        mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
      });

      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Project

      const config = await loadConfig(mockCtx);

      expect(config?.fallback).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        lock: true,
      });
    });

    it("should load fallback from project config", async () => {
      const globalConfig = JSON.stringify({
        fallback: {
          provider: "anthropic",
          id: "claude-3-5-sonnet-latest",
          lock: true,
        },
        mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
      });

      const projectConfig = JSON.stringify({
        fallback: {
          provider: "openai",
          id: "gpt-4o",
          lock: false,
        },
      });

      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(projectConfig); // Project

      const config = await loadConfig(mockCtx);

      expect(config?.fallback).toEqual({
        provider: "openai",
        id: "gpt-4o",
        lock: false,
      });
    });

    it("should default fallback.lock to true when omitted", async () => {
      const globalConfig = JSON.stringify({
        fallback: {
          provider: "openai",
          id: "gpt-4o",
        },
        mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
      });

      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Project

      const config = await loadConfig(mockCtx);

      expect(config?.fallback).toEqual({
        provider: "openai",
        id: "gpt-4o",
        lock: true,
      });
    });

    it("should have no fallback when not configured", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Project

      const config = await loadConfig(mockCtx);

      expect(config?.fallback).toBeUndefined();
    });
  });

  describe("Config Validation", () => {
    it("should reject fallback with missing provider", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify({
          fallback: { id: "claude-sonnet-4-5" },
          mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
        }),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}");

      const config = await loadConfig(mockCtx);
      expect(config).toBeNull();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("fallback.provider must be a non-empty string"),
        "error",
      );
    });

    it("should reject fallback with missing id", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify({
          fallback: { provider: "anthropic" },
          mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
        }),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}");

      const config = await loadConfig(mockCtx);
      expect(config).toBeNull();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("fallback.id must be a non-empty string"),
        "error",
      );
    });

    it("should reject fallback with empty provider string", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify({
          fallback: { provider: "", id: "claude-sonnet-4-5" },
          mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
        }),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}");

      const config = await loadConfig(mockCtx);
      expect(config).toBeNull();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("fallback.provider must be a non-empty string"),
        "error",
      );
    });

    it("should reject fallback with empty id string", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify({
          fallback: { provider: "anthropic", id: "" },
          mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
        }),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}");

      const config = await loadConfig(mockCtx);
      expect(config).toBeNull();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("fallback.id must be a non-empty string"),
        "error",
      );
    });

    it("should reject fallback with non-boolean lock value", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify({
          fallback: {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            lock: "true",
          },
          mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
        }),
      );
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}");

      const config = await loadConfig(mockCtx);
      expect(config).toBeNull();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("fallback.lock must be a boolean"),
        "error",
      );
    });
  });

  describe("Config Cleanup", () => {
    it("should remove fallback when model is unavailable", () => {
      const raw: Record<string, unknown> = {
        fallback: { provider: "unavailable", id: "model" },
        mappings: [],
      };

      const modelExists = vi.fn();
      modelExists.mockImplementation((provider: string, id: string) => {
        return provider === "available" && id === "model";
      });

      const result = cleanupConfigRaw(raw, { modelExists });

      expect(result.changed).toBe(true);
      expect(
        result.summary.some((s) =>
          s.includes('Removed fallback model "unavailable/model"'),
        ),
      ).toBe(true);
      expect(raw.fallback).toBeUndefined();
    });

    it("should keep fallback when model is available", () => {
      const raw: Record<string, unknown> = {
        fallback: { provider: "available", id: "model" },
        mappings: [],
      };

      const modelExists = vi.fn().mockReturnValue(true);

      const result = cleanupConfigRaw(raw, { modelExists });

      expect(result.changed).toBe(false);
      expect(raw.fallback).toEqual({ provider: "available", id: "model" });
    });

    it("should not attempt cleanup when modelExists is not provided", () => {
      const raw: Record<string, unknown> = {
        fallback: { provider: "any", id: "model" },
        mappings: [],
      };

      const result = cleanupConfigRaw(raw);

      expect(result.changed).toBe(false);
      expect(raw.fallback).toEqual({ provider: "any", id: "model" });
    });

    it("should handle modelExists errors gracefully", () => {
      const raw: Record<string, unknown> = {
        fallback: { provider: "error-provider", id: "model" },
        mappings: [],
      };

      const modelExists = vi.fn().mockImplementation(() => {
        throw new Error("Test error");
      });

      const result = cleanupConfigRaw(raw, { modelExists });

      expect(result.changed).toBe(false);
      expect(raw.fallback).toEqual({ provider: "error-provider", id: "model" });
      expect(
        result.summary.some((s) =>
          s.includes(
            'Could not verify availability of fallback model "error-provider/model"',
          ),
        ),
      ).toBe(true);
    });
  });

  describe("Merge Behavior", () => {
    it("should merge global and project configs with fallback", async () => {
      const globalConfig = JSON.stringify({
        priority: ["fullAvailability", "remainingPercent"], // Add remainingPercent as tiebreaker
        fallback: {
          provider: "global-provider",
          id: "global-model",
          lock: true,
        },
        mappings: [{ usage: { provider: "p1" }, ignore: true }],
      });

      const projectConfig = JSON.stringify({
        priority: ["remainingPercent", "earliestReset"], // Project priority overrides global
        fallback: {
          provider: "project-provider",
          id: "project-model",
          lock: false,
        },
        mappings: [], // Add empty mappings array
      });

      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(projectConfig); // Project

      const config = await loadConfig(mockCtx, { requireMappings: false }); // Don't require mappings for this test

      expect(config).not.toBeNull();
      expect(config?.fallback).toEqual({
        provider: "project-provider",
        id: "project-model",
        lock: false,
      });
      // Project priority takes precedence over global priority
      expect(config?.priority).toEqual(["remainingPercent", "earliestReset"]);
    });
  });

  describe("Whitespace Trimming", () => {
    it("should trim provider and id strings", async () => {
      const globalConfig = JSON.stringify({
        fallback: {
          provider: "  anthropic  ",
          id: "  claude-sonnet-4-5  ",
        },
        mappings: [{ usage: { provider: "anthropic" }, ignore: true }],
      });

      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(globalConfig); // Global
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Project

      const config = await loadConfig(mockCtx);

      expect(config?.fallback).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        lock: true,
      });
    });
  });
});
