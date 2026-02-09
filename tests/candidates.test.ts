import { describe, it, expect } from 'vitest';
import { buildCandidates, sortCandidates, findModelMapping, dedupeCandidates, selectionReason, pickBestCandidate, findIgnoreMapping, compareCandidates } from '../src/candidates.js';
import { UsageSnapshot, UsageCandidate, MappingEntry } from '../src/types.js';

describe('Candidate Logic', () => {
    it('should build candidates from usage snapshots and handle NaN/errors', () => {
        const usages: UsageSnapshot[] = [
            {
                provider: 'anthropic',
                displayName: 'Claude',
                windows: [
                    { label: 'Sonnet', usedPercent: 40, resetsAt: new Date('2026-02-08T22:00:00Z') }
                ],
                account: 'work'
            },
            { provider: 'p1', displayName: 'D1', windows: [{ label: 'w1', usedPercent: NaN }] },
            { provider: 'p2', displayName: 'D2', windows: [{ label: 'w1', usedPercent: 10 }], error: 'some error' }
        ];

        const candidates = buildCandidates(usages);
        expect(candidates).toHaveLength(1);
    });

    it('should handle clampPercent branches', () => {
        const usages: UsageSnapshot[] = [
            { provider: 'p1', displayName: 'D1', windows: [{ label: 'w1', usedPercent: -10 }] }, 
            { provider: 'p1', displayName: 'D1', windows: [{ label: 'w2', usedPercent: 110 }] },
            { provider: 'p1', displayName: 'D1', windows: [{ label: 'w3', usedPercent: Infinity }] }
        ];
        const res = buildCandidates(usages);
        expect(res[0].usedPercent).toBe(0);
        expect(res[1].usedPercent).toBe(100);
        expect(res).toHaveLength(2);
    });

    it('should compare candidates with all rules and branches', () => {
        const now = new Date();
        const a: any = { remainingPercent: 100, resetsAt: undefined };
        const b: any = { remainingPercent: 50, resetsAt: undefined };
        
        // availability diff branch
        const a0: any = { remainingPercent: 0 };
        const b50: any = { remainingPercent: 50 };
        expect(compareCandidates(a0, b50, []).diff).toBeLessThan(0);

        // remainingPercent branch
        expect(compareCandidates(a, b, ['remainingPercent']).diff).toBeGreaterThan(0);
        
        // fullAvailability branch
        const aFull: any = { remainingPercent: 100 };
        const bNotFull: any = { remainingPercent: 99 };
        expect(compareCandidates(aFull, bNotFull, ['fullAvailability']).diff).toBeGreaterThan(0);
        
        // earliestReset branches
        const aReset: any = { remainingPercent: 50, resetsAt: new Date(now.getTime() + 10000) };
        const bReset: any = { remainingPercent: 50, resetsAt: new Date(now.getTime() + 1000) };
        const cNoReset: any = { remainingPercent: 50, resetsAt: undefined };
        
        expect(compareCandidates(aReset, bReset, ['earliestReset']).diff).toBeLessThan(0); // b is better
        expect(compareCandidates(aReset, cNoReset, ['earliestReset']).diff).toBeLessThan(0); // a is better than no reset
        expect(compareCandidates(cNoReset, aReset, ['earliestReset']).diff).toBeGreaterThan(0); // a is better than no reset
    });

    it('should handle selection reasons and tie rules', () => {
        const tied: any = { remainingPercent: 50 };
        expect(selectionReason(tied, tied, ['remainingPercent'])).toBe('tied');
        
        const best: any = { remainingPercent: 100 };
        const runnerUp: any = { remainingPercent: 50 };
        expect(selectionReason(best, runnerUp, ['remainingPercent'])).toContain('higher availability');
    });

    it('should prefer specific account mappings over generic ones', () => {
        const candidate: UsageCandidate = {
            provider: "anthropic",
            displayName: "Claude",
            windowLabel: "Sonnet",
            usedPercent: 50,
            remainingPercent: 50,
            account: "work"
        };

        const mappings: MappingEntry[] = [
            {
                usage: { provider: "anthropic", window: "Sonnet" }, // Generic
                model: { provider: "anthropic", id: "claude-3-5-sonnet-global" }
            },
            {
                usage: { provider: "anthropic", account: "work", window: "Sonnet" }, // Specific
                model: { provider: "anthropic", id: "claude-3-5-sonnet-work" }
            }
        ];

        const mapping = findModelMapping(candidate, mappings);
        expect(mapping?.model?.id).toBe("claude-3-5-sonnet-work");
    });

    it('should handle mapping logic branches and invalid regex', () => {
        const candidate: any = { provider: 'p1', windowLabel: 'w1' };
        
        // Pattern match
        const mappings: any = [
            { usage: { provider: 'p1', windowPattern: 'w.*' }, model: { id: 'm1' } },
            { usage: { provider: 'p1', windowPattern: '[' } } // invalid regex branch
        ];
        expect(findModelMapping(candidate, mappings)).toBeDefined();
    });

    it('should handle pickBestCandidate', () => {
        expect(pickBestCandidate([], [])).toBeNull();
        const c: any = { provider: 'p1', remainingPercent: 100 };
        expect(pickBestCandidate([c], [])).toBe(c);
    });

    describe('dedupeCandidates', () => {
        it('should keep the candidate with higher remaining percentage', () => {
            const candidates: UsageCandidate[] = [
                { provider: 'p1', account: 'a1', windowLabel: 'w1', remainingPercent: 20, usedPercent: 80, displayName: 'P1' },
                { provider: 'p1', account: 'a1', windowLabel: 'w1', remainingPercent: 50, usedPercent: 50, displayName: 'P1' }
            ];
            const deduped = dedupeCandidates(candidates);
            expect(deduped).toHaveLength(1);
            expect(deduped[0].remainingPercent).toBe(50);
        });
    });
});
