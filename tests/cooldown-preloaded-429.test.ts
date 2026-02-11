import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadCooldownState, saveCooldownState } from "../index.js";

// Import the internal functions we need to test
// These are not directly exported, so we'll test the behavior indirectly
// by mocking the cooldown state persistence

describe("429 Cooldown with Preloaded Usages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // Clean up cooldown state file if it exists
    const fs = await import("node:fs/promises");
    try {
      await fs.unlink(`${process.env.HOME}/.pi/model-selector-cooldowns.json`);
    } catch {
      // Ignore if file doesn't exist
    }
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
    // First clean up any existing file
    const fs = await import("node:fs/promises");
    try {
      await fs.unlink(`${process.env.HOME}/.pi/model-selector-cooldowns.json`);
    } catch {
      // Ignore if file doesn't exist
    }

    const loaded = await loadCooldownState();
    expect(loaded.cooldowns).toEqual({});
    expect(loaded.lastSelected).toBeNull();
  });
});
