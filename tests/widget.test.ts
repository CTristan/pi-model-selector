import { describe, it, expect, vi } from 'vitest';
import { renderUsageWidget, clearWidget, updateWidgetState } from '../src/widget.js';

describe('Widget', () => {
    const theme: any = {
        fg: (c: string, t: string) => `[${c}]${t}[/${c}]`
    };

    it('should handle clearing widget when disabled or empty', async () => {
        const mockCtx: any = { hasUI: true, ui: { setWidget: vi.fn() } };
        
        // Disabled
        updateWidgetState({ candidates: [], config: { widget: { enabled: false } } as any });
        renderUsageWidget(mockCtx);
        expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("model-selector", undefined);

        // Empty candidates
        updateWidgetState({ candidates: [], config: { widget: { enabled: true, showCount: 5 } } as any });
        renderUsageWidget(mockCtx);
        expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("model-selector", undefined);
    });

    it('should clear widget explicitly', async () => {
        const mockCtx: any = { hasUI: true, ui: { setWidget: vi.fn() } };
        clearWidget(mockCtx);
        expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("model-selector", undefined);
    });

    it('should handle no UI or no setWidget branch', () => {
        const mockCtxNoUI: any = { hasUI: false };
        expect(() => renderUsageWidget(mockCtxNoUI)).not.toThrow();
        
        const mockCtxNoSet: any = { hasUI: true, ui: {} };
        expect(() => renderUsageWidget(mockCtxNoSet)).not.toThrow();
    });

    describe('renderUsageWidget helpers', () => {
        it('should consolidate redundant candidates and buckets', () => {
            const mockCtx: any = { hasUI: true, ui: { setWidget: vi.fn() } };
            const config: any = { 
                mappings: [{ usage: { provider: 'p1' }, model: { provider: 'mp', id: 'mi' } }], 
                widget: { enabled: true, showCount: 5, placement: 'belowEditor' } 
            };
            const candidates: any = [
                { provider: 'p1', displayName: 'D1', windowLabel: 'W1', usedPercent: 0, remainingPercent: 100 },
                { provider: 'p1', displayName: 'D1', windowLabel: 'W2', usedPercent: 0, remainingPercent: 100 }
            ];
            updateWidgetState({ candidates, config });
            renderUsageWidget(mockCtx);
            const renderFn = mockCtx.ui.setWidget.mock.calls[0][1];
            const widget = renderFn(null, theme);
            const output = widget.render(200);
            expect(output[1]).not.toContain('│');
        });

        it('should handle different remaining percentage colors and icons', () => {
            const mockCtx: any = { hasUI: true, ui: { setWidget: vi.fn() } };
            const config: any = { 
                mappings: [{ usage: { provider: 'ignored' }, ignore: true }], 
                widget: { enabled: true, showCount: 5, placement: 'belowEditor' } 
            };
            const candidates: any = [
                { provider: 'p1', displayName: 'D1', windowLabel: 'W1', usedPercent: 90, remainingPercent: 10 }, 
                { provider: 'p2', displayName: 'D2', windowLabel: 'W2', usedPercent: 60, remainingPercent: 40 }, 
                { provider: 'p3', displayName: 'D3', windowLabel: 'W3', usedPercent: 10, remainingPercent: 90 },
                { provider: 'ignored', displayName: 'I', windowLabel: 'W', usedPercent: 0, remainingPercent: 100 }
            ];
            updateWidgetState({ candidates, config });
            renderUsageWidget(mockCtx);
            const renderFn = mockCtx.ui.setWidget.mock.calls[0][1];
            const widget = renderFn(null, theme);
            const output = widget.render(500); 
            expect(output[1]).toContain('[error]');
            expect(output[1]).toContain('[warning]');
            expect(output[1]).toContain('[success]');
            expect(output[1]).toContain('○'); // Ignored icon
        });

        it('should handle small width render and invalidate', () => {
            const mockCtx: any = { hasUI: true, ui: { setWidget: vi.fn() } };
            const config: any = { mappings: [], widget: { enabled: true, showCount: 1, placement: 'aboveEditor' } };
            updateWidgetState({ candidates: [{ provider: 'p', displayName: 'D', windowLabel: 'W', usedPercent: 0, remainingPercent: 100 }], config });
            renderUsageWidget(mockCtx);
            const renderFn = mockCtx.ui.setWidget.mock.calls[0][1];
            const widget = renderFn(null, theme);
            expect(widget.render(5)).toHaveLength(3);
            expect(widget.invalidate()).toBeUndefined();
        });
    });
});
