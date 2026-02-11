import { describe, expect, it } from "vitest";
import {
  compareCandidates,
  dedupeCandidates,
  findIgnoreMapping,
  findModelMapping,
  selectionReason,
} from "../src/candidates.js";
import type { MappingEntry, UsageCandidate } from "../src/types.js";

describe("Candidates Branch Coverage", () => {
  describe("compareCandidates", () => {
    it("should handle fullAvailability rule", () => {
      const a: UsageCandidate = {
        remainingPercent: 100,
      } as unknown as UsageCandidate;
      const b: UsageCandidate = {
        remainingPercent: 99,
      } as unknown as UsageCandidate;

      // a has full, b does not
      expect(compareCandidates(a, b, ["fullAvailability"], []).diff).toBe(1);
      expect(compareCandidates(b, a, ["fullAvailability"], []).diff).toBe(-1);
      expect(compareCandidates(a, a, ["fullAvailability"], []).diff).toBe(0);
    });

    it("should handle earliestReset rule branches", () => {
      const now = Date.now();
      const a: UsageCandidate = {
        resetsAt: new Date(now + 1000),
      } as unknown as UsageCandidate;
      const b: UsageCandidate = {
        resetsAt: new Date(now + 2000),
      } as unknown as UsageCandidate;
      const none: UsageCandidate = {
        resetsAt: undefined,
      } as unknown as UsageCandidate;

      // Both defined
      expect(
        compareCandidates(a, b, ["earliestReset"], []).diff,
      ).toBeGreaterThan(0); // a is earlier (better)

      // One undefined
      // If one has undefined reset (e.g. infinite quota), it is preferred (diff < 0 means b preferred over a?)
      // compareCandidates returns diff. sortCandidates sorts DESCENDING on diff.
      // If diff > 0, a comes first.
      // If a has reset, b has none. bReset is undefined -> returns -1.
      // So b comes first. So undefined reset is better than defined reset.
      expect(compareCandidates(a, none, ["earliestReset"], []).diff).toBe(-1);
      expect(compareCandidates(none, a, ["earliestReset"], []).diff).toBe(1);

      // Both undefined
      expect(compareCandidates(none, none, ["earliestReset"], []).diff).toBe(0);
    });
  });

  describe("selectionReason", () => {
    it("should return reasons for different rules", () => {
      const best: UsageCandidate = {
        remainingPercent: 100,
        resetsAt: new Date(),
      } as unknown as UsageCandidate;
      const runner: UsageCandidate = {
        remainingPercent: 50,
        resetsAt: new Date(Date.now() + 10000),
      } as unknown as UsageCandidate;

      // fullAvailability
      expect(selectionReason(best, runner, ["fullAvailability"], [])).toContain(
        "fullAvailability",
      );

      // earliestReset
      const bestReset: UsageCandidate = {
        remainingPercent: 50,
        resetsAt: new Date(Date.now()),
      } as unknown as UsageCandidate;
      const runnerReset: UsageCandidate = {
        remainingPercent: 50,
        resetsAt: new Date(Date.now() + 10000),
      } as unknown as UsageCandidate;
      expect(
        selectionReason(bestReset, runnerReset, ["earliestReset"], []),
      ).toContain("earlier reset");

      // remainingPercent
      const bestRem: UsageCandidate = {
        remainingPercent: 80,
      } as unknown as UsageCandidate;
      const runnerRem: UsageCandidate = {
        remainingPercent: 40,
      } as unknown as UsageCandidate;
      expect(
        selectionReason(bestRem, runnerRem, ["remainingPercent"], []),
      ).toContain("higher availability");

      // Tied
      expect(selectionReason(bestRem, bestRem, ["remainingPercent"], [])).toBe(
        "tied",
      );
    });

    it("should handle missing runner up", () => {
      const best: UsageCandidate = {
        remainingPercent: 100,
      } as unknown as UsageCandidate;
      expect(selectionReason(best, undefined, [], [])).toBe(
        "only available bucket",
      );
    });
  });

  describe("findMappingBy (Model & Ignore)", () => {
    const candidate: UsageCandidate = {
      provider: "prov",
      account: "acc",
      windowLabel: "win",
    } as unknown as UsageCandidate;

    const mappings: MappingEntry[] = [
      // Exact Account
      {
        usage: { provider: "prov", account: "acc", window: "win" },
        model: { provider: "prov", id: "exact-acc" },
      },
      // Exact Generic
      {
        usage: { provider: "prov", window: "win" },
        model: { provider: "prov", id: "exact-gen" },
      },
      // Pattern Account
      {
        usage: { provider: "prov", account: "acc", windowPattern: "^win$" },
        model: { provider: "prov", id: "pat-acc" },
      },
      // Pattern Generic
      {
        usage: { provider: "prov", windowPattern: "^win$" },
        model: { provider: "prov", id: "pat-gen" },
      },
      // Catch-all Account
      {
        usage: { provider: "prov", account: "acc" },
        model: { provider: "prov", id: "catch-acc" },
      },
      // Catch-all Generic
      {
        usage: { provider: "prov" },
        model: { provider: "prov", id: "catch-gen" },
      },
    ];

    it("should match exact account", () => {
      const m = findModelMapping(candidate, [mappings[0]]);
      expect(m?.model?.id).toBe("exact-acc");
    });

    it("should match exact generic", () => {
      const m = findModelMapping(candidate, [mappings[1]]);
      expect(m?.model?.id).toBe("exact-gen");
    });

    it("should match pattern account", () => {
      const m = findModelMapping(candidate, [mappings[2]]);
      expect(m?.model?.id).toBe("pat-acc");
    });

    it("should match pattern generic", () => {
      const m = findModelMapping(candidate, [mappings[3]]);
      expect(m?.model?.id).toBe("pat-gen");
    });

    it("should match catch-all account", () => {
      const m = findModelMapping(candidate, [mappings[4]]);
      expect(m?.model?.id).toBe("catch-acc");
    });

    it("should match catch-all generic", () => {
      const m = findModelMapping(candidate, [mappings[5]]);
      expect(m?.model?.id).toBe("catch-gen");
    });

    it("should handle ignore mapping", () => {
      const ignoreMapping = { usage: { provider: "prov" }, ignore: true };
      const m = findIgnoreMapping(candidate, [ignoreMapping]);
      expect(m).toBeDefined();
      expect(m?.ignore).toBe(true);
    });

    it("should handle invalid regex gracefully", () => {
      const invalid: MappingEntry = {
        usage: { provider: "prov", windowPattern: "[" },
        model: { provider: "prov", id: "fail" },
      };
      const m = findModelMapping(candidate, [invalid]);
      expect(m).toBeUndefined();
    });
  });

  describe("dedupeCandidates", () => {
    it("should update existing candidate if new one has better remainingPercent", () => {
      const c1: UsageCandidate = {
        provider: "p",
        account: "a",
        windowLabel: "w",
        remainingPercent: 10,
      } as unknown as UsageCandidate;
      const c2: UsageCandidate = {
        provider: "p",
        account: "a",
        windowLabel: "w",
        remainingPercent: 90,
      } as unknown as UsageCandidate;

      const res = dedupeCandidates([c1, c2]);
      expect(res).toHaveLength(1);
      expect(res[0].remainingPercent).toBe(90);
    });

    it("should NOT update existing candidate if new one has worse remainingPercent", () => {
      const c1: UsageCandidate = {
        provider: "p",
        account: "a",
        windowLabel: "w",
        remainingPercent: 90,
      } as unknown as UsageCandidate;
      const c2: UsageCandidate = {
        provider: "p",
        account: "a",
        windowLabel: "w",
        remainingPercent: 10,
      } as unknown as UsageCandidate;

      const res = dedupeCandidates([c1, c2]);
      expect(res).toHaveLength(1);
      expect(res[0].remainingPercent).toBe(90);
    });
  });
});
