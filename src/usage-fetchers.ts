import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RateWindow, UsageSnapshot } from "./types.js";
import { writeDebugLog } from "./types.js";

const execAsync = promisify(exec);

// ============================================================================
// Utility Functions
// ============================================================================

export async function loadPiAuth(): Promise<any> {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		const data = await fs.promises.readFile(piAuthPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		return {};
	}
}

export function safeDate(value: any): Date | undefined {
	if (!value) return undefined;
	const d = new Date(value);
	return isNaN(d.getTime()) ? undefined : d;
}

export function formatReset(date: Date): string {
	if (isNaN(date.getTime())) return "";
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";

	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${hours % 24}h`;

	try {
		return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
	} catch {
		return "";
	}
}

// ============================================================================
// Claude Usage
// ============================================================================

async function loadClaudeKeychainToken(): Promise<string | undefined> {
	if (os.platform() !== "darwin") return undefined;
	try {
		const { stdout } = await execAsync(
			"security find-generic-password -s \"Claude Code-credentials\" -w 2>/dev/null",
			{ encoding: "utf-8" }
		);
		const keychainData = stdout.trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				return parsed.claudeAiOauth.accessToken;
			}
		}
	} catch {}
	return undefined;
}

export async function fetchClaudeUsage(piAuth: any = {}): Promise<UsageSnapshot> {
	let token = piAuth.anthropic?.access;
	let source = "auth.json";

	if (!token) {
		token = await loadClaudeKeychainToken();
		source = "keychain";
	}

	if (!token) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: "No credentials" };
	}

	const doFetch = async (accessToken: string) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		try {
			return await fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	};

	try {
		let res = await doFetch(token);

		if ((res.status === 401 || res.status === 403) && source === "auth.json") {
			const keychainToken = await loadClaudeKeychainToken();
			if (keychainToken && keychainToken !== token) {
				token = keychainToken;
				source = "keychain";
				res = await doFetch(token);
			}
		}

		if (!res.ok) {
			return { provider: "anthropic", displayName: "Claude", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			const resetDate = safeDate(data.five_hour.resets_at);
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization * 100,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		if (data.seven_day?.utilization !== undefined) {
			const resetDate = safeDate(data.seven_day.resets_at);
			windows.push({
				label: "Week",
				usedPercent: data.seven_day.utilization * 100,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		if (data.seven_day_sonnet?.utilization !== undefined) {
			const resetDate = safeDate(data.seven_day_sonnet.resets_at);
			windows.push({
				label: "Sonnet",
				usedPercent: data.seven_day_sonnet.utilization * 100,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		if (data.seven_day_opus?.utilization !== undefined) {
			const resetDate = safeDate(data.seven_day_opus.resets_at);
			windows.push({
				label: "Opus",
				usedPercent: data.seven_day_opus.utilization * 100,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		return { provider: "anthropic", displayName: "Claude", windows, account: source };
	} catch (error) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: String(error), account: source };
	}
}

// ============================================================================
// Copilot Usage
// ============================================================================

export async function fetchCopilotUsage(modelRegistry: any, piAuth: any = {}): Promise<UsageSnapshot> {
	try {
		writeDebugLog("fetchCopilotUsage: starting token discovery");

		interface TokenInfo {
			token: string;
			source: string;
			isCopilotToken: boolean;
		}

		const tokens: TokenInfo[] = [];

		const addToken = (token: any, source: string) => {
			if (typeof token !== "string" || !token) return;
			if (tokens.some((t) => t.token === token)) return;
			tokens.push({
				token,
				source,
				isCopilotToken: token.startsWith("tid="),
			});
			writeDebugLog(`fetchCopilotUsage: added token from ${source} (prefix: ${token.substring(0, 4)}, isCopilot: ${token.startsWith("tid=")})`);
		};

		const extractFromData = (data: any, source: string) => {
			if (!data || typeof data !== "object") return;
			addToken(data.access || data.accessToken || data.access_token, `${source}.access`);
			addToken(data.token, `${source}.token`);
		};

		// 1. Discovery
		try {
			const gcpKey = await Promise.resolve(modelRegistry?.authStorage?.getApiKey?.("github-copilot"));
			addToken(gcpKey, "registry:github-copilot:apiKey");
			
			const gcpData = await Promise.resolve(modelRegistry?.authStorage?.get?.("github-copilot"));
			extractFromData(gcpData, "registry:github-copilot:data");

			const ghKey = await Promise.resolve(modelRegistry?.authStorage?.getApiKey?.("github"));
			addToken(ghKey, "registry:github:apiKey");

			const ghData = await Promise.resolve(modelRegistry?.authStorage?.get?.("github"));
			extractFromData(ghData, "registry:github:data");
		} catch (e) {
			writeDebugLog(`fetchCopilotUsage: registry error: ${e}`);
		}

		const copilotAuth = piAuth["github-copilot"];
		if (copilotAuth?.access) {
			addToken(copilotAuth.access, "auth.json");
		}

		try {
			const { stdout } = await execAsync("gh auth token", { encoding: "utf-8" });
			if (stdout.trim()) addToken(stdout.trim(), "gh-cli");
		} catch {}

		if (tokens.length === 0) {
			writeDebugLog("fetchCopilotUsage: no tokens found");
			return { provider: "copilot", displayName: "Copilot", windows: [], error: "No token found", account: "none" };
		}

		const headersBase = {
			"Editor-Version": "vscode/1.97.0",
			"Editor-Plugin-Version": "copilot/1.160.0",
			"User-Agent": "GitHubCopilot/1.160.0",
			Accept: "application/json",
		};

		const tryFetch = async (authHeader: string) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			try {
				return await fetch("https://api.github.com/copilot_internal/user", {
					headers: { ...headersBase, Authorization: authHeader },
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
		};

		const tryExchange = async (githubToken: string): Promise<{ token: string; sku?: string } | null> => {
			writeDebugLog(`fetchCopilotUsage: attempting exchange for token from ${tokens.find(t => t.token === githubToken)?.source || "unknown"}`);
			try {
				const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
					headers: { ...headersBase, Authorization: `token ${githubToken}` },
					signal: AbortSignal.timeout(5000),
				});
				if (res.ok) {
					const data = await res.json() as any;
					if (data.token) {
						writeDebugLog(`fetchCopilotUsage: exchange successful (new prefix: ${data.token.substring(0, 4)})`);
						return { token: data.token, sku: data.sku };
					}
				} else {
					writeDebugLog(`fetchCopilotUsage: exchange failed: ${res.status} ${await res.text()}`);
				}
			} catch (e) {
				writeDebugLog(`fetchCopilotUsage: exchange error: ${e}`);
			}
			return null;
		};

		// 2. Execution
		let lastError: string | undefined;
		let skuFound: string | undefined;
		let any304 = false;

		for (const t of tokens) {
			writeDebugLog(`fetchCopilotUsage: trying token from ${t.source}`);
			
			let tokenToUse = t.token;
			let authHeader = t.isCopilotToken ? `Bearer ${tokenToUse}` : `token ${tokenToUse}`;

			let res = await tryFetch(authHeader);
			writeDebugLog(`fetchCopilotUsage: fetch with ${t.source} (${t.isCopilotToken ? 'Bearer' : 'token'}) status: ${res.status}`);

			if (res.status === 401 && !t.isCopilotToken) {
				res = await tryFetch(`Bearer ${tokenToUse}`);
				writeDebugLog(`fetchCopilotUsage: fetch with ${t.source} (Bearer fallback) status: ${res.status}`);
			}

			if (res.status === 401 && !t.isCopilotToken) {
				const exchanged = await tryExchange(tokenToUse);
				if (exchanged) {
					tokenToUse = exchanged.token;
					skuFound = exchanged.sku;
					res = await tryFetch(`Bearer ${tokenToUse}`);
					writeDebugLog(`fetchCopilotUsage: fetch with exchanged ${t.source} status: ${res.status}`);
				}
			}

			if (res.ok || res.status === 304) {
				writeDebugLog(`fetchCopilotUsage: success with token from ${t.source}${res.status === 304 ? ' (304 Not Modified)' : ''}`);
				
				if (res.status === 304) {
					any304 = true;
					continue;
				}

				const data = await res.json() as any;
				const windows: RateWindow[] = [];
				const resetDate = safeDate(data.quota_reset_date_utc);
				const resetDesc = resetDate ? formatReset(resetDate) : undefined;

				if (data.quota_snapshots?.premium_interactions) {
					const pi = data.quota_snapshots.premium_interactions;
					const remaining = pi.remaining ?? 0;
					const entitlement = pi.entitlement ?? 0;
					const usedPercent = Math.max(0, 100 - (pi.percent_remaining || 0));
					windows.push({
						label: "Premium",
						usedPercent,
						resetDescription: resetDesc ? `${resetDesc} (${remaining}/${entitlement})` : `${remaining}/${entitlement}`,
						resetsAt: resetDate,
					});
				}

				if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
					const chat = data.quota_snapshots.chat;
					windows.push({
						label: "Chat",
						usedPercent: Math.max(0, 100 - (chat.percent_remaining || 0)),
						resetDescription: resetDesc,
						resetsAt: resetDate,
					});
				}

				return { provider: "copilot", displayName: "Copilot", windows, plan: data.copilot_plan || skuFound, account: t.source };
			}

			if (res.status === 401 || res.status === 403) {
				const body = await res.text();
				lastError = `HTTP ${res.status} from ${t.source}: ${body.slice(0, 100)}`;
			} else {
				lastError = `HTTP ${res.status} from ${t.source}`;
			}
		}

		if (any304) {
			writeDebugLog("fetchCopilotUsage: no fresh data but received 304, falling back to active status");
			return {
				provider: "copilot",
				displayName: "Copilot",
				windows: [{ label: "Access", usedPercent: 0, resetDescription: "Active (cached)" }],
				plan: skuFound,
				account: "304-fallback",
			};
		}

		if (skuFound) {
			writeDebugLog("fetchCopilotUsage: all fetch attempts failed but we have a SKU, falling back to Active");
			return {
				provider: "copilot",
				displayName: "Copilot",
				windows: [{ label: "Access", usedPercent: 0, resetDescription: "Active" }],
				plan: skuFound,
				account: "fallback",
			};
		}

		return { provider: "copilot", displayName: "Copilot", windows: [], error: lastError || "All tokens failed", account: "none" };
	} catch (error) {
		writeDebugLog(`fetchCopilotUsage: fatal error: ${error}`);
		return { provider: "copilot", displayName: "Copilot", windows: [], error: String(error), account: "error" };
	}
}

// ============================================================================
// Token Refresh (shared)
// ============================================================================

export async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10000);
	try {
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "947318989803-6bn6qk8qdgf4n4g3pfee6491hc0brc4i.apps.googleusercontent.com",
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
			signal: controller.signal,
		});

		if (!res.ok) return null;

		const data = (await res.json()) as any;
		if (!data.access_token) return null;

		return {
			accessToken: data.access_token,
			expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// ============================================================================
// Gemini Usage
// ============================================================================

export async function fetchGeminiUsage(_modelRegistry: any, piAuth: any = {}): Promise<UsageSnapshot> {
	let token: string | undefined = piAuth["google-gemini-cli"]?.access;
	let refreshToken: string | undefined = piAuth["google-gemini-cli"]?.refresh;
	let projectId: string | undefined = piAuth["google-gemini-cli"]?.projectId || piAuth["google-gemini-cli"]?.project_id;

	if (!token) {
		const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
		try {
			await fs.promises.access(credPath);
			const data = JSON.parse(await fs.promises.readFile(credPath, "utf-8"));
			token = data.access_token;
			if (!projectId) projectId = data.project_id || data.projectId;
		} catch {}
	}

	if (!token) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: "No credentials", account: "pi-auth" };
	}

	if (!projectId) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: "Missing projectId", account: "pi-auth" };
	}

	const doFetch = async (accessToken: string) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);

		try {
			return await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ project: projectId }),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	};

	try {
		let res = await doFetch(token);

		if (res.status === 401 || res.status === 403) {
			let refreshed = false;

			if (refreshToken) {
				const newData = await refreshGoogleToken(refreshToken);
				if (newData?.accessToken) {
					token = newData.accessToken;
					res = await doFetch(token);
					refreshed = true;
				}
			}

			if (!refreshed || res.status === 401 || res.status === 403) {
				const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
				try {
					await fs.promises.access(credPath);
					const data = JSON.parse(await fs.promises.readFile(credPath, "utf-8"));
					if (data.access_token && data.access_token !== token) {
						const newToken: string = data.access_token;
						res = await doFetch(newToken);
					}
				} catch {}
			}
		}

		if (!res.ok) {
			return { provider: "gemini", displayName: "Gemini", windows: [], error: `HTTP ${res.status}`, account: "pi-auth" };
		}

		const data = (await res.json()) as any;
		const quotas: Record<string, number> = {};

		for (const bucket of data.buckets || []) {
			const model = bucket.modelId || "unknown";
			const frac = bucket.remainingFraction ?? 1;
			// Pessimistic: keep the model with the LEAST remaining quota (min fraction)
			// as all rate limits must be satisfied.
			if (quotas[model] === undefined || frac < quotas[model]) quotas[model] = frac;
		}

		const windows: RateWindow[] = [];
		let proMin = 2.0; // Higher than any valid fraction
		let flashMin = 2.0;

		for (const [model, frac] of Object.entries(quotas)) {
			if (model.toLowerCase().includes("pro")) {
				if (frac < proMin) proMin = frac;
			}
			if (model.toLowerCase().includes("flash")) {
				if (frac < flashMin) flashMin = frac;
			}
		}

		if (proMin <= 1.0) windows.push({ label: "Pro", usedPercent: (1 - proMin) * 100 });
		if (flashMin <= 1.0) windows.push({ label: "Flash", usedPercent: (1 - flashMin) * 100 });

		return { provider: "gemini", displayName: "Gemini", windows, account: "pi-auth" };
	} catch (error) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: String(error), account: "pi-auth" };
	}
}

// ============================================================================
// Antigravity Usage
// ============================================================================

type AntigravityAuth = {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	projectId?: string;
};

function getAntigravityAuthFromPiAuth(piAuth: any): AntigravityAuth | undefined {
	const cred = piAuth["google-antigravity"] ?? piAuth["antigravity"] ?? piAuth["anti-gravity"];
	if (!cred) return undefined;

	const accessToken = typeof cred.access === "string" ? cred.access : undefined;
	if (!accessToken) return undefined;

	return {
		accessToken,
		refreshToken: typeof cred.refresh === "string" ? cred.refresh : undefined,
		expiresAt: typeof cred.expires === "number" ? cred.expires : undefined,
		projectId: typeof cred.projectId === "string" ? cred.projectId : typeof cred.project_id === "string" ? cred.project_id : undefined,
	};
}

async function loadAntigravityAuth(modelRegistry: any, piAuth: any): Promise<AntigravityAuth | undefined> {
	try {
		const accessToken = await Promise.resolve(modelRegistry?.authStorage?.getApiKey?.("google-antigravity"));
		const raw = await Promise.resolve(modelRegistry?.authStorage?.get?.("google-antigravity"));

		const projectId = typeof raw?.projectId === "string" ? raw.projectId : undefined;
		const refreshToken = typeof raw?.refresh === "string" ? raw.refresh : undefined;
		const expiresAt = typeof raw?.expires === "number" ? raw.expires : undefined;

		if (typeof accessToken === "string" && accessToken.length > 0) {
			return { accessToken, projectId, refreshToken, expiresAt };
		}
	} catch {}

	const fromPi = getAntigravityAuthFromPiAuth(piAuth);
	if (fromPi) return fromPi;

	if (process.env.ANTIGRAVITY_API_KEY) {
		return { accessToken: process.env.ANTIGRAVITY_API_KEY };
	}

	return undefined;
}

export async function fetchAntigravityUsage(modelRegistry: any, piAuth: any = {}): Promise<UsageSnapshot> {
	const auth = await loadAntigravityAuth(modelRegistry, piAuth);
	if (!auth?.accessToken) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No credentials", account: "pi-auth" };
	}

	if (!auth.projectId) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Missing projectId", account: "pi-auth" };
	}

	let accessToken = auth.accessToken;

	if (auth.refreshToken && auth.expiresAt && auth.expiresAt < Date.now() + 5 * 60 * 1000) {
		const refreshed = await refreshGoogleToken(auth.refreshToken);
		if (refreshed?.accessToken) accessToken = refreshed.accessToken;
	}

	const fetchModels = async (token: string): Promise<Response> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);

		try {
			return await fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.12.4",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
					Accept: "application/json",
				},
				body: JSON.stringify({ project: auth.projectId }),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	};

	try {
		let res = await fetchModels(accessToken);

		if (res.status === 401 || res.status === 403) {
			let refreshed = false;

			if (auth.refreshToken) {
				const refreshedToken = await refreshGoogleToken(auth.refreshToken);
				if (refreshedToken?.accessToken) {
					accessToken = refreshedToken.accessToken;
					res = await fetchModels(accessToken);
					refreshed = true;
				}
			}

			if (!refreshed || res.status === 401 || res.status === 403) {
				const fallbackAuth = getAntigravityAuthFromPiAuth(piAuth);
				if (fallbackAuth && (fallbackAuth.accessToken !== auth.accessToken || fallbackAuth.refreshToken)) {
					let fallbackToken = fallbackAuth.accessToken;

					if (fallbackAuth.refreshToken) {
						const refreshedFallback = await refreshGoogleToken(fallbackAuth.refreshToken);
						if (refreshedFallback?.accessToken) {
							fallbackToken = refreshedFallback.accessToken;
						}
					}

					res = await fetchModels(fallbackToken);
				}
			}
		}

		if (res.status === 401 || res.status === 403) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Unauthorized", account: "pi-auth" };
		}

		if (!res.ok) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: `HTTP ${res.status}`, account: "pi-auth" };
		}

		const data = (await res.json()) as any;
		const models: Record<string, any> = data.models || {};

		const getQuotaInfo = (modelKeys: string[]): { usedPercent: number; resetDescription?: string; resetsAt?: Date } | null => {
			let worstQI: { remainingFraction: number; resetTime?: string } | null = null;
			for (const key of modelKeys) {
				const qi = models?.[key]?.quotaInfo;
				if (!qi) continue;
				const rf = typeof qi.remainingFraction === "number" ? qi.remainingFraction : 0;
				// Pessimistic selection: find the model with the least remaining quota
				if (worstQI === null || rf < worstQI.remainingFraction) {
					worstQI = { remainingFraction: rf, resetTime: qi.resetTime };
				}
			}

			if (worstQI === null) return null;

			const usedPercent = Math.min(100, Math.max(0, (1 - worstQI.remainingFraction) * 100));
			const resetTime = worstQI.resetTime ? new Date(worstQI.resetTime) : undefined;
			return {
				usedPercent,
				resetDescription: resetTime ? formatReset(resetTime) : undefined,
				resetsAt: resetTime,
			};
		};

		const windows: RateWindow[] = [];

		const claudeOrGptOss = getQuotaInfo([
			"claude-sonnet-4-5",
			"claude-sonnet-4-5-thinking",
			"claude-opus-4-5-thinking",
			"gpt-oss-120b-medium",
		]);
		if (claudeOrGptOss) {
			windows.push({
				label: "Claude",
				usedPercent: claudeOrGptOss.usedPercent,
				resetDescription: claudeOrGptOss.resetDescription,
				resetsAt: claudeOrGptOss.resetsAt,
			});
		}

		const gemini3Pro = getQuotaInfo(["gemini-3-pro-high", "gemini-3-pro-low", "gemini-3-pro-preview"]);
		if (gemini3Pro) {
			windows.push({
				label: "G3 Pro",
				usedPercent: gemini3Pro.usedPercent,
				resetDescription: gemini3Pro.resetDescription,
				resetsAt: gemini3Pro.resetsAt,
			});
		}

		const gemini3Flash = getQuotaInfo(["gemini-3-flash"]);
		if (gemini3Flash) {
			windows.push({
				label: "G3 Flash",
				usedPercent: gemini3Flash.usedPercent,
				resetDescription: gemini3Flash.resetDescription,
				resetsAt: gemini3Flash.resetsAt,
			});
		}

		if (windows.length === 0) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No quota data", account: "pi-auth" };
		}

		return { provider: "antigravity", displayName: "Antigravity", windows, account: "pi-auth" };
	} catch (error) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: String(error), account: "pi-auth" };
	}
}

// ============================================================================
// Codex (OpenAI) Usage
// ============================================================================

interface CodexCredential {
	accessToken: string;
	accountId?: string;
	source: string;
}

function getPiCodexAuths(piAuth: any): Array<{ accessToken: string; accountId?: string; source: string }> {
	const results: Array<{ accessToken: string; accountId?: string; source: string }> = [];

	try {
		const codexKeys = Object.keys(piAuth).filter((k) => k.startsWith("openai-codex")).sort();

		for (const key of codexKeys) {
			const source = piAuth[key];
			if (!source) continue;

			let accessToken: string | undefined;
			let accountId: string | undefined;

			if (typeof source.access === "string") {
				accessToken = source.access;
				accountId = source.accountId;
			} else if (source.tokens?.access_token) {
				accessToken = source.tokens.access_token;
				accountId = source.tokens.account_id;
			}

			if (accessToken) {
				const label = key === "openai-codex" ? "pi" : `pi:${key.replace("openai-codex-", "")}`;
				results.push({ accessToken, accountId, source: label });
			}
		}
	} catch {}

	return results;
}

async function readCodexAuthFile(filePath: string): Promise<{ accessToken?: string; accountId?: string }> {
	try {
		await fs.promises.access(filePath);
		const data = JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
		if (data.tokens?.access_token) {
			return { accessToken: data.tokens.access_token, accountId: data.tokens.account_id };
		}
		if (typeof data.OPENAI_API_KEY === "string" && data.OPENAI_API_KEY) {
			return { accessToken: data.OPENAI_API_KEY };
		}
		return {};
	} catch {
		return {};
	}
}

async function discoverCodexCredentials(modelRegistry: any, piAuth: any): Promise<CodexCredential[]> {
	const credentials: CodexCredential[] = [];
	const seenTokens = new Set<string>();

	const piAuths = getPiCodexAuths(piAuth);
	for (const p of piAuths) {
		if (!seenTokens.has(p.accessToken)) {
			credentials.push({
				accessToken: p.accessToken,
				accountId: p.accountId,
				source: p.source,
			});
			seenTokens.add(p.accessToken);
		}
	}

	try {
		const registryToken = await modelRegistry?.authStorage?.getApiKey?.("openai-codex");
		if (registryToken && !seenTokens.has(registryToken)) {
			const cred = await modelRegistry?.authStorage?.get?.("openai-codex");
			const accountId = cred?.type === "oauth" ? cred.accountId : undefined;
			credentials.push({
				accessToken: registryToken,
				accountId,
				source: "registry",
			});
			seenTokens.add(registryToken);
		}
	} catch {}

	const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
	try {
		const stats = await fs.promises.stat(codexHome);
		if (stats.isDirectory()) {
			const files = await fs.promises.readdir(codexHome);
			const authFiles = files.filter((f) => /^auth([_-].+)?\.json$/i.test(f)).sort();

			for (const authFile of authFiles) {
				const authPath = path.join(codexHome, authFile);
				const auth = await readCodexAuthFile(authPath);

				if (!auth.accessToken || seenTokens.has(auth.accessToken)) {
					continue;
				}

				seenTokens.add(auth.accessToken);
				const nameMatch = authFile.match(/auth[_-]?(.+)?\.json/i);
				const suffix = nameMatch?.[1] || "auth";
				const label = `.codex:${suffix}`;
				credentials.push({ accessToken: auth.accessToken, accountId: auth.accountId, source: label });
			}
		}
	} catch {}

	return credentials;
}

async function fetchCodexUsageForCredential(cred: CodexCredential): Promise<UsageSnapshot> {
	const displayName = `Codex (${cred.source})`;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);

		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${cred.accessToken}`,
				"User-Agent": "CodexBar",
				Accept: "application/json",
			};

			if (cred.accountId) {
				headers["ChatGPT-Account-Id"] = cred.accountId;
			}

			const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
				method: "GET",
				headers,
				signal: controller.signal,
			});

			if (res.status === 401 || res.status === 403) {
				return { provider: "codex", displayName, windows: [], error: "Token expired", account: cred.source };
			}

			if (!res.ok) {
				return { provider: "codex", displayName, windows: [], error: `HTTP ${res.status}`, account: cred.source };
			}

			const data = (await res.json()) as any;
			const windows: RateWindow[] = [];

			if (data.rate_limit?.primary_window) {
				const pw = data.rate_limit.primary_window;
				const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
				const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
				const usedPercent = typeof pw.used_percent === "number" ? pw.used_percent : Number(pw.used_percent) || 0;
				windows.push({
					label: `${windowHours}h`,
					usedPercent,
					resetDescription: resetDate ? formatReset(resetDate) : undefined,
					resetsAt: resetDate,
				});
			}

			if (data.rate_limit?.secondary_window) {
				const sw = data.rate_limit.secondary_window;
				const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
				const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
				const label = windowHours >= 24 ? "Week" : `${windowHours}h`;
				const usedPercent = typeof sw.used_percent === "number" ? sw.used_percent : Number(sw.used_percent) || 0;
				windows.push({
					label,
					usedPercent,
					resetDescription: resetDate ? formatReset(resetDate) : undefined,
					resetsAt: resetDate,
				});
			}

			let plan = data.plan_type;
			if (data.credits?.balance !== undefined && data.credits.balance !== null) {
				const balance = typeof data.credits.balance === "number" ? data.credits.balance : parseFloat(data.credits.balance) || 0;
				plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
			}

			return { provider: "codex", displayName, windows, plan, account: cred.source };
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		return { provider: "codex", displayName, windows: [], error: String(error), account: cred.source };
	}
}

