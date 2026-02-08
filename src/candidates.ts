import type { UsageSnapshot, UsageCandidate, MappingEntry, PriorityRule } from "./types.js";
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
	priority: PriorityRule[]
): { diff: number; rule?: PriorityRule } {
	// Hard rule: any availability is better than no availability
	const aHasAvail = a.remainingPercent > 0 ? 1 : 0;
	const bHasAvail = b.remainingPercent > 0 ? 1 : 0;
	if (aHasAvail !== bHasAvail) {
		return { diff: aHasAvail - bHasAvail, rule: "remainingPercent" };
	}

	for (const rule of priority) {
		if (rule === "fullAvailability") {
			const aFull = a.remainingPercent >= 100 ? 1 : 0;
			const bFull = b.remainingPercent >= 100 ? 1 : 0;
			const diff = aFull - bFull;
			if (diff !== 0) return { diff, rule };
			continue;
		}
		if (rule === "remainingPercent") {
			const diff = a.remainingPercent - b.remainingPercent;
			if (diff !== 0) return { diff, rule };
			continue;
		}
		if (rule === "earliestReset") {
			const aReset = a.resetsAt?.getTime();
			const bReset = b.resetsAt?.getTime();
			if (aReset === undefined && bReset === undefined) {
				continue;
			}
			if (aReset === undefined) return { diff: -1, rule };
			if (bReset === undefined) return { diff: 1, rule };
			const diff = bReset - aReset;
			if (diff !== 0) return { diff, rule };
		}
	}
	return { diff: 0 };
}

function compareByPriority(a: UsageCandidate, b: UsageCandidate, priority: PriorityRule[]): number {
	return compareCandidates(a, b, priority).diff;
}

export function pickBestCandidate(candidates: UsageCandidate[], priority: PriorityRule[]): UsageCandidate | null {
	let best: UsageCandidate | null = null;
	for (const candidate of candidates) {
		if (!best) {
			best = candidate;
			continue;
		}
		const diff = compareByPriority(candidate, best, priority);
		if (diff > 0) {
			best = candidate;
		}
	}
	return best;
}

export function sortCandidates(candidates: UsageCandidate[], priority: PriorityRule[]): UsageCandidate[] {
	return [...candidates].sort((a, b) => {
		const diff = compareByPriority(a, b, priority);
		if (diff === 0) return 0;
		return diff > 0 ? -1 : 1;
	});
}

export function selectionReason(best: UsageCandidate, runnerUp: UsageCandidate | undefined, priority: PriorityRule[]): string {
	if (!runnerUp) return "only available bucket";
	const result = compareCandidates(best, runnerUp, priority);
	if (!result.rule || result.diff === 0) return "tied after applying priority";

	if (result.rule === "fullAvailability") {
		return `fullAvailability (${best.remainingPercent.toFixed(0)}% vs ${runnerUp.remainingPercent.toFixed(0)}%)`;
	}
	if (result.rule === "remainingPercent") {
		return `higher remainingPercent (${best.remainingPercent.toFixed(0)}% vs ${runnerUp.remainingPercent.toFixed(0)}%)`;
	}
	if (result.rule === "earliestReset") {
		const bestReset = best.resetsAt ? formatReset(best.resetsAt) : "unknown";
		const runnerReset = runnerUp.resetsAt ? formatReset(runnerUp.resetsAt) : "unknown";
		return `earlier reset (${bestReset} vs ${runnerReset})`;
	}

	return "tied after applying priority";
}

// ============================================================================
// Mapping Helpers
// ============================================================================

type MappingPredicate = (mapping: MappingEntry) => boolean;

function findMappingBy(
	candidate: UsageCandidate,
	mappings: MappingEntry[],
	predicate: MappingPredicate
): MappingEntry | undefined {
	const exact = mappings.find(
		(mapping) =>
			predicate(mapping) &&
			mapping.usage.provider === candidate.provider &&
			mapping.usage.window === candidate.windowLabel
	);
	if (exact) return exact;

	const pattern = mappings.find((mapping) => {
		if (!predicate(mapping)) return false;
		if (mapping.usage.provider !== candidate.provider || !mapping.usage.windowPattern) return false;
		return new RegExp(mapping.usage.windowPattern).test(candidate.windowLabel);
	});
	if (pattern) return pattern;

	return mappings.find(
		(mapping) =>
			predicate(mapping) &&
			mapping.usage.provider === candidate.provider &&
			!mapping.usage.window &&
			!mapping.usage.windowPattern
	);
}

export function findModelMapping(candidate: UsageCandidate, mappings: MappingEntry[]): MappingEntry | undefined {
	return findMappingBy(candidate, mappings, (mapping) => !mapping.ignore && !!mapping.model);
}

export function findIgnoreMapping(candidate: UsageCandidate, mappings: MappingEntry[]): MappingEntry | undefined {
	return findMappingBy(candidate, mappings, (mapping) => mapping.ignore === true);
}

export function candidateKey(candidate: UsageCandidate): string {
	return `${candidate.provider}|${candidate.windowLabel}`;
}

export function dedupeCandidates(candidates: UsageCandidate[]): UsageCandidate[] {
	const byKey = new Map<string, UsageCandidate>();
	for (const candidate of candidates) {
		const key = candidateKey(candidate);
		const existing = byKey.get(key);
		if (!existing || candidate.remainingPercent > existing.remainingPercent) {
			byKey.set(key, candidate);
		}
	}
	return Array.from(byKey.values());
}
