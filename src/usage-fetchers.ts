import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RateWindow, UsageSnapshot } from "./types.js";

// ============================================================================
// Utility Functions
// ============================================================================

export function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";

	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${hours % 24}h`;

	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

// ============================================================================
// Claude Usage
// ============================================================================

function loadClaudeAuthToken(): string | undefined {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
			if (data.anthropic?.access) return data.anthropic.access;
		}
	} catch {}
	return undefined;
}

function loadClaudeKeychainToken(): string | undefined {
	try {
		const keychainData = execSync(
			"security find-generic-password -s \"Claude Code-credentials\" -w 2>/dev/null",
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
		).trim();
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

export async function fetchClaudeUsage(): Promise<UsageSnapshot> {
	let token = loadClaudeAuthToken();
	let source = "auth.json";

	if (!token) {
		token = loadClaudeKeychainToken();
		source = "keychain";
	}

	if (!token) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: "No credentials" };
	}

	const doFetch = async (accessToken: string) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		return fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: controller.signal,
		});
	};

	try {
		let res = await doFetch(token);

		if ((res.status === 401 || res.status === 403) && source === "auth.json") {
			const keychainToken = loadClaudeKeychainToken();
			if (keychainToken && keychainToken !== token) {
				token = keychainToken;
				res = await doFetch(token);
			}
		}

		if (!res.ok) {
			return { provider: "anthropic", displayName: "Claude", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			const resetDate = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		if (data.seven_day?.utilization !== undefined) {
			const resetDate = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
			windows.push({
				label: "Week",
				usedPercent: data.seven_day.utilization,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
				resetsAt: resetDate,
			});
		}

		const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
		if (modelWindow?.utilization !== undefined) {
			windows.push({
				label: data.seven_day_sonnet ? "Sonnet" : "Opus",
				usedPercent: modelWindow.utilization,
			});
		}

		return { provider: "anthropic", displayName: "Claude", windows };
	} catch (error) {
		return { provider: "anthropic", displayName: "Claude", windows: [], error: String(error) };
	}
}

// ============================================================================
// Copilot Usage
// ============================================================================

function loadCopilotRefreshToken(): string | undefined {
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(authPath)) {
			const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			if (data["github-copilot"]?.refresh) return data["github-copilot"].refresh;
		}
	} catch {}

	return undefined;
}

export async function fetchCopilotUsage(_modelRegistry: any): Promise<UsageSnapshot> {
	const token = loadCopilotRefreshToken();
	if (!token) {
		return { provider: "copilot", displayName: "Copilot", windows: [], error: "No token" };
	}

	const headersBase = {
		"Editor-Version": "vscode/1.96.2",
		"User-Agent": "GitHubCopilotChat/0.26.7",
		"X-Github-Api-Version": "2025-04-01",
		Accept: "application/json",
	};

	const tryFetch = async (authHeader: string) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://api.github.com/copilot_internal/user", {
			headers: {
				...headersBase,
				Authorization: authHeader,
			},
			signal: controller.signal,
		});
		return res;
	};

	try {
		const attempts = [`token ${token}`];
		let lastStatus: number | undefined;
		let res: Response | undefined;

		for (const auth of attempts) {
			res = await tryFetch(auth);
			lastStatus = res.status;
			if (res.ok) break;
			if (res.status === 401 || res.status === 403) continue;
			break;
		}

		if (!res || !res.ok) {
			const status = lastStatus ?? 0;
			return { provider: "copilot", displayName: "Copilot", windows: [], error: `HTTP ${status}` };
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
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

		return {
			provider: "copilot",
			displayName: "Copilot",
			windows,
			plan: data.copilot_plan,
		};
	} catch (error) {
		return { provider: "copilot", displayName: "Copilot", windows: [], error: String(error) };
	}
}

// ============================================================================
// Token Refresh (shared)
// ============================================================================

export async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number } | null> {
	try {
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "947318989803-6bn6qk8qdgf4n4g3pfee6491hc0brc4i.apps.googleusercontent.com",
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}),
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
	}
}

// ============================================================================
// Gemini Usage
// ============================================================================

export async function fetchGeminiUsage(_modelRegistry: any): Promise<UsageSnapshot> {
	let token: string | undefined;
	let refreshToken: string | undefined;
	let projectId: string | undefined;

	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
			token = data["google-gemini-cli"]?.access;
			refreshToken = data["google-gemini-cli"]?.refresh;
			projectId = data["google-gemini-cli"]?.projectId || data["google-gemini-cli"]?.project_id;
		}
	} catch {}

	if (!token) {
		const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
		try {
			if (fs.existsSync(credPath)) {
				const data = JSON.parse(fs.readFileSync(credPath, "utf-8"));
				token = data.access_token;
				if (!projectId) projectId = data.project_id || data.projectId;
			}
		} catch {}
	}

	if (!token) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: "No credentials" };
	}

	const doFetch = async (accessToken: string) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		return fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ project: projectId }),
			signal: controller.signal,
		});
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
					if (fs.existsSync(credPath)) {
						const data = JSON.parse(fs.readFileSync(credPath, "utf-8"));
						if (data.access_token && data.access_token !== token) {
							const newToken: string = data.access_token;
							token = newToken;
							res = await doFetch(newToken);
						}
					}
				} catch {}
			}
		}

		if (!res.ok) {
			return { provider: "gemini", displayName: "Gemini", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		const quotas: Record<string, number> = {};

		for (const bucket of data.buckets || []) {
			const model = bucket.modelId || "unknown";
			const frac = bucket.remainingFraction ?? 1;
			if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
		}

		const windows: RateWindow[] = [];
		let proMin = 1;
		let flashMin = 1;
		let hasProModel = false;
		let hasFlashModel = false;

		for (const [model, frac] of Object.entries(quotas)) {
			if (model.toLowerCase().includes("pro")) {
				hasProModel = true;
				if (frac < proMin) proMin = frac;
			}
			if (model.toLowerCase().includes("flash")) {
				hasFlashModel = true;
				if (frac < flashMin) flashMin = frac;
			}
		}

		if (hasProModel) windows.push({ label: "Pro", usedPercent: (1 - proMin) * 100 });
		if (hasFlashModel) windows.push({ label: "Flash", usedPercent: (1 - flashMin) * 100 });

		return { provider: "gemini", displayName: "Gemini", windows };
	} catch (error) {
		return { provider: "gemini", displayName: "Gemini", windows: [], error: String(error) };
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

function loadAntigravityAuthFromPiAuthJson(): AntigravityAuth | undefined {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (!fs.existsSync(piAuthPath)) return undefined;
		const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));

		const cred = data["google-antigravity"] ?? data["antigravity"] ?? data["anti-gravity"];
		if (!cred) return undefined;

		const accessToken = typeof cred.access === "string" ? cred.access : undefined;
		if (!accessToken) return undefined;

		return {
			accessToken,
			refreshToken: typeof cred.refresh === "string" ? cred.refresh : undefined,
			expiresAt: typeof cred.expires === "number" ? cred.expires : undefined,
			projectId: typeof cred.projectId === "string" ? cred.projectId : typeof cred.project_id === "string" ? cred.project_id : undefined,
		};
	} catch {
		return undefined;
	}
}

async function loadAntigravityAuth(modelRegistry: any): Promise<AntigravityAuth | undefined> {
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

	const fromPi = loadAntigravityAuthFromPiAuthJson();
	if (fromPi) return fromPi;

	if (process.env.ANTIGRAVITY_API_KEY) {
		return { accessToken: process.env.ANTIGRAVITY_API_KEY };
	}

	return undefined;
}

export async function fetchAntigravityUsage(modelRegistry: any): Promise<UsageSnapshot> {
	const auth = await loadAntigravityAuth(modelRegistry);
	if (!auth?.accessToken) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No credentials" };
	}

	if (!auth.projectId) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Missing projectId" };
	}

	let accessToken = auth.accessToken;

	if (auth.refreshToken && auth.expiresAt && auth.expiresAt < Date.now() + 5 * 60 * 1000) {
		const refreshed = await refreshGoogleToken(auth.refreshToken);
		if (refreshed?.accessToken) accessToken = refreshed.accessToken;
	}

	const fetchModels = async (token: string): Promise<Response> => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		return fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
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
				const fallbackAuth = loadAntigravityAuthFromPiAuthJson();
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
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Unauthorized" };
		}

		if (!res.ok) {
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		const models: Record<string, any> = data.models || {};

		const getQuotaInfo = (modelKeys: string[]): { usedPercent: number; resetDescription?: string; resetsAt?: Date } | null => {
			for (const key of modelKeys) {
				const qi = models?.[key]?.quotaInfo;
				if (!qi) continue;
				const remainingFraction = typeof qi.remainingFraction === "number" ? qi.remainingFraction : 0;
				const usedPercent = Math.min(100, Math.max(0, (1 - remainingFraction) * 100));
				const resetTime = qi.resetTime ? new Date(qi.resetTime) : undefined;
				return {
					usedPercent,
					resetDescription: resetTime ? formatReset(resetTime) : undefined,
					resetsAt: resetTime,
				};
			}
			return null;
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
			return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No quota data" };
		}

		return { provider: "antigravity", displayName: "Antigravity", windows };
	} catch (error) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: String(error) };
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

function readAllPiCodexAuths(): Array<{ accessToken: string; accountId?: string; source: string }> {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	const results: Array<{ accessToken: string; accountId?: string; source: string }> = [];

	try {
		if (!fs.existsSync(piAuthPath)) return results;
		const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));

		const codexKeys = Object.keys(data).filter((k) => k.startsWith("openai-codex")).sort();

		for (const key of codexKeys) {
			const source = data[key];
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

function readCodexAuthFile(filePath: string): { accessToken?: string; accountId?: string } {
	try {
		if (!fs.existsSync(filePath)) return {};
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

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

async function discoverCodexCredentials(modelRegistry: any): Promise<CodexCredential[]> {
	const credentials: CodexCredential[] = [];
	const seenTokens = new Set<string>();

	const piAuths = readAllPiCodexAuths();
	for (const piAuth of piAuths) {
		if (!seenTokens.has(piAuth.accessToken)) {
			credentials.push({
				accessToken: piAuth.accessToken,
				accountId: piAuth.accountId,
				source: piAuth.source,
			});
			seenTokens.add(piAuth.accessToken);
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
		if (fs.existsSync(codexHome) && fs.statSync(codexHome).isDirectory()) {
			const files = fs.readdirSync(codexHome);
			const authFiles = files.filter((f) => /^auth([_-].+)?\.json$/i.test(f)).sort();

			for (const authFile of authFiles) {
				const authPath = path.join(codexHome, authFile);
				const auth = readCodexAuthFile(authPath);

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
		setTimeout(() => controller.abort(), 5000);

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
			return { provider: "codex", displayName, windows: [], error: "Token expired" };
		}

		if (!res.ok) {
			return { provider: "codex", displayName, windows: [], error: `HTTP ${res.status}` };
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

		return { provider: "codex", displayName, windows, plan };
	} catch (error) {
		return { provider: "codex", displayName, windows: [], error: String(error) };
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
	return parts.sort().join("|");
}

export async function fetchAllCodexUsages(modelRegistry: any): Promise<UsageSnapshot[]> {
	const credentials = await discoverCodexCredentials(modelRegistry);

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

function whichSync(cmd: string): string | null {
	try {
		return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

export async function fetchKiroUsage(): Promise<UsageSnapshot> {
	const kiroBinary = whichSync("kiro-cli");
	if (!kiroBinary) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: "kiro-cli not found" };
	}

	try {
		try {
			execSync("kiro-cli whoami", { encoding: "utf-8", timeout: 5000 });
		} catch {
			return { provider: "kiro", displayName: "Kiro", windows: [], error: "Not logged in" };
		}

		const output = execSync("kiro-cli chat --no-interactive /usage", {
			encoding: "utf-8",
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
		const percentMatch = stripped.match(/█+\s*(\d+)%/);
		if (percentMatch) {
			creditsPercent = parseInt(percentMatch[1], 10);
		}

		let creditsUsed = 0;
		let creditsTotal = 50;
		const creditsMatch = stripped.match(/\((\d+\.?\d*)\s+of\s+(\d+)\s+covered/);
		if (creditsMatch) {
			creditsUsed = parseFloat(creditsMatch[1]);
			creditsTotal = parseFloat(creditsMatch[2]);
			if (!percentMatch && creditsTotal > 0) {
				creditsPercent = (creditsUsed / creditsTotal) * 100;
			}
		}

		let resetsAt: Date | undefined;
		const resetMatch = stripped.match(/resets on (\d{2}\/\d{2})/);
		if (resetMatch) {
			const [month, day] = resetMatch[1].split("/").map(Number);
			const now = new Date();
			const year = now.getFullYear();
			resetsAt = new Date(year, month - 1, day);
			if (resetsAt < now) resetsAt.setFullYear(year + 1);
		}

		windows.push({
			label: "Credits",
			usedPercent: creditsPercent,
			resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
			resetsAt,
		});

		const bonusMatch = stripped.match(/Bonus credits:\s*(\d+\.?\d*)\/(\d+)/);
		if (bonusMatch) {
			const bonusUsed = parseFloat(bonusMatch[1]);
			const bonusTotal = parseFloat(bonusMatch[2]);
			const bonusPercent = bonusTotal > 0 ? (bonusUsed / bonusTotal) * 100 : 0;
			const expiryMatch = stripped.match(/expires in (\d+) days?/);
			windows.push({
				label: "Bonus",
				usedPercent: bonusPercent,
				resetDescription: expiryMatch ? `${expiryMatch[1]}d left` : undefined,
			});
		}

		return { provider: "kiro", displayName: "Kiro", windows, plan: planName };
	} catch (error) {
		return { provider: "kiro", displayName: "Kiro", windows: [], error: String(error) };
	}
}

// ============================================================================
// z.ai
// ============================================================================

export async function fetchZaiUsage(): Promise<UsageSnapshot> {
	let apiKey = process.env.Z_AI_API_KEY;

	if (!apiKey) {
		try {
			const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			if (fs.existsSync(authPath)) {
				const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
				apiKey = auth["z-ai"]?.access || auth["zai"]?.access;
			}
		} catch {}
	}

	if (!apiKey) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: "No API key" };
	}

	try {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5000);

		const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			return { provider: "zai", displayName: "z.ai", windows: [], error: `HTTP ${res.status}` };
		}

		const data = (await res.json()) as any;
		if (!data.success || data.code !== 200) {
			return { provider: "zai", displayName: "z.ai", windows: [], error: data.msg || "API error" };
		}

		const windows: RateWindow[] = [];
		const limits = data.data?.limits || [];

		for (const limit of limits) {
			const percent = limit.percentage || 0;
			const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;

			let windowLabel = "Limit";
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
		return { provider: "zai", displayName: "z.ai", windows, plan: planName };
	} catch (error) {
		return { provider: "zai", displayName: "z.ai", windows: [], error: String(error) };
	}
}

// ============================================================================
// Usage Aggregation
// ============================================================================

export async function fetchAllUsages(modelRegistry: any): Promise<UsageSnapshot[]> {
	const timeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
		Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

	const [claude, copilot, gemini, codexResults, antigravity, kiro, zai] = await Promise.all([
		timeout(fetchClaudeUsage(), 6000, { provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" }),
		timeout(fetchCopilotUsage(modelRegistry), 6000, { provider: "copilot", displayName: "Copilot", windows: [], error: "Timeout" }),
		timeout(fetchGeminiUsage(modelRegistry), 6000, { provider: "gemini", displayName: "Gemini", windows: [], error: "Timeout" }),
		timeout(fetchAllCodexUsages(modelRegistry), 6000, [{ provider: "codex", displayName: "Codex", windows: [], error: "Timeout" }]),
		timeout(fetchAntigravityUsage(modelRegistry), 6000, { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Timeout" }),
		timeout(fetchKiroUsage(), 6000, { provider: "kiro", displayName: "Kiro", windows: [], error: "Timeout" }),
		timeout(fetchZaiUsage(), 6000, { provider: "zai", displayName: "z.ai", windows: [], error: "Timeout" }),
	]);

	return [claude, copilot, gemini, ...codexResults, antigravity, kiro, zai];
}
