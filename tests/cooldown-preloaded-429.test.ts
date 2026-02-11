import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCooldownState, saveCooldownState } from "../index.js";

// Import the cooldown state helpers and mock persistence to control
// filesystem interactions during testing

// In-memory storage for test file operations
const mockFileSystem = new Map<string, string>();

// Mock node:os to provide a consistent homedir for testing
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue("/mock/home"),
  };
});

// Mock node:fs to handle file operations in memory (index.ts uses fs.promises)
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      access: vi.fn(async (filePath: string) => {
        if (!mockFileSystem.has(filePath)) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      }),

      readFile: vi.fn(async (filePath: string) => {
        const content = mockFileSystem.get(filePath);
        if (content === undefined) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return content;
      }),

      writeFile: vi.fn(async (filePath: string, data: string) => {
        mockFileSystem.set(filePath, data);
      }),

      unlink: vi.fn(async (filePath: string) => {
        if (!mockFileSystem.has(filePath)) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        mockFileSystem.delete(filePath);
      }),
      mkdir: vi.fn((_filePath: string, _options?: unknown) => {
        // No-op for test - directory creation not needed for in-memory store
      }),

      rename: vi.fn(async (oldPath: string, newPath: string) => {
        const content = mockFileSystem.get(oldPath);
        if (content === undefined) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        mockFileSystem.set(newPath, content);
        mockFileSystem.delete(oldPath);
      }),
    },
  };
});

// Mock node:path to use actual implementation
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return actual;
});

describe("429 Cooldown with Preloaded Usages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // Clear in-memory filesystem
    mockFileSystem.clear();
  });

  it("should save and load cooldown state with provider wildcard keys", async () => {
    const cooldowns = {
      "anthropic||*": 1704097200000, // 2024-01-01T01:00:00Z (1 hour from now)
    };

    await saveCooldownState({
      cooldowns,
      lastSelected: null,
    });

    const loaded = await loadCooldownState();
    expect(loaded.cooldowns).toEqual(cooldowns);
    expect(loaded.lastSelected).toBeNull();
  });

  it("should save cooldowns with both valid and expired entries", async () => {
    const now = Date.now();
    const cooldowns = {
      "anthropic||*": now + 3600000, // 1 hour from now - valid
      "gemini||*": now - 3600000, // 1 hour ago - expired
    };

    await saveCooldownState({
      cooldowns,
      lastSelected: null,
    });

    const loaded = await loadCooldownState();
    // loadCooldownState doesn't filter; that's done by pruneExpiredCooldowns
    expect(Object.keys(loaded.cooldowns)).toHaveLength(2);
    expect(loaded.cooldowns["anthropic||*"]).toBe(now + 3600000);
    expect(loaded.cooldowns["gemini||*"]).toBe(now - 3600000);
  });

  it("should save and restore last selected candidate", async () => {
    await saveCooldownState({
      cooldowns: {},
      lastSelected: "anthropic|default|Sonnet",
    });

    const loaded = await loadCooldownState();
    expect(loaded.lastSelected).toBe("anthropic|default|Sonnet");
  });

  it("should handle missing cooldown state file gracefully", async () => {
    // Ensure no state file exists in memory
    mockFileSystem.clear();

    const loaded = await loadCooldownState();
    expect(loaded.cooldowns).toEqual({});
    expect(loaded.lastSelected).toBeNull();
  });
});
