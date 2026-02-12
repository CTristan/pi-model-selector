import type {
  MappingEntry,
  PriorityRule,
  UsageCandidate,
  UsageSnapshot,
} from "./types.js";
import { formatReset } from "./usage-fetchers.js";

// ============================================================================
// Candidate Building
// ============================================================================

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.max(0, Math.min(100, value));
}

export function buildCandidates(usages: UsageSnapshot[]): UsageCandidate[] {
  const candidates: UsageCandidate[] = [];

  for (const usage of usages) {
    if (usage.error || usage.windows.length === 0) continue;
    for (const window of usage.windows) {
      const usedPercent = clampPercent(window.usedPercent);
      if (!Number.isFinite(usedPercent)) continue;
      const remainingPercent = 100 - usedPercent;
      candidates.push({
        provider: usage.provider,
        displayName: usage.displayName,
        windowLabel: window.label,
        usedPercent,
        remainingPercent,
        resetsAt: window.resetsAt,
        account: usage.account,
      });
    }
  }

  return candidates;
}

// ============================================================================
// Candidate Comparison
// ============================================================================

export function compareCandidates(
  a: UsageCandidate,
  b: UsageCandidate,
  priority: PriorityRule[],
  mappings: MappingEntry[],
): { diff: number; rule?: PriorityRule | "isMapped" } {
  // Hard rule 1: Any availability is better than no availability
  const aHasAvail = a.remainingPercent > 0 ? 1 : 0,
    bHasAvail = b.remainingPercent > 0 ? 1 : 0;
  if (aHasAvail !== bHasAvail) {
    return { diff: aHasAvail - bHasAvail, rule: "remainingPercent" };
  }

  // Hard rule 2: Mapped candidates are better than unmapped candidates
  const aMapped = findModelMapping(a, mappings) ? 1 : 0,
    bMapped = findModelMapping(b, mappings) ? 1 : 0;
  if (aMapped !== bMapped) {
    return { diff: aMapped - bMapped, rule: "isMapped" };
  }

  for (const rule of priority) {
    if (rule === "fullAvailability") {
      const aFull = a.remainingPercent >= 100 ? 1 : 0,
        bFull = b.remainingPercent >= 100 ? 1 : 0,
        diff = aFull - bFull;
      if (diff !== 0) return { diff, rule };
      continue;
    }
    if (rule === "remainingPercent") {
      const diff = a.remainingPercent - b.remainingPercent;
      if (diff !== 0) return { diff, rule };
      continue;
    }
    if (rule === "earliestReset") {
      const aReset = a.resetsAt?.getTime(),
        bReset = b.resetsAt?.getTime();
      if (aReset === undefined && bReset === undefined) {
        continue;
      }
      if (aReset === undefined) return { diff: 1, rule };
      if (bReset === undefined) return { diff: -1, rule };
      const diff = bReset - aReset;
      if (diff !== 0) return { diff, rule };
    }
  }
  return { diff: 0 };
}

function compareByPriority(
  a: UsageCandidate,
  b: UsageCandidate,
  priority: PriorityRule[],
  mappings: MappingEntry[],
): number {
  return compareCandidates(a, b, priority, mappings).diff;
}

export function sortCandidates(
  candidates: UsageCandidate[],
  priority: PriorityRule[],
  mappings: MappingEntry[],
): UsageCandidate[] {
  return [...candidates].sort((a, b) => {
    const diff = compareByPriority(a, b, priority, mappings);
    if (diff === 0) return 0;
    return diff > 0 ? -1 : 1;
  });
}

export function selectionReason(
  best: UsageCandidate,
  runnerUp: UsageCandidate | undefined,
  priority: PriorityRule[],
  mappings: MappingEntry[],
): string {
  if (!runnerUp) return "only available bucket";
  const result = compareCandidates(best, runnerUp, priority, mappings);
  if (!result.rule || result.diff === 0) return "tied";

  if (result.rule === "isMapped") {
    return "has model mapping";
  }

  if (result.rule === "fullAvailability") {
    return `fullAvailability (vs ${runnerUp.remainingPercent.toFixed(0)}%)`;
  }
  if (result.rule === "remainingPercent") {
    return `higher availability (vs ${runnerUp.remainingPercent.toFixed(0)}%)`;
  }
  if (result.rule === "earliestReset") {
    if (best.resetsAt === undefined) {
      const runnerReset = runnerUp.resetsAt
        ? formatReset(runnerUp.resetsAt)
        : "unknown";
      return `no reset limit (vs ${runnerReset})`;
    }
    const runnerReset = runnerUp.resetsAt
      ? formatReset(runnerUp.resetsAt)
      : "unknown";
    return `earlier reset (vs ${runnerReset})`;
  }

  return "tied";
}

// ============================================================================
// Mapping Helpers
// ============================================================================

const regexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

type MappingPredicate = (mapping: MappingEntry) => boolean;

