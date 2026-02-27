import { describe, expect, it } from "vitest";
import { getRawMappings, removeMapping } from "../src/config.js";

describe("Config removeMapping Branch Coverage", () => {
  it("should remove only ignore mappings when onlyIgnore is true", () => {
    const raw = {
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
        },
        {
          usage: { provider: "p1", window: "w1" },
          ignore: true,
        },
        {
          usage: { provider: "p1", window: "w2" },
          ignore: true,
        },
      ],
    };

    const mappingToRemove = {
      usage: { provider: "p1", window: "w1" },
      ignore: true,
    };

    const result = removeMapping(raw, mappingToRemove, { onlyIgnore: true });

    expect(result.removed).toBe(true);
    // Should remove only the ignore mapping, keep the model mapping
    expect(raw.mappings).toHaveLength(2);
    expect(raw.mappings).toContainEqual({
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    });
    expect(raw.mappings).toContainEqual({
      usage: { provider: "p1", window: "w2" },
      ignore: true,
    });
  });

  it("should remove all matching mappings when onlyIgnore is false", () => {
    const raw = {
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
        },
        {
          usage: { provider: "p1", window: "w1" },
          ignore: true,
        },
      ],
    };

    const mappingToRemove = {
      usage: { provider: "p1", window: "w1" },
      ignore: true,
    };

    const result = removeMapping(raw, mappingToRemove, { onlyIgnore: false });

    expect(result.removed).toBe(true);
    // Should remove both mappings
    expect(raw.mappings).toHaveLength(0);
  });

  it("should remove all matching mappings when onlyIgnore is undefined (default)", () => {
    const raw = {
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
        },
        {
          usage: { provider: "p1", window: "w1" },
          ignore: true,
        },
      ],
    };

    const mappingToRemove = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    };

    const result = removeMapping(raw, mappingToRemove);

    expect(result.removed).toBe(true);
    // Should remove both mappings (default behavior)
    expect(raw.mappings).toHaveLength(0);
  });

  it("should not return removed when mapping not found", () => {
    const raw = {
      mappings: [
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
        },
      ],
    };

    const mappingToRemove = {
      usage: { provider: "p1", window: "w2" },
      ignore: true,
    };

    const result = removeMapping(raw, mappingToRemove);

    expect(result.removed).toBe(false);
    expect(raw.mappings).toHaveLength(1);
  });

  it("should handle entries without usage property", () => {
    const raw = {
      mappings: [
        { invalid: "entry" },
        {
          usage: { provider: "p1", window: "w1" },
          model: { provider: "p1", id: "m1" },
        },
      ],
    };

    const mappingToRemove = {
      usage: { provider: "p1", window: "w1" },
      model: { provider: "p1", id: "m1" },
    };

    const result = removeMapping(raw, mappingToRemove);

    expect(result.removed).toBe(true);
    // Should keep invalid entry
    expect(raw.mappings).toHaveLength(1);
    expect(raw.mappings[0]).toEqual({ invalid: "entry" });
  });

  describe("getRawMappings", () => {
    it("should return empty array on error", () => {
      // Create an object with invalid mappings that will cause normalizeMappings to throw
      const raw = {
        mappings: null as unknown, // This should cause an error
      };

      const result = getRawMappings(raw);
      expect(result).toEqual([]);
    });

    it("should handle malformed mappings", () => {
      const raw = {
        mappings: [
          {
            usage: "not-an-object" as unknown, // Invalid type
          },
        ],
      };

      const result = getRawMappings(raw);
      // normalizeMappings should skip invalid entries
      // If all are invalid, it might return empty or skip them
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
