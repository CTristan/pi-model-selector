import { describe, expect, it } from "vitest";
import {
  combineCandidates,
  findCombinationMapping,
} from "../src/candidates.js";
import type { MappingEntry, UsageCandidate } from "../src/types.js";

describe("Candidate Grouping", () => {
  describe("Thread #1: Unsafe split in combineCandidates", () => {
    it("should correctly handle providers, accounts, and group names containing pipes", () => {
      const candidates: UsageCandidate[] = [
        {
          provider: "provider|with|pipes",
          account: "account|with|pipes",
          windowLabel: "window|1",
          usedPercent: 10,
          remainingPercent: 90,
          displayName: "Display Name",
        },
        {
          provider: "provider|with|pipes",
          account: "account|with|pipes",
          windowLabel: "window|2",
          usedPercent: 20,
          remainingPercent: 80,
          displayName: "Display Name",
        },
      ];

      const groupName = "Group|Name|With|Pipes";
      const mappings: MappingEntry[] = [
        {
          usage: {
            provider: "provider|with|pipes",
            account: "account|with|pipes",
            windowPattern: "window.*",
          },
          combine: groupName,
        },
      ];

      const result = combineCandidates(candidates, mappings);

      // Should have 1 synthetic candidate
      expect(result).toHaveLength(1);
      const synthetic = result[0]!;

      expect(synthetic.isSynthetic).toBe(true);
      expect(synthetic.provider).toBe("provider|with|pipes");
      expect(synthetic.account).toBe("account|with|pipes");
      expect(synthetic.windowLabel).toBe(groupName);
      // Bottleneck logic: min remaining percent
      expect(synthetic.remainingPercent).toBe(80);
    });
  });

  describe("Thread #2: Recursive combination prevention", () => {
    it("should not return a combination mapping for a synthetic candidate", () => {
      const syntheticCandidate: UsageCandidate = {
        provider: "p",
        windowLabel: "Group A",
        usedPercent: 50,
        remainingPercent: 50,
        displayName: "P",
        isSynthetic: true,
      };

      const mappings: MappingEntry[] = [
        {
          usage: {
            provider: "p",
            windowPattern: ".*", // Catch-all that would match "Group A"
          },
          combine: "Super Group",
        },
      ];

      const mapping = findCombinationMapping(syntheticCandidate, mappings);
      expect(mapping).toBeUndefined();
    });

    it("should return a combination mapping for a normal candidate", () => {
      const normalCandidate: UsageCandidate = {
        provider: "p",
        windowLabel: "Window 1",
        usedPercent: 50,
        remainingPercent: 50,
        displayName: "P",
        isSynthetic: false,
      };

      const mappings: MappingEntry[] = [
        {
          usage: {
            provider: "p",
            windowPattern: ".*",
          },
          combine: "Super Group",
        },
      ];

      const mapping = findCombinationMapping(normalCandidate, mappings);
      expect(mapping).toBeDefined();
      expect(mapping?.combine).toBe("Super Group");
    });
  });
});