function findMappingBy(
  candidate: UsageCandidate,
  mappings: MappingEntry[],
  predicate: MappingPredicate,
): MappingEntry | undefined {
  const matches = (m: MappingEntry) =>
    predicate(m) && m.usage.provider === candidate.provider;

  // 1. Exact window matches (account first, then generic)
  if (candidate.account !== undefined) {
    const exactAccount = mappings.find(
      (m) =>
        matches(m) &&
        m.usage.account === candidate.account &&
        m.usage.window === candidate.windowLabel,
    );
    if (exactAccount) return exactAccount;
  }

  const exactGeneric = mappings.find(
    (m) =>
      matches(m) &&
      m.usage.account === undefined &&
      m.usage.window === candidate.windowLabel,
  );
  if (exactGeneric) return exactGeneric;

  // 2. Pattern matches (account first, then generic)
  const patternMatch = (m: MappingEntry) => {
    if (!m.usage.windowPattern) return false;
    try {
      return getCachedRegex(m.usage.windowPattern).test(candidate.windowLabel);
    } catch {
      return false;
    }
  };

  if (candidate.account !== undefined) {
    const patternAccount = mappings.find(
      (m) =>
        matches(m) && m.usage.account === candidate.account && patternMatch(m),
    );
    if (patternAccount) return patternAccount;
  }

  const patternGeneric = mappings.find(
    (m) => matches(m) && m.usage.account === undefined && patternMatch(m),
  );
  if (patternGeneric) return patternGeneric;

  // 3. Catch-all matches (account first, then generic)
  if (candidate.account !== undefined) {
    const catchAllAccount = mappings.find(
      (m) =>
        matches(m) &&
        m.usage.account === candidate.account &&
        !m.usage.window &&
        !m.usage.windowPattern,
    );
    if (catchAllAccount) return catchAllAccount;
  }

  const catchAllGeneric = mappings.find(
    (m) =>
      matches(m) &&
      m.usage.account === undefined &&
      !m.usage.window &&
      !m.usage.windowPattern,
  );
  if (catchAllGeneric) return catchAllGeneric;

  return undefined;
}

export function findModelMapping(
  candidate: UsageCandidate,
  mappings: MappingEntry[],
): MappingEntry | undefined {
  return findMappingBy(
    candidate,
    mappings,
    (mapping) => !mapping.ignore && Boolean(mapping.model),
  );
}

export function findIgnoreMapping(
  candidate: UsageCandidate,
  mappings: MappingEntry[],
): MappingEntry | undefined {
  return findMappingBy(
    candidate,
    mappings,
    (mapping) => mapping.ignore === true,
  );
}

export function findCombinationMapping(
  candidate: UsageCandidate,
  mappings: MappingEntry[],
): MappingEntry | undefined {
  return findMappingBy(
    candidate,
    mappings,
    (mapping) => mapping.combine !== undefined,
  );
}

export function candidateKey(candidate: UsageCandidate): string {
  return `${candidate.provider}|${candidate.account ?? ""}|${candidate.windowLabel}`;
}

export function dedupeCandidates(
  candidates: UsageCandidate[],
): UsageCandidate[] {
  const byKey = new Map<string, UsageCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate),
      existing = byKey.get(key);
    if (!existing || candidate.remainingPercent > existing.remainingPercent) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}

export function combineCandidates(
  candidates: UsageCandidate[],
  mappings: MappingEntry[],
): UsageCandidate[] {
  const groupMap = new Map<string, UsageCandidate[]>();
  const nonGrouped: UsageCandidate[] = [];

  for (const candidate of candidates) {
    const combineMapping = findMappingBy(
      candidate,
      mappings,
      (m) => m.combine !== undefined,
    );
    if (combineMapping?.combine) {
      const groupName = combineMapping.combine;
      // Use provider + account + groupName to keep combinations scoped
      const groupKey = `${candidate.provider}|${candidate.account ?? ""}|${groupName}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
      }
      groupMap.get(groupKey)?.push(candidate);
    } else {
      nonGrouped.push(candidate);
    }
  }

  const result: UsageCandidate[] = [...nonGrouped];

  for (const [groupKey, members] of groupMap.entries()) {
    if (members.length === 0) continue;

    const parts = groupKey.split("|"),
      provider = parts[0],
      account = parts[1],
      groupName = parts.slice(2).join("|");

    // Whichever one has the least remaining availability
    let bottleneck = members[0];
    for (const m of members) {
      if (m.remainingPercent < bottleneck.remainingPercent) {
        bottleneck = m;
      }
    }

    result.push({
      provider,
      displayName: bottleneck.displayName,
      windowLabel: groupName,
      usedPercent: bottleneck.usedPercent,
      remainingPercent: bottleneck.remainingPercent,
      resetsAt: bottleneck.resetsAt,
      account: account || undefined,
      isSynthetic: true,
    });
  }

  return result;
}
