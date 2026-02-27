import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCatchAllIgnoreMapping,
  isProviderIgnored,
  priorityOptions,
} from "../src/ui-helpers.js";

describe("UI Helpers", () => {
  describe("isCatchAllIgnoreMapping", () => {
    it("returns true when both window and windowPattern are absent", () => {
      const usage = { window: null, windowPattern: null };
      expect(isCatchAllIgnoreMapping(usage)).toBe(true);
    });

    it("returns true when both window and windowPattern are undefined", () => {
      const usage = { window: undefined, windowPattern: undefined };
      expect(isCatchAllIgnoreMapping(usage)).toBe(true);
    });

    it("returns true when window is empty string and windowPattern is undefined", () => {
      const usage = { window: "", windowPattern: undefined };
      expect(isCatchAllIgnoreMapping(usage)).toBe(true);
    });

    it("returns false when window is specified and windowPattern is undefined", () => {
      const usage = { window: "Sonnet", windowPattern: undefined };
      expect(isCatchAllIgnoreMapping(usage)).toBe(false);
    });

    it("returns true when windowPattern is a catch-all pattern", () => {
      const patterns = ["*", ".*", "^.*$", "^.*", ".*$", ".+", "^.+$"];
      for (const pattern of patterns) {
        expect(
          isCatchAllIgnoreMapping({
            window: undefined,
            windowPattern: pattern,
          }),
        ).toBe(true);
      }
    });

    it("returns false when windowPattern is a specific pattern", () => {
      const usage = { window: undefined, windowPattern: "^Sonnet$" };
      expect(isCatchAllIgnoreMapping(usage)).toBe(false);
    });

    it("returns false when window is specified and windowPattern is not catch-all", () => {
      const usage = { window: "Sonnet", windowPattern: "^Test$" };
      expect(isCatchAllIgnoreMapping(usage)).toBe(false);
    });

    it("returns true when windowPattern matches a catch-all and window is empty", () => {
      const usage = { window: "", windowPattern: ".*" };
      expect(isCatchAllIgnoreMapping(usage)).toBe(true);
    });
  });

  describe("isProviderIgnored", () => {
    const mappings = [
      {
        usage: {
          provider: "anthropic",
          account: undefined,
          windowPattern: undefined,
        },
        ignore: true,
      },
      {
        usage: {
          provider: "gemini",
          account: "account1",
          windowPattern: ".*",
        },
        ignore: true,
      },
      {
        usage: {
          provider: "copilot",
          account: "account2",
          window: "Chat",
          windowPattern: undefined,
        },
        ignore: false,
      },
      {
        usage: { provider: "kiro", windowPattern: "*" },
        ignore: true,
      },
    ];

    it("returns true when provider is ignored with no window or pattern specified", () => {
      expect(isProviderIgnored("anthropic", undefined, mappings)).toBe(true);
    });

    it("returns true when provider is ignored with catch-all pattern and account match", () => {
      expect(isProviderIgnored("gemini", "account1", mappings)).toBe(true);
    });

    it("returns false when provider is ignored but account does not match", () => {
      expect(isProviderIgnored("gemini", "account2", mappings)).toBe(false);
    });

    it("returns false when provider mapping is not ignored", () => {
      expect(isProviderIgnored("copilot", "account2", mappings)).toBe(false);
    });

    it("returns true for catch-all pattern with no window specified", () => {
      expect(isProviderIgnored("kiro", undefined, mappings)).toBe(true);
    });

    it("returns false when provider is not in mappings", () => {
      expect(isProviderIgnored("codex", undefined, mappings)).toBe(false);
    });

    it("returns true when ignore is true and account is undefined in mapping", () => {
      const mappings2 = [
        {
          usage: {
            provider: "test",
            window: undefined,
            windowPattern: undefined,
          },
          ignore: true,
        },
      ];
      expect(isProviderIgnored("test", undefined, mappings2)).toBe(true);
    });

    it("returns true when ignore is true and account is specified in call but not in mapping", () => {
      const mappings2 = [
        {
          usage: { provider: "test", account: undefined, window: undefined },
          ignore: true,
        },
      ];
      expect(isProviderIgnored("test", "account1", mappings2)).toBe(true);
    });

    it("returns false when mapping has window but not catch-all pattern", () => {
      const mappings2 = [
        {
          usage: { provider: "test", window: "SpecificWindow" },
          ignore: true,
        },
      ];
      expect(isProviderIgnored("test", undefined, mappings2)).toBe(false);
    });
  });

  describe("priorityOptions", () => {
    it("contains all six valid priority combinations", () => {
      expect(priorityOptions).toHaveLength(6);
    });

    it("each option has label and value properties", () => {
      for (const option of priorityOptions) {
        expect(option).toHaveProperty("label");
        expect(option).toHaveProperty("value");
        expect(Array.isArray(option.value)).toBe(true);
      }
    });

    it("each priority array contains at least one tie-breaker", () => {
      const tieBreakers = ["remainingPercent", "earliestReset"];
      for (const option of priorityOptions) {
        const hasTieBreaker = option.value.some((rule) =>
          tieBreakers.includes(rule),
        );
        expect(hasTieBreaker).toBe(true);
      }
    });

    it("each priority array contains fullAvailability", () => {
      for (const option of priorityOptions) {
        expect(option.value).toContain("fullAvailability");
      }
    });
  });

  describe("selectWrapped", () => {
    let mockCtx: ExtensionContext;

    beforeEach(() => {
      mockCtx = {
        hasUI: false,
        ui: {
          select: vi.fn(),
          custom: vi.fn(),
        },
      } as unknown as ExtensionContext;
    });

    it("returns first option when hasUI is false", async () => {
      const { selectWrapped } = await import("../src/ui-helpers.js");
      const result = await selectWrapped(mockCtx, "Test", [
        "option1",
        "option2",
      ]);
      expect(result).toBe("option1");
    });

    it("uses ui.select in vitest environment", async () => {
      mockCtx.hasUI = true;
      mockCtx.ui.select = vi.fn().mockResolvedValue("option2");

      const previousVitest = process.env.VITEST;
      process.env.VITEST = "true";

      try {
        const { selectWrapped } = await import("../src/ui-helpers.js");
        const result = await selectWrapped(mockCtx, "Test", [
          "option1",
          "option2",
        ]);

        expect(mockCtx.ui.select).toHaveBeenCalledWith("Test", [
          "option1",
          "option2",
        ]);
        expect(result).toBe("option2");
      } finally {
        if (previousVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = previousVitest;
        }
      }
    });

    it("uses ui.select when ui.custom is not available", async () => {
      mockCtx.hasUI = true;
      mockCtx.ui.select = vi.fn().mockResolvedValue("option1");
      (mockCtx.ui as any).custom = undefined;

      const { selectWrapped } = await import("../src/ui-helpers.js");
      const result = await selectWrapped(mockCtx, "Test", [
        "option1",
        "option2",
      ]);

      expect(mockCtx.ui.select).toHaveBeenCalledWith("Test", [
        "option1",
        "option2",
      ]);
      expect(result).toBe("option1");
    });
  });
});
