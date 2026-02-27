import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cooldownMod from "../src/cooldown.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn(),
      readFile: vi.fn(),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue("/mock/home"),
    platform: actual.platform,
  };
});

describe("Cooldown State Loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads cooldown state with invalid shapes safely", async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({ cooldowns: "nope", lastSelected: 123 }),
    );

    const state = await cooldownMod.loadCooldownState();

    expect(state).toEqual({ cooldowns: {}, lastSelected: null });
  });

  it("migrates legacy cooldown keys and skips expired entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const now = Date.now();

    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        cooldowns: {
          "p1|acc|w1": now + 10000,
          "p1|acc|w1|raw": now + 20000,
          "p1|acc|*": now + 30000,
          "expired|acc|w2": now - 1000,
        },
        lastSelected: "p1|acc|w1",
      }),
    );

    const manager = new cooldownMod.CooldownManager();
    await manager.loadPersistedCooldowns();
    await manager.loadPersistedCooldowns();

    const cooldowns = (
      manager as unknown as { modelCooldowns: Map<string, number> }
    ).modelCooldowns;

    expect(cooldowns.has("p1|acc|w1|raw")).toBe(true);
    expect(cooldowns.has("p1|acc|*")).toBe(true);
    expect(cooldowns.has("expired|acc|w2")).toBe(false);
    expect(manager.getLastSelectedKey()).toBe("p1|acc|w1|raw");
    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
  });
});
