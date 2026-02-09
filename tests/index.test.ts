import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import modelSelectorExtension from '../index.js';
import * as usageFetchers from '../src/usage-fetchers.js';
import * as configMod from '../src/config.js';

// Mock dependencies
vi.mock('../src/usage-fetchers.js');
vi.mock('../src/config.js');
vi.mock('../src/widget.js', () => ({
    updateWidgetState: vi.fn(),
    renderUsageWidget: vi.fn(),
    clearWidget: vi.fn(),
    getWidgetState: vi.fn(),
}));

const COOLDOWN_STATE_PATH = path.join(os.homedir(), ".pi", "model-selector-cooldowns.json");

describe('Model Selector Extension', () => {
    let pi: any;
    let ctx: any;
    let commands: Record<string, Function> = {};

    beforeEach(() => {
        // Clear persisted cooldown state before each test
        try {
            if (fs.existsSync(COOLDOWN_STATE_PATH)) {
                fs.unlinkSync(COOLDOWN_STATE_PATH);
            }
        } catch {
            // Ignore errors
        }

        commands = {};
        pi = {
            on: vi.fn(),
            registerCommand: vi.fn((name, opts) => {
                commands[name] = opts.handler;
            }),
            setModel: vi.fn().mockResolvedValue(true),
        };
        ctx = {
            modelRegistry: {
                find: vi.fn().mockImplementation((p, id) => ({ provider: p, id })),
            },
            model: { provider: 'p1', id: 'm1' }, // Already selected
            ui: {
                notify: vi.fn(),
                select: vi.fn(),
                confirm: vi.fn(),
            },
            hasUI: true,
        };

        // Default mocks
        (configMod.loadConfig as any).mockResolvedValue({
            mappings: [
                { usage: { provider: 'p1', window: 'w1' }, model: { provider: 'p1', id: 'm1' } },
                { usage: { provider: 'p2', window: 'w2' }, model: { provider: 'p2', id: 'm2' } }
            ],
            priority: ['remainingPercent'],
            widget: { enabled: true, placement: 'belowEditor', showCount: 3 },
            disabledProviders: [],
            sources: { globalPath: '', projectPath: '' },
            raw: { global: {}, project: {} }
        });

        (usageFetchers.fetchAllUsages as any).mockResolvedValue([
            {
                provider: 'p1',
                displayName: 'Provider 1',
                windows: [{ label: 'w1', usedPercent: 10, resetsAt: new Date() }],
            },
            {
                provider: 'p2',
                displayName: 'Provider 2',
                windows: [{ label: 'w2', usedPercent: 20, resetsAt: new Date() }],
            }
        ]);
    });

    it('should register commands', () => {
        modelSelectorExtension(pi);
        expect(pi.registerCommand).toHaveBeenCalledWith('model-select', expect.anything());
        expect(pi.registerCommand).toHaveBeenCalledWith('model-skip', expect.anything());
    });

    it('should select best model on command', async () => {
        modelSelectorExtension(pi);
        const handler = commands['model-select'];
        
        await handler({}, ctx);
        
        // p1 (90% remaining) > p2 (80% remaining)
        // ctx.model is p1/m1, so it says "Already using"
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Already using p1/m1'), 'info');
    });

    it('should skip model on /model-skip', async () => {
        modelSelectorExtension(pi);
        const selectHandler = commands['model-select'];
        const skipHandler = commands['model-skip'];

        // 1. Run select to establish "last selected"
        await selectHandler({}, ctx);
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Already using p1/m1'), 'info');
        
        // 2. Run skip
        ctx.ui.notify.mockClear();
        await skipHandler({}, ctx);
        
        // Should notify about cooldown
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('cooldown'), 'info');
        
        // Should now select p2
        expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'p2', id: 'm2' }));
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set model to p2/m2'), 'info');
    });

    it('should handle skipping when no prior selection exists', async () => {
        modelSelectorExtension(pi);
        const skipHandler = commands['model-skip'];

        // Run skip without prior select
        // It should run selection first (p1), set it to cooldown, then run again (p2)
        await skipHandler({}, ctx);

        // Debug: print notify calls
        // console.log(ctx.ui.notify.mock.calls);

        // Verify it eventually picked p2
        expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'p2', id: 'm2' }));
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Set model to p2/m2'), 'info');
    });
});
