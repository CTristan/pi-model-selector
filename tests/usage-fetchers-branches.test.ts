
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
    fetchClaudeUsage, 
    fetchCopilotUsage, 
    fetchGeminiUsage, 
    fetchAntigravityUsage, 
    fetchZaiUsage, 
    fetchKiroUsage, 
    fetchAllCodexUsages, 
    formatReset, 
    loadPiAuth,
    refreshGoogleToken
} from '../src/usage-fetchers.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mocks
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        promises: {
            ...actual.promises,
            readFile: vi.fn(),
            access: vi.fn(),
            stat: vi.fn(),
            readdir: vi.fn(),
        },
    };
});

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        platform: vi.fn(),
        homedir: vi.fn().mockReturnValue('/mock/home'),
    };
});

vi.mock('node:child_process', () => ({
    exec: vi.fn((cmd, options, cb) => {
        if (typeof options === 'function') cb = options;
        cb(null, { stdout: '' }, '');
    }),
}));

describe('Usage Fetchers Branch Coverage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetAllMocks(); // This clears implementations too

        // Re-establish default mocks
        vi.mocked(fs.promises.readFile).mockResolvedValue('');
        vi.mocked(fs.promises.access).mockResolvedValue(undefined); // Success
        vi.mocked(fs.promises.stat).mockRejectedValue(new Error('no ent'));
        vi.mocked(fs.promises.readdir).mockResolvedValue([]);
        
        vi.mocked(os.platform).mockReturnValue('linux');
        vi.mocked(os.homedir).mockReturnValue('/mock/home');
        
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ 
            ok: false, 
            status: 404, 
            json: async () => ({}),
            text: async () => ''
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ========================================================================
    // Utilities
    // ========================================================================
    describe('formatReset', () => {
        it('should format hours without minutes if minutes is 0', () => {
            const now = Date.now();
            expect(formatReset(new Date(now + 120 * 60000 + 1000))).toBe('2h');
            expect(formatReset(new Date(now + 121 * 60000 + 1000))).toBe('2h 1m');
        });
        
        it('formatReset should handle minutes < 60', () => {
            const now = Date.now();
            expect(formatReset(new Date(now + 45 * 60000 + 1000))).toBe('45m');
        });

        it('should format days', () => {
            const now = Date.now();
            expect(formatReset(new Date(now + 25 * 60 * 60 * 1000))).toBe('1d 1h');
            expect(formatReset(new Date(now + 7 * 24 * 60 * 60 * 1000 + 1000))).not.toContain('d'); // > 7 days falls back to date
        });
        
        it('should return date string for > 7 days', () => {
             const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
             expect(formatReset(future)).not.toBe('');
             expect(formatReset(future)).not.toContain('d '); 
        });
    });

    describe('loadPiAuth', () => {
        it('should return parsed JSON on success', async () => {
            vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ test: 123 }));
            const auth = await loadPiAuth();
            expect(auth).toEqual({ test: 123 });
        });
    });

    // ========================================================================
    // Claude
    // ========================================================================
    describe('Claude Usage', () => {
        it('should return undefined for keychain on non-darwin', async () => {
            vi.mocked(os.platform).mockReturnValue('linux');
            const result = await fetchClaudeUsage({});
            expect(result.error).toBe('No credentials');
        });

        it('should handle keychain error/empty', async () => {
            vi.mocked(os.platform).mockReturnValue('darwin');
            const child_process = await import('node:child_process');
            vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 // @ts-ignore
                 cb(new Error('fail'), { stdout: '' }, '');
            });
            const result = await fetchClaudeUsage({});
            expect(result.error).toBe('No credentials');
        });
        
        it('should handle successful keychain load but missing scopes', async () => {
            vi.mocked(os.platform).mockReturnValue('darwin');
            const child_process = await import('node:child_process');
            vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 // @ts-ignore
                 cb(null, { stdout: JSON.stringify({ claudeAiOauth: { scopes: ['other'], accessToken: 'abc' } }) }, '');
            });
            const result = await fetchClaudeUsage({});
            expect(result.error).toBe('No credentials');
        });
        
        it('fetchClaudeUsage should update token from keychain if different', async () => {
            vi.mocked(os.platform).mockReturnValue('darwin');
            const child_process = await import('node:child_process');
            vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 // @ts-ignore
                 cb(null, { stdout: JSON.stringify({ claudeAiOauth: { scopes: ['user:profile'], accessToken: 'new_key' } }) }, '');
            });

            const fetchMock = vi.fn()
                .mockResolvedValueOnce({ ok: false, status: 401 }) // Old token fails
                .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 0.1 } }) }); // New token succeeds
            vi.stubGlobal('fetch', fetchMock);

            const result = await fetchClaudeUsage({ anthropic: { access: 'old_key' } });
            expect(result.account).toBe('keychain');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
        
        it('fetchClaudeUsage should use global resetsAt if pessimistic window requires it', async () => {
             const now = Date.now();
             const globalReset = new Date(now + 3600 * 1000).toISOString();
             const sonnetReset = new Date(now + 1800 * 1000).toISOString();
             
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    five_hour: { utilization: 0.9, resets_at: globalReset },
                    seven_day_sonnet: { utilization: 0.5, resets_at: sonnetReset }
                })
            }));

            const result = await fetchClaudeUsage({ anthropic: { access: 'key' } });
            const sonnetWindow = result.windows.find(w => w.label === 'Sonnet');
            expect(sonnetWindow?.usedPercent).toBe(90);
            expect(sonnetWindow?.resetsAt?.toISOString()).toBe(globalReset);
        });

        it('fetchClaudeUsage with no global reset time', async () => {
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    five_hour: { utilization: 0.9 }, 
                    seven_day_sonnet: { utilization: 0.5, resets_at: '2026-01-01T00:00:00Z' }
                })
            }));

            const result = await fetchClaudeUsage({ anthropic: { access: 'key' } });
            const w = result.windows.find(w => w.label === 'Sonnet');
            expect(w?.usedPercent).toBe(90);
        });

        it('fetchClaudeUsage with no specific reset time', async () => {
             const globalReset = new Date(Date.now() + 3600*1000).toISOString();
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    five_hour: { utilization: 0.9, resets_at: globalReset },
                    seven_day_sonnet: { utilization: 0.5 } 
                })
            }));

            const result = await fetchClaudeUsage({ anthropic: { access: 'key' } });
            const w = result.windows.find(w => w.label === 'Sonnet');
            expect(w?.resetsAt?.toISOString()).toBe(globalReset);
        });
    });

    // ========================================================================
    // Copilot
    // ========================================================================
    describe('Copilot Usage', () => {
        it('should handle registry errors', async () => {
            const child_process = await import('node:child_process');
            vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 // @ts-ignore
                 cb(null, { stdout: '' }, '');
            });

            const modelRegistry = {
                authStorage: {
                    getApiKey: vi.fn().mockRejectedValue(new Error('registry fail')),
                    get: vi.fn().mockRejectedValue(new Error('registry fail')),
                }
            };
            const result = await fetchCopilotUsage(modelRegistry, {});
            expect(result.provider).toBe('copilot');
            expect(result.error).toBe('No token found');
        });

        it('should pick up token from gh auth token', async () => {
             const child_process = await import('node:child_process');
             vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 if (typeof cmd === 'string' && cmd.includes('gh auth token')) {
                     // @ts-ignore
                     cb(null, { stdout: 'gh_cli_token\n' }, '');
                 } else {
                     // @ts-ignore
                     cb(new Error('fail'), { stdout: '' }, '');
                 }
            });
            
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ quota_snapshots: { chat: { percent_remaining: 50 } } })
            }));

            const result = await fetchCopilotUsage({}, {});
            expect(result.account).toBe('gh-cli');
        });
        
        it('should fallback to 304 cached state', async () => {
             const child_process = await import('node:child_process');
             vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 // @ts-ignore
                 cb(null, { stdout: 'gh_cli_token' }, '');
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 304
            }));
            
            const result = await fetchCopilotUsage({}, {});
            expect(result.account).toBe('304-fallback');
            expect(result.windows[0].resetDescription).toContain('cached');
        });
        
        it('fetchCopilotUsage should use registry token', async () => {
             const modelRegistry = {
                authStorage: {
                    getApiKey: vi.fn().mockResolvedValue('reg_key'),
                    get: vi.fn().mockResolvedValue({ access: 'reg_access' }),
                }
            };
            
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ quota_snapshots: { chat: { percent_remaining: 50 } } })
            }));

            const result = await fetchCopilotUsage(modelRegistry, {});
            expect(result.account).toContain('registry');
        });
    });

    // ========================================================================
    // Gemini
    // ========================================================================
    describe('Gemini Usage', () => {
        it('should handle refresh failure and fallback to creds file', async () => {
            const piAuth = {
                'google-gemini-cli': { access: 'expired_token', refresh: 'refresh_token', projectId: 'pid' }
            };

            const fetchMock = vi.fn()
                .mockResolvedValueOnce({ ok: false, status: 401 }) 
                .mockResolvedValueOnce({ ok: false }) 
                .mockResolvedValueOnce({ ok: true, json: async () => ({ buckets: [] }) }); 
            
            vi.stubGlobal('fetch', fetchMock);
            
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ access_token: 'file_token', project_id: 'pid' }));

            const result = await fetchGeminiUsage({}, piAuth);
            expect(result.provider).toBe('gemini');
            expect(fetchMock).toHaveBeenCalledTimes(3); 
        });

        it('should handle generic model families', async () => {
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ buckets: [
                    { modelId: 'unknown-model-1', remainingFraction: 0.5 },
                ] })
            }));
            
            const result = await fetchGeminiUsage({}, { 'google-gemini-cli': { access: 'tok', projectId: 'pid' } });
            expect(result.windows[0].label).toBe('Unknown');
        });

        it('refreshGoogleToken should handle API failures', async () => {
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
            expect(await refreshGoogleToken('rt')).toBeNull();

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
            expect(await refreshGoogleToken('rt')).toBeNull();

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ 
                ok: true, 
                json: async () => ({ expires_in: 3600 }) 
            }));
            expect(await refreshGoogleToken('rt')).toBeNull();
        });
    });

    // ========================================================================
    // Antigravity
    // ========================================================================
    describe('Antigravity Usage', () => {
        it('should handle missing credentials gracefully', async () => {
            const result = await fetchAntigravityUsage({}, {});
            expect(result.error).toBe('No credentials');
        });

        it('should use ENV var credential', async () => {
            process.env.ANTIGRAVITY_API_KEY = 'env_key';
            const result = await fetchAntigravityUsage({}, {});
            expect(result.error).toBe('Missing projectId');
            delete process.env.ANTIGRAVITY_API_KEY;
        });

        it('should handle refresh failure and fallback to piAuth', async () => {
             const modelRegistry = {
                 authStorage: {
                     getApiKey: async () => 'expired_reg_token',
                     get: async () => ({ projectId: 'pid', refresh: 'bad_refresh' })
                 }
             };
             
             const piAuth = {
                 'google-antigravity': { access: 'fallback_token', projectId: 'pid' }
             };
             
             const fetchMock = vi.fn();
             fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
             fetchMock.mockResolvedValueOnce({ ok: false });
             fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: {} }) });
             
             vi.stubGlobal('fetch', fetchMock);
             
             const result = await fetchAntigravityUsage(modelRegistry, piAuth);
             expect(result.provider).toBe('antigravity');
             expect(result.error).toBe('No quota data');
        });

        it('fetchAntigravityUsage should proactively refresh token', async () => {
             const piAuth = {
                 'google-antigravity': { 
                     access: 'old_tok', 
                     refresh: 'rt', 
                     expires: Date.now() + 1000, 
                     projectId: 'pid'
                 }
             };

             const fetchMock = vi.fn();
             fetchMock.mockResolvedValueOnce({ 
                 ok: true, 
                 json: async () => ({ access_token: 'new_tok', expires_in: 3600 }) 
             });
             fetchMock.mockResolvedValueOnce({ 
                 ok: true, 
                 json: async () => ({ models: {} }) 
             });
             
             vi.stubGlobal('fetch', fetchMock);

             const result = await fetchAntigravityUsage({}, piAuth);
             expect(fetchMock.mock.calls[0][0]).toContain('oauth2.googleapis.com');
        });
        
        it('fetchAntigravityUsage should continue if proactive refresh fails', async () => {
             const piAuth = {
                 'google-antigravity': { 
                     access: 'old_tok', 
                     refresh: 'rt', 
                     expires: Date.now() + 1000, 
                     projectId: 'pid'
                 }
             };

             const fetchMock = vi.fn();
             fetchMock.mockResolvedValueOnce({ ok: false });
             fetchMock.mockResolvedValueOnce({ 
                 ok: true, 
                 json: async () => ({ models: {} }) 
             });
             
             vi.stubGlobal('fetch', fetchMock);

             const result = await fetchAntigravityUsage({}, piAuth);
             expect(result.provider).toBe('antigravity');
        });

        it('fetchAntigravityUsage should skip models with better quota (pessimistic)', async () => {
             const piAuth = { 'google-antigravity': { access: 'tok', projectId: 'pid' } };
             
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                 ok: true,
                 json: async () => ({ models: { 
                     'claude-sonnet-4-5': { quotaInfo: { remainingFraction: 0.5 } }, 
                     'claude-sonnet-4-5-thinking': { quotaInfo: { remainingFraction: 0.9 } }, 
                     'gpt-oss-120b-medium': { quotaInfo: { remainingFraction: 0.1 } }, 
                 } })
             }));

             const result = await fetchAntigravityUsage({}, piAuth);
             expect(result.windows[0].usedPercent).toBe(90);
        });
        
        it('fetchAntigravityUsage should compare multiple models', async () => {
             const piAuth = { 'google-antigravity': { access: 'tok', projectId: 'pid' } };
             
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                 ok: true,
                 json: async () => ({ models: { 
                     'claude-sonnet-4-5': { quotaInfo: { remainingFraction: 0.8 } },
                     'claude-opus-4-5-thinking': { quotaInfo: { remainingFraction: 0.2 } }, 
                 } })
             }));

             const result = await fetchAntigravityUsage({}, piAuth);
             expect(result.windows[0].usedPercent).toBe(80);
        });
    });

    // ========================================================================
    // Codex
    // ========================================================================
    describe('Codex Usage', () => {
        it('should discover credentials from .codex directory', async () => {
            vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
            vi.mocked(fs.promises.readdir).mockResolvedValue(['auth.json', 'auth-other.json', 'ignore.txt'] as any);
            
            vi.mocked(fs.promises.readFile).mockImplementation(async (p) => {
                if (String(p).endsWith('auth.json')) return JSON.stringify({ tokens: { access_token: 'tok1' } });
                if (String(p).endsWith('auth-other.json')) return JSON.stringify({ OPENAI_API_KEY: 'tok2' });
                return '';
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ rate_limit: {} })
            }));

            const result = await fetchAllCodexUsages({}, {});
            expect(result).toHaveLength(2);
        });
        
        it('should handle string credit balance', async () => {
             vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ 
                    rate_limit: { primary_window: { used_percent: 10 } },
                    credits: { balance: "20.50" },
                    plan_type: 'Pro'
                })
            }));
            
            const result = await fetchAllCodexUsages({}, { 'openai-codex': { access: 't' } });
            expect(result[0].plan).toBe('Pro ($20.50)');
        });
        
        it('fetchAllCodexUsages handles errors in fingerprinting', async () => {
             const piAuth = {
                'openai-codex-1': { access: 'tok1' },
                'openai-codex-2': { access: 'tok2' }
            };
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));
            const result = await fetchAllCodexUsages({}, piAuth);
            expect(result).toHaveLength(2);
        });
        
        it('usageFingerprint should handle empty windows', async () => {
            const piAuth = { 'openai-codex-1': { access: 'tok' } };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                 ok: true,
                 json: async () => ({ }) // No rate_limit
             }));
             const result = await fetchAllCodexUsages({}, piAuth);
             expect(result).toHaveLength(1);
        });
    });

    // ========================================================================
    // Kiro
    // ========================================================================
    describe('Kiro Usage', () => {
        it('should return error if kiro-cli not found', async () => {
            vi.mocked(os.platform).mockReturnValue('linux');
             const child_process = await import('node:child_process');
             vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 if (typeof cmd === 'string' && cmd.includes('which')) {
                     // @ts-ignore
                     cb(new Error('not found'), { stdout: '' }, '');
                 } else {
                     // @ts-ignore
                     cb(null, { stdout: '' }, '');
                 }
            });
            const result = await fetchKiroUsage();
            expect(result.error).toBe('kiro-cli not found');
        });

        it('should handle date ambiguity DD/MM vs MM/DD', async () => {
             vi.mocked(os.platform).mockReturnValue('linux');
             const child_process = await import('node:child_process');
             vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 if (typeof cmd === 'string' && cmd.includes('which')) {
                     // @ts-ignore
                     cb(null, { stdout: '/bin/kiro' }, '');
                 } else if (cmd.includes('whoami')) {
                     // @ts-ignore
                     cb(null, { stdout: 'user' }, '');
                 } else {
                     // @ts-ignore
                     cb(null, { stdout: 'resets on 02/03' }, '');
                 }
            });
            
            const result = await fetchKiroUsage();
            expect(result.windows[0].resetsAt).toBeDefined();
        });
        
        it('kiro date heuristic branches', async () => {
             const child_process = await import('node:child_process');
             vi.mocked(child_process.exec).mockImplementation((cmd, opts, cb) => {
                 if (cmd.includes('which')) { // @ts-ignore
                    cb(null, { stdout: '/bin/kiro' }, ''); 
                 }
                 else if (cmd.includes('whoami')) { // @ts-ignore
                    cb(null, { stdout: 'user' }, ''); 
                 }
                 else {
                     // @ts-ignore
                     cb(null, { stdout: 'resets on 10/11' }, '');
                 }
            });
            const result = await fetchKiroUsage();
            expect(result.windows[0].resetsAt).toBeDefined();
        });
        it('fetchAntigravityUsage should fail if piAuth is missing projectId', async () => {
             const piAuth = { 'google-antigravity': { access: 'tok' } }; // No projectId
             const result = await fetchAntigravityUsage({}, piAuth);
             expect(result.error).toBe('Missing projectId');
        });

        it('fetchGeminiUsage should fail if piAuth is missing projectId', async () => {
             const piAuth = { 'google-gemini-cli': { access: 'tok' } };
             vi.mocked(fs.promises.access).mockRejectedValue(new Error('no file'));
             const result = await fetchGeminiUsage({}, piAuth);
             expect(result.error).toBe('Missing projectId');
        });

        it('fetchCopilotUsage should handle exchange exception', async () => {
             const piAuth = { 'github-copilot': { access: 'gh_token' } }; // Not a tid= token
             
             const fetchMock = vi.fn();
             // 1. Initial fetch (token gh_token) -> 401
             fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' });
             // 2. Bearer fallback -> 401
             fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' });
             // 3. Exchange call -> Throws
             fetchMock.mockRejectedValueOnce(new Error('network fail'));
             
             vi.stubGlobal('fetch', fetchMock);
             
             const result = await fetchCopilotUsage({}, piAuth);
             // Should fail eventually
             expect(result.error).toBeDefined();
        });
        it('fetchGeminiUsage should try file fallback if refreshed token still fails', async () => {
             const piAuth = {
                'google-gemini-cli': { access: 'expired_token', refresh: 'valid_refresh', projectId: 'pid' }
            };

            const fetchMock = vi.fn();
            // 1. Initial 401
            fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
            // 2. Refresh success
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'new_token' }) });
            // 3. New token 401
            fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
            // 4. File fallback success
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ buckets: [] }) });
            
            vi.stubGlobal('fetch', fetchMock);
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ access_token: 'file_token', project_id: 'pid' }));

            const result = await fetchGeminiUsage({}, piAuth);
            expect(result.provider).toBe('gemini');
            expect(fetchMock).toHaveBeenCalledTimes(4);
        });

        it('fetchAntigravityUsage should skip proactive refresh if expiry is far', async () => {
             const piAuth = {
                 'google-antigravity': { 
                     access: 'tok', 
                     refresh: 'rt', 
                     expires: Date.now() + 3600 * 1000, // 1 hour
                     projectId: 'pid'
                 }
             };

             const fetchMock = vi.fn().mockResolvedValue({ 
                 ok: true, 
                 json: async () => ({ models: {} }) 
             });
             vi.stubGlobal('fetch', fetchMock);

             const result = await fetchAntigravityUsage({}, piAuth);
             // Should only call models endpoint, not refresh
             expect(fetchMock).toHaveBeenCalledTimes(1);
             expect(fetchMock.mock.calls[0][0]).toContain('cloudcode-pa');
        });
        it('fetchGeminiUsage should skip file fallback if token is same', async () => {
             const piAuth = {
                'google-gemini-cli': { access: 'expired_token', refresh: 'valid_refresh', projectId: 'pid' }
            };

            const fetchMock = vi.fn();
            // 1. Initial 401
            fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
            // 2. Refresh success
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'new_token' }) });
            // 3. New token 401
            fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
            
            // File has SAME token as new_token
            vi.stubGlobal('fetch', fetchMock);
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ access_token: 'new_token', project_id: 'pid' }));

            const result = await fetchGeminiUsage({}, piAuth);
            expect(result.provider).toBe('gemini');
            expect(fetchMock).toHaveBeenCalledTimes(3); // Should NOT call 4th time
        });

        it('fetchAntigravityUsage should skip fallback if token is same', async () => {
             // Auth from Registry/File
             vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({})); // No file
             
             // Setup: loadAntigravityAuth returns a token.
             // piAuth has SAME token.
             
             const modelRegistry = {
                 authStorage: {
                     getApiKey: async () => 'tok',
                     get: async () => ({ projectId: 'pid' })
                 }
             };
             
             const piAuth = {
                 'google-antigravity': { access: 'tok', projectId: 'pid' }
             };

             const fetchMock = vi.fn();
             // 1. Initial 401
             fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
             
             vi.stubGlobal('fetch', fetchMock);

             const result = await fetchAntigravityUsage(modelRegistry, piAuth);
             // Should fail after 1 call because fallback token is identical
             expect(fetchMock).toHaveBeenCalledTimes(1);
             expect(result.error).toBe('Unauthorized');
        });
    });
});