function usageFingerprint(snapshot: UsageSnapshot): string | null {
	if (snapshot.error || snapshot.windows.length === 0) {
		return null;
	}
	const parts = snapshot.windows.map((w) => {
		const pct = Number.isFinite(w.usedPercent) ? w.usedPercent.toFixed(2) : "NaN";
		const resetTs = w.resetsAt ? w.resetsAt.getTime() : "";
		return `${w.label}:${pct}:${resetTs}`;
	});
	return `${snapshot.displayName}|${parts.sort().join("|")}`;
}

export async function fetchAllCodexUsages(modelRegistry: any, piAuth: any = {}): Promise<UsageSnapshot[]> {
	const credentials = await discoverCodexCredentials(modelRegistry, piAuth);

	if (credentials.length === 0) {
		return [{ provider: "codex", displayName: "Codex", windows: [], error: "No credentials" }];
	}

	const results = await Promise.all(credentials.map((cred) => fetchCodexUsageForCredential(cred)));

	const seenFingerprints = new Set<string>();
	const deduplicated: UsageSnapshot[] = [];

	for (const result of results) {
		const fingerprint = usageFingerprint(result);
		if (fingerprint === null) {
			deduplicated.push(result);
		} else if (!seenFingerprints.has(fingerprint)) {
			seenFingerprints.add(fingerprint);
			deduplicated.push(result);
		}
	}

	return deduplicated;
}

