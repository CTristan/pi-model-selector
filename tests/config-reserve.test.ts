import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, upsertMapping } from "../src/config.js";
import type { MappingEntry } from "../src/types.js";

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

describe("Config Reserve Validation", () => {
  beforeEach(() => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockReset();
    vi.mocked(mockCtx.ui.notify).mockReset();
  });

  it("should accept valid reserve values", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
            reserve: 0,
          },
          {
            usage: { provider: "p2", window: "w2" },
            model: { provider: "p2", id: "m2" },
            reserve: 20,
          },
          {
            usage: { provider: "p3", window: "w3" },
            model: { provider: "p3", id: "m3" },
            reserve: 99,
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).not.toBeNull();
    expect(config?.mappings).toHaveLength(3);
    expect(config?.mappings[0]?.reserve).toBe(0);
    expect(config?.mappings[1]?.reserve).toBe(20);
    expect(config?.mappings[2]?.reserve).toBe(99);
  });

  it("should reject negative reserve values", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
            reserve: -1,
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
  });

  it("should reject reserve values >= 100", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
            reserve: 100,
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
  });

  it("should reject non-number reserve values", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
            reserve: "20",
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
  });

  it("should reject reserve on ignore mappings", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            ignore: true,
            reserve: 20,
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
  });

  it("should reject reserve on combine mappings", async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce("{}"); // Global
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            combine: "group1",
            reserve: 20,
          },
        ],
      }),
    ); // Project

    const config = await loadConfig(mockCtx);
    expect(config).toBeNull();
  });

  it("should preserve reserve through config round-trip", () => {
    const raw: Record<string, unknown> = { mappings: [] };
    const mapping: MappingEntry = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
      reserve: 25,
    };

    upsertMapping(raw, mapping);
    expect((raw.mappings as MappingEntry[])[0]!.reserve).toBe(25);
  });
});
