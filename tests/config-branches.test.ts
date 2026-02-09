
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, readConfigFile } from '../src/config.js';
import * as fs from 'node:fs';

// Mocks
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        promises: {
            ...actual.promises,
            readFile: vi.fn(),
            access: vi.fn(),
            mkdir: vi.fn(),
            writeFile: vi.fn(),
            rename: vi.fn(),
            unlink: vi.fn(),
        },
    };
});

describe('Config Branch Coverage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.promises.access).mockResolvedValue(undefined);
        vi.mocked(fs.promises.readFile).mockResolvedValue('{}');
        // Default existsSync to false so we don't pick up real files
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should validate priority tie-breakers', async () => {
        const config = {
            priority: ['fullAvailability'] // Missing remainingPercent or earliestReset
        };
        vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));

        const ctx: any = { cwd: '/mock' };
        // We expect loadConfig to return null because of validation errors
        // But loadConfig also checks global config. We mock both to return same invalid config?
        // Or one valid one invalid?
        // If project config is invalid, it returns null.
        
        const res = await loadConfig(ctx);
        expect(res).toBeNull();
    });

    it('should validate mapping entries (ignore + model conflict)', async () => {
        const config = {
            mappings: [
                {
                    usage: { provider: 'p' },
                    model: { provider: 'p', id: 'm' },
                    ignore: true
                }
            ]
        };
        vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));
        
        // This causes an error, so loadConfig returns null
        const res = await loadConfig({ cwd: '/mock' } as any);
        expect(res).toBeNull();
    });

    it('should validate mapping entries (incomplete model)', async () => {
        const config = {
            mappings: [
                {
                    usage: { provider: 'p' },
                    model: { provider: 'p' } // Missing ID
                }
            ]
        };
        vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));
        const res = await loadConfig({ cwd: '/mock' } as any);
        expect(res).toBeNull();
    });
    
    it('should validate mapping entries (invalid regex)', async () => {
        const config = {
            mappings: [
                {
                    usage: { provider: 'p', windowPattern: '[' },
                    model: { provider: 'p', id: 'm' }
                }
            ]
        };
        vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));
        const res = await loadConfig({ cwd: '/mock' } as any);
        expect(res).toBeNull();
    });
    
    it('readConfigFile should handle JSON parse errors array', async () => {
        vi.mocked(fs.promises.readFile).mockResolvedValue('[]');
        const errors: string[] = [];
        const res = await readConfigFile('foo', errors);
        expect(res).toBeNull();
        expect(errors[0]).toContain('expected a JSON object');
    });
});
