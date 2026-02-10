import { describe, it, expect } from "vitest";
import {
  buildCandidates,
  findModelMapping,
  dedupeCandidates,
  selectionReason,
  compareCandidates,
} from "../src/candidates.js";
import { UsageSnapshot, UsageCandidate, MappingEntry } from "../src/types.js";

describe("Candidate Logic", () => {
  it("should build candidates from usage snapshots and handle NaN/errors", () => {
    const usages: UsageSnapshot[] = [
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          {
            label: "Sonnet",
            usedPercent: 40,
            resetsAt: new Date("2026-02-08T22:00:00Z"),
          },
        ],
        account: "work",
      },
      {
        provider: "p1",
        displayName: "D1",
        windows: [{ label: "w1", usedPercent: NaN }],
      },
      {
        provider: "p2",
        displayName: "D2",
        windows: [{ label: "w1", usedPercent: 10 }],
        error: "some error",
      },
    ];

    const candidates = buildCandidates(usages);
    expect(candidates).toHaveLength(1);
  });

  it("should handle clampPercent branches", () => {
    const usages: UsageSnapshot[] = [
      {
        provider: "p1",
        displayName: "D1",
        windows: [{ label: "w1", usedPercent: -10 }],
      },
      {
        provider: "p1",
        displayName: "D1",
        windows: [{ label: "w2", usedPercent: 110 }],
      },
      {
        provider: "p1",
        displayName: "D1",
        windows: [{ label: "w3", usedPercent: Infinity }],
      },
    ];
    const res = buildCandidates(usages);
    expect(res[0].usedPercent).toBe(0);
    expect(res[1].usedPercent).toBe(100);
    expect(res).toHaveLength(2);
  });

  it("should compare candidates with all rules and branches", () => {
    const now = new Date();
    const a: UsageCandidate = {
      remainingPercent: 100,
      resetsAt: undefined,
    } as UsageCandidate;
    const b: UsageCandidate = {
      remainingPercent: 50,
      resetsAt: undefined,
    } as UsageCandidate;

    // availability diff branch
    const a0: UsageCandidate = { remainingPercent: 0 } as UsageCandidate;
    const b50: UsageCandidate = { remainingPercent: 50 } as UsageCandidate;
    expect(compareCandidates(a0, b50, [], []).diff).toBeLessThan(0);

    // remainingPercent branch
    expect(
      compareCandidates(a, b, ["remainingPercent"], []).diff,
    ).toBeGreaterThan(0);

    // fullAvailability branch
    const aFull: UsageCandidate = { remainingPercent: 100 } as UsageCandidate;
    const bNotFull: UsageCandidate = { remainingPercent: 99 } as UsageCandidate;
    expect(
      compareCandidates(aFull, bNotFull, ["fullAvailability"], []).diff,
    ).toBeGreaterThan(0);

    // earliestReset branches
    const aReset: UsageCandidate = {
      remainingPercent: 50,
      resetsAt: new Date(now.getTime() + 10000),
    } as UsageCandidate;
    const bReset: UsageCandidate = {
      remainingPercent: 50,
      resetsAt: new Date(now.getTime() + 1000),
    } as UsageCandidate;
    const cNoReset: UsageCandidate = {
      remainingPercent: 50,
      resetsAt: undefined,
    } as UsageCandidate;

    expect(
      compareCandidates(aReset, bReset, ["earliestReset"], []).diff,
    ).toBeLessThan(0); // b is better
    expect(
      compareCandidates(aReset, cNoReset, ["earliestReset"], []).diff,
    ).toBeLessThan(0); // a is better than no reset
    expect(
      compareCandidates(cNoReset, aReset, ["earliestReset"], []).diff,
    ).toBeGreaterThan(0); // a is better than no reset
  });

  it("should handle selection reasons and tie rules", () => {
    const tied: UsageCandidate = { remainingPercent: 50 } as UsageCandidate;
    expect(selectionReason(tied, tied, ["remainingPercent"], [])).toBe("tied");

    const best: UsageCandidate = { remainingPercent: 100 } as UsageCandidate;
    const runnerUp: UsageCandidate = {
      remainingPercent: 50,
    } as UsageCandidate;
    expect(selectionReason(best, runnerUp, ["remainingPercent"], [])).toContain(
      "higher availability",
    );
  });

  it("should prefer mapped candidates over unmapped ones", () => {
    const mapped: UsageCandidate = {
      provider: "p1",
      windowLabel: "mapped",
      remainingPercent: 10,
    } as UsageCandidate;
    const unmapped: UsageCandidate = {
      provider: "p1",
      windowLabel: "unmapped",
      remainingPercent: 100,
    } as UsageCandidate;
    const mappings: MappingEntry[] = [
      {
        usage: { provider: "p1", window: "mapped" },
        model: { provider: "m1", id: "i1" },
      },
    ];

    const result = compareCandidates(
      mapped,
      unmapped,
      ["remainingPercent"],
      mappings,
    );
    expect(result.rule).toBe("isMapped");
    expect(result.diff).toBeGreaterThan(0);

    expect(
      selectionReason(mapped, unmapped, ["remainingPercent"], mappings),
    ).toBe("has model mapping");
  });

  it("should prefer unmapped available candidate over mapped rate-limited candidate (Priority Inversion Fix)", () => {
    const mappedRateLimited: UsageCandidate = {
      provider: "p1",
      windowLabel: "w1",
      remainingPercent: 0,
    } as UsageCandidate;

    const unmappedAvailable: UsageCandidate = {
      provider: "p2",
      windowLabel: "w2",
      remainingPercent: 100,
    } as UsageCandidate;

    const mappings: MappingEntry[] = [
      {
        usage: { provider: "p1", window: "w1" },
        model: { provider: "m1", id: "i1" },
      },
    ];

    const result = compareCandidates(
      unmappedAvailable,
      mappedRateLimited,
      ["remainingPercent"],
      mappings,
    );
    expect(result.diff).toBeGreaterThan(0);
    expect(result.rule).toBe("remainingPercent");
  });

  it("should prefer specific account mappings over generic ones", () => {
    const candidate: UsageCandidate = {
      provider: "anthropic",
      displayName: "Claude",
      windowLabel: "Sonnet",
      usedPercent: 50,
      remainingPercent: 50,
      account: "work",
    };

    const mappings: MappingEntry[] = [
      {
        usage: { provider: "anthropic", window: "Sonnet" }, // Generic
        model: { provider: "anthropic", id: "claude-3-5-sonnet-global" },
      },
      {
        usage: { provider: "anthropic", account: "work", window: "Sonnet" }, // Specific
        model: { provider: "anthropic", id: "claude-3-5-sonnet-work" },
      },
    ];

    const mapping = findModelMapping(candidate, mappings);
    expect(mapping?.model?.id).toBe("claude-3-5-sonnet-work");
  });

  it("should handle mapping logic branches and invalid regex", () => {
    const candidate = {
      provider: "p1",
      windowLabel: "w1",
    } as UsageCandidate;

    // Pattern match
    const mappings: MappingEntry[] = [
      {
        usage: { provider: "p1", windowPattern: "w.*" },
        model: { provider: "p1", id: "m1" },
      },
      {
        usage: { provider: "p1", windowPattern: "[" },
        model: { provider: "p1", id: "m1" },
      }, // invalid regex branch
    ];
    expect(findModelMapping(candidate, mappings)).toBeDefined();
  });

  describe("dedupeCandidates", () => {
    it("should keep the candidate with higher remaining percentage", () => {
      const candidates: UsageCandidate[] = [
        {
          provider: "p1",
          account: "a1",
          windowLabel: "w1",
          remainingPercent: 20,
          usedPercent: 80,
          displayName: "P1",
        },
        {
          provider: "p1",
          account: "a1",
          windowLabel: "w1",
          remainingPercent: 50,
          usedPercent: 50,
          displayName: "P1",
        },
      ];
      const deduped = dedupeCandidates(candidates);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].remainingPercent).toBe(50);
    });
  });
});