// ============================================================================
// Kiro (AWS)
// ============================================================================

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

async function whichAsync(cmd: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`which ${cmd}`, { encoding: "utf-8" });
		return stdout.trim();
	} catch {
		return null;
	}
}

export async function fetchKiroUsage(): Promise<UsageSnapshot> {
	const kiroBinary = await whichAsync("kiro-cli");
	if (!kiroBinary) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: "kiro-cli not found", account: "cli" };
	}

	try {
		try {
			await execAsync("kiro-cli whoami", { timeout: 5000 });
		} catch {
			return { provider: "kiro", displayName: "Kiro", windows: [], error: "Not logged in", account: "cli" };
		}

		const { stdout: output } = await execAsync("kiro-cli chat --no-interactive /usage", {
			timeout: 10000,
			env: { ...process.env, TERM: "xterm-256color" },
		});

		const stripped = stripAnsi(output);
		const windows: RateWindow[] = [];

		let planName = "Kiro";
		const planMatch = stripped.match(/\|\s*(KIRO\s+\w+)/i);
		if (planMatch) {
			planName = planMatch[1].trim();
		}

		let creditsPercent = 0;
		// Be more specific to avoid matching random percentages
		const percentMatch = stripped.match(/(?:█+|[#=]+|Progress:?|Usage:?)\s*(\d+)%/i);
		if (percentMatch) {
			creditsPercent = parseInt(percentMatch[1], 10);
		}

		const creditsMatch = stripped.match(/(?:Credits|Usage|Quota):?\s*\(?(\d+\.?\d*)\s*(?:\/|of)\s*(\d+\.?\d*)\)?/i);
		if (creditsMatch) {
			const creditsUsed = parseFloat(creditsMatch[1]);
			const creditsTotal = parseFloat(creditsMatch[2]);
			if (!percentMatch && creditsTotal > 0) {
				creditsPercent = (creditsUsed / creditsTotal) * 100;
			}
		}

		let resetsAt: Date | undefined;
		const resetMatch = stripped.match(/resets\s+on\s+(\d{1,2}\/\d{1,2})/i);
		if (resetMatch) {
			const parts = resetMatch[1].split("/").map(Number);
			let month = parts[0];
			let day = parts[1];

			// Heuristic for DD/MM vs MM/DD
			if (month > 12) {
				// Must be DD/MM
				day = parts[0];
				month = parts[1];
			}

			const now = new Date();
			const year = now.getFullYear();
			const d = new Date(year, month - 1, day);
			if (!isNaN(d.getTime())) {
				resetsAt = d;
				// If date is in the past, assume it's next year
				if (resetsAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
					resetsAt.setFullYear(year + 1);
				}
			}
		}

		windows.push({
			label: "Credits",
			usedPercent: creditsPercent,
			resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
			resetsAt,
		});

		const bonusMatch = stripped.match(/Bonus\s*credits:?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
		if (bonusMatch) {
			const bonusUsed = parseFloat(bonusMatch[1]);
			const bonusTotal = parseFloat(bonusMatch[2]);
			const bonusPercent = bonusTotal > 0 ? (bonusUsed / bonusTotal) * 100 : 0;
			const expiryMatch = stripped.match(/expires\s+in\s+(\d+)\s+days?/i);
			windows.push({
				label: "Bonus",
				usedPercent: bonusPercent,
				resetDescription: expiryMatch ? `${expiryMatch[1]}d left` : undefined,
			});
		}

		return { provider: "kiro", displayName: "Kiro", windows, plan: planName, account: "cli" };
	} catch (error) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: String(error), account: "cli" };
	}
}

// ============================================================================
// z.ai
// ============================================================================

export async function fetchZaiUsage(piAuth: any = {}): Promise<UsageSnapshot> {
	let apiKey = process.env.Z_AI_API_KEY;

	if (!apiKey) {
		apiKey = piAuth["z-ai"]?.access || piAuth["zai"]?.access;
	}

	if (!apiKey) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: "No API key", account: "pi-auth" };
	}

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);

		try {
			const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});

			if (!res.ok) {
				return { provider: "zai", displayName: "z.ai", windows: [], error: `HTTP ${res.status}`, account: "pi-auth" };
			}

			const data = (await res.json()) as any;
			if (!data.success || data.code !== 200) {
				return { provider: "zai", displayName: "z.ai", windows: [], error: data.msg || "API error", account: "pi-auth" };
			}

			const windows: RateWindow[] = [];
			const limits = data.data?.limits || [];

			for (const limit of limits) {
				const percent = limit.percentage || 0;
				const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;

				let windowLabel = "Limit";
				// unit: 1=day, 3=hour, 5=minute
				if (limit.unit === 1) windowLabel = `${limit.number}d`;
				else if (limit.unit === 3) windowLabel = `${limit.number}h`;
				else if (limit.unit === 5) windowLabel = `${limit.number}m`;

				if (limit.type === "TOKENS_LIMIT") {
					windows.push({
						label: `Tokens (${windowLabel})`,
						usedPercent: percent,
						resetDescription: nextReset ? formatReset(nextReset) : undefined,
						resetsAt: nextReset,
					});
				} else if (limit.type === "TIME_LIMIT") {
					windows.push({
						label: "Monthly",
						usedPercent: percent,
						resetDescription: nextReset ? formatReset(nextReset) : undefined,
						resetsAt: nextReset,
					});
				}
			}

			const planName = data.data?.planName || data.data?.plan || undefined;
			return { provider: "zai", displayName: "z.ai", windows, plan: planName, account: "pi-auth" };
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: String(error), account: "pi-auth" };
	}
}

