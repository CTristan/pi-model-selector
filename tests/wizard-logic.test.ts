import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  combineCandidates,
  dedupeCandidates,
  findCombinationMapping,
} from "../src/candidates.js";
import type {
  MappingEntry,
  UsageCandidate,
  UsageSnapshot,
} from "../src/types.js";

describe("Wizard Logic", () => {
  it("should show both raw and combined candidates when merged and deduped", () => {
    const usages: UsageSnapshot[] = [
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "Sonnet", usedPercent: 20 },
          { label: "Haiku", usedPercent: 10 },
        ],
      },
    ];

    const mappings: MappingEntry[] = [
      {
        usage: { provider: "anthropic", window: "Sonnet" },
        combine: "MyGroup",
      },
      {
        usage: { provider: "anthropic", window: "Haiku" },
        combine: "MyGroup",
      },
    ];

    const rawCandidates = buildCandidates(usages);
    const combinedCandidates = combineCandidates(rawCandidates, mappings);

    expect(combinedCandidates.length).toBe(1);
    expect(combinedCandidates[0]!.windowLabel).toBe("MyGroup");
    expect(combinedCandidates[0]!.isSynthetic).toBe(true);

    const merged = dedupeCandidates([...rawCandidates, ...combinedCandidates]);

    // Should have 3 candidates: Sonnet, Haiku, and MyGroup
    expect(merged.length).toBe(3);

    const sonnet = merged.find(
      (c: UsageCandidate) => c.windowLabel === "Sonnet",
    )!;
    const haiku = merged.find(
      (c: UsageCandidate) => c.windowLabel === "Haiku",
    )!;
    const myGroup = merged.find(
      (c: UsageCandidate) => c.windowLabel === "MyGroup",
    )!;

    expect(sonnet).toBeDefined();
    expect(haiku).toBeDefined();
    expect(myGroup).toBeDefined();
    expect(myGroup.isSynthetic).toBe(true);
    expect(sonnet.isSynthetic).toBeUndefined();

    // Verify findCombinationMapping works for the raw candidates
    expect(findCombinationMapping(sonnet, mappings)).toBeDefined();
    expect(findCombinationMapping(sonnet, mappings)?.combine).toBe("MyGroup");
    expect(findCombinationMapping(haiku, mappings)).toBeDefined();
    expect(findCombinationMapping(myGroup, mappings)).toBeUndefined(); // Synthetic itself doesn't have a combination mapping
  });
});
