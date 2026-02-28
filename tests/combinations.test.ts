import { describe, expect, it } from "vitest";
import { combineCandidates } from "../src/candidates.js";
import type { MappingEntry, UsageCandidate } from "../src/types.js";

describe("Candidate Combinations", () => {
  it("should combine candidates according to mappings", () => {
    const candidates: UsageCandidate[] = [
      {
        provider: "codex",
        displayName: "Codex",
        windowLabel: "5h",
        usedPercent: 20,
        remainingPercent: 80,
      },
      {
        provider: "codex",
        displayName: "Codex",
        windowLabel: "1w",
        usedPercent: 40,
        remainingPercent: 60,
      },
      {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 30,
        remainingPercent: 70,
      },
    ] as UsageCandidate[];

    const mappings: MappingEntry[] = [
      {
        usage: { provider: "codex", window: "5h" },
        combine: "Codex Aggregated",
      },
      {
        usage: { provider: "codex", window: "1w" },
        combine: "Codex Aggregated",
      },
    ];

    const result = combineCandidates(candidates, mappings);

    // Expecting 2 candidates: "Codex Aggregated" (from combination) and "Sonnet" (ungrouped)
    expect(result).toHaveLength(2);

    const aggregated = result.find((c) => c.windowLabel === "Codex Aggregated");
    expect(aggregated).toBeDefined();
    expect(aggregated?.remainingPercent).toBe(60); // Min of 80 and 60
    expect(aggregated?.provider).toBe("codex");

    const sonnet = result.find((c) => c.windowLabel === "Sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet?.remainingPercent).toBe(70);
  });

  it("should respect account scoping in combinations", () => {
    const candidates: UsageCandidate[] = [
      {
        provider: "codex",
        account: "acc1",
        displayName: "Codex",
        windowLabel: "5h",
        remainingPercent: 80,
      },
      {
        provider: "codex",
        account: "acc1",
        displayName: "Codex",
        windowLabel: "1w",
        remainingPercent: 60,
      },
      {
        provider: "codex",
        account: "acc2",
        displayName: "Codex",
        windowLabel: "5h",
        remainingPercent: 90,
      },
      {
        provider: "codex",
        account: "acc2",
        displayName: "Codex",
        windowLabel: "1w",
        remainingPercent: 50,
      },
    ] as UsageCandidate[];

    const mappings: MappingEntry[] = [
      {
        usage: { provider: "codex", windowPattern: ".*" },
        combine: "Aggregated",
      },
    ];

    const result = combineCandidates(candidates, mappings);

    expect(result).toHaveLength(2);

    const acc1 = result.find((c) => c.account === "acc1");
    expect(acc1?.remainingPercent).toBe(60);
    expect(acc1?.windowLabel).toBe("Aggregated");

    const acc2 = result.find((c) => c.account === "acc2");
    expect(acc2?.remainingPercent).toBe(50);
    expect(acc2?.windowLabel).toBe("Aggregated");
  });

  it("should handle resetsAt when combining", () => {
    const now = new Date();
    const future1 = new Date(now.getTime() + 10000);
    const future2 = new Date(now.getTime() + 20000);

    const candidates: UsageCandidate[] = [
      {
        provider: "p1",
        windowLabel: "w1",
        remainingPercent: 80,
        resetsAt: future1,
      },
      {
        provider: "p1",
        windowLabel: "w2",
        remainingPercent: 60,
        resetsAt: future2,
      },
    ] as UsageCandidate[];

    const mappings: MappingEntry[] = [
      { usage: { provider: "p1" }, combine: "Combined" },
    ];

    const result = combineCandidates(candidates, mappings);
    expect(result[0]!.remainingPercent).toBe(60);
    expect(result[0]!.resetsAt).toEqual(future2); // Bottleneck's reset
  });
});