// ============================================================================
// Usage Aggregation
// ============================================================================

export async function fetchAllUsages(modelRegistry: any, disabledProviders: string[] = []): Promise<UsageSnapshot[]> {
	const disabled = new Set(disabledProviders.map(p => p.toLowerCase()));
	const piAuth = await loadPiAuth();
	
	const timeout = <T>(promise: Promise<T>, ms: number, fallback: T) => {
		let timer: NodeJS.Timeout;
		const timeoutPromise = new Promise<T>((resolve) => {
			timer = setTimeout(() => resolve(fallback), ms);
		});
		return Promise.race([promise, timeoutPromise]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};

	const fetchers: { provider: string; fetch: () => Promise<UsageSnapshot | UsageSnapshot[]> }[] = [
		{ provider: "anthropic", fetch: () => fetchClaudeUsage(piAuth) },
		{ provider: "copilot", fetch: () => fetchCopilotUsage(modelRegistry, piAuth) },
		{ provider: "gemini", fetch: () => fetchGeminiUsage(modelRegistry, piAuth) },
		{ provider: "codex", fetch: () => fetchAllCodexUsages(modelRegistry, piAuth) },
		{ provider: "antigravity", fetch: () => fetchAntigravityUsage(modelRegistry, piAuth) },
		{ provider: "kiro", fetch: () => fetchKiroUsage() },
		{ provider: "zai", fetch: () => fetchZaiUsage(piAuth) },
	];

	const activeFetchers = fetchers.filter(f => !disabled.has(f.provider));
	
	const results = await Promise.all(
		activeFetchers.map(f => 
			timeout(
				f.fetch(),
				6000,
				f.provider === "codex" 
					? [{ provider: f.provider, displayName: f.provider, windows: [], error: "Timeout" }]
					: { provider: f.provider, displayName: f.provider, windows: [], error: "Timeout" }
			)
		)
	);

	return results.flat() as UsageSnapshot[];
}
