import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_CONFIG_PATH = path.join(EXTENSION_DIR, "config", "model-selector.json");

// ============================================================================
// Types
// ============================================================================

interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetsAt?: Date;
}

interface UsageSnapshot {
	provider: string;
	displayName: string;
	windows: RateWindow[];
	plan?: string;
	error?: string;
}

interface UsageMappingKey {
	provider: string;
	window?: string;
	windowPattern?: string;
}

interface ModelMappingTarget {
	provider: string;
	id: string;
}

interface MappingEntry {
	usage: UsageMappingKey;
	model?: ModelMappingTarget;
	ignore?: boolean;
}

type PriorityRule = "fullAvailability" | "remainingPercent" | "earliestReset";

interface ModelSelectorConfig {
	mappings: MappingEntry[];
	priority?: PriorityRule[];
}

interface UsageCandidate {
	provider: string;
	displayName: string;
	windowLabel: string;
	usedPercent: number;
	remainingPercent: number;
	resetsAt?: Date;
}

// ============================================================================
// Config Loading
// ============================================================================

function notify(ctx: ExtensionContext, level: "info" | "warning" | "error", message: string) {
	const prefixedMessage = `[model-selector] ${message}`;
	if (ctx.hasUI) {
		ctx.ui.notify(prefixedMessage, level);
		return;
	}
	if (level === "error") {
		console.error(prefixedMessage);
	} else if (level === "warning") {
		console.warn(prefixedMessage);
	} else {
		console.log(prefixedMessage);
	}
}

const DEFAULT_PRIORITY: PriorityRule[] = ["fullAvailability", "remainingPercent", "earliestReset"];

function readConfigFile(filePath: string, errors: string[]): Record<string, any> | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push(`Failed to read ${filePath}: expected a JSON object`);
			return null;
		}
		return parsed as Record<string, any>;
	} catch (error) {
		errors.push(`Failed to read ${filePath}: ${error}`);
		return null;
	}
}

function asConfigShape(raw: Record<string, any>): ModelSelectorConfig {
	return {
		mappings: Array.isArray(raw.mappings) ? (raw.mappings as MappingEntry[]) : [],
		priority: Array.isArray(raw.priority) ? (raw.priority as PriorityRule[]) : undefined,
	};
}

function normalizePriority(raw: ModelSelectorConfig | null, sourceLabel: string, errors: string[]): PriorityRule[] | undefined {
	if (!raw || raw.priority === undefined) return undefined;
	if (!Array.isArray(raw.priority) || raw.priority.length === 0) {
		errors.push(`[${sourceLabel}] priority must be a non-empty array`);
		return undefined;
	}

	const allowed = new Set<PriorityRule>(["fullAvailability", "remainingPercent", "earliestReset"]);
	const seen = new Set<string>();
	const normalized: PriorityRule[] = [];

	for (const value of raw.priority) {
		if (!allowed.has(value)) {
			errors.push(`[${sourceLabel}] priority contains invalid value: ${value}`);
			continue;
		}
		if (!seen.has(value)) {
			seen.add(value);
			normalized.push(value);
		}
	}

	if (normalized.length === 0) {
		errors.push(`[${sourceLabel}] priority must include at least one of remainingPercent or earliestReset`);
		return undefined;
	}

	return normalized;
}

function normalizeMappings(raw: ModelSelectorConfig | null, sourceLabel: string, errors: string[]): MappingEntry[] {
	if (!raw || !Array.isArray(raw.mappings)) return [];
	const mappings: MappingEntry[] = [];

	raw.mappings.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") {
			errors.push(`[${sourceLabel}] mapping #${index + 1} is not an object`);
			return;
		}

		const usage = (entry as MappingEntry).usage;
		const model = (entry as MappingEntry).model;
		const ignore = (entry as MappingEntry).ignore === true;

		if (!usage || typeof usage.provider !== "string" || usage.provider.trim() === "") {
			errors.push(`[${sourceLabel}] mapping #${index + 1} has invalid usage.provider`);
			return;
		}
		if (usage.window !== undefined && typeof usage.window !== "string") {
			errors.push(`[${sourceLabel}] mapping #${index + 1} has invalid usage.window`);
			return;
		}
		if (usage.windowPattern !== undefined && typeof usage.windowPattern !== "string") {
			errors.push(`[${sourceLabel}] mapping #${index + 1} has invalid usage.windowPattern`);
			return;
		}

		if (ignore && model) {
			errors.push(`[${sourceLabel}] mapping #${index + 1} cannot specify both ignore:true and model`);
			return;
		}
		if (model !== undefined) {
			if (typeof model.provider !== "string" || model.provider.trim() === "" || typeof model.id !== "string" || model.id.trim() === "") {
				errors.push(`[${sourceLabel}] mapping #${index + 1} has invalid model.provider/model.id`);
				return;
			}
		} else if (!ignore) {
			errors.push(`[${sourceLabel}] mapping #${index + 1} is missing model or ignore:true`);
			return;
		}

		if (usage.windowPattern) {
			try {
				new RegExp(usage.windowPattern);
			} catch (error) {
				errors.push(`[${sourceLabel}] mapping #${index + 1} has invalid usage.windowPattern regex: ${error}`);
				return;
			}
		}

		mappings.push({
			usage: {
				provider: usage.provider,
				window: usage.window,
				windowPattern: usage.windowPattern,
			},
			model: model
				? {
					provider: model.provider,
					id: model.id,
				}
				: undefined,
			ignore,
		});
	});

	return mappings;
}

function mappingKey(entry: MappingEntry): string {
	return `${entry.usage.provider}|${entry.usage.window ?? ""}|${entry.usage.windowPattern ?? ""}`;
}

function mergeMappings(globalMappings: MappingEntry[], projectMappings: MappingEntry[]): MappingEntry[] {
	const merged = new Map<string, MappingEntry>();
	for (const mapping of globalMappings) {
		merged.set(mappingKey(mapping), mapping);
	}
	for (const mapping of projectMappings) {
		merged.set(mappingKey(mapping), mapping);
	}
	return Array.from(merged.values());
}

function loadConfig(
	ctx: ExtensionContext,
	options: { requireMappings?: boolean } = {}
): {
	mappings: MappingEntry[];
	priority: PriorityRule[];
	sources: { globalPath: string; projectPath: string };
	raw: { global: Record<string, any>; project: Record<string, any> };
} | null {
	const errors: string[] = [];
	const requireMappings = options.requireMappings ?? true;
	const projectPath = path.join(ctx.cwd, ".pi", "model-selector.json");

	const globalRaw = readConfigFile(GLOBAL_CONFIG_PATH, errors) ?? { mappings: [] };
	const projectRaw = readConfigFile(projectPath, errors) ?? { mappings: [] };

	const globalConfig = asConfigShape(globalRaw);
	const projectConfig = asConfigShape(projectRaw);

	const globalMappings = normalizeMappings(globalConfig, GLOBAL_CONFIG_PATH, errors);
	const projectMappings = normalizeMappings(projectConfig, projectPath, errors);
	const globalPriority = normalizePriority(globalConfig, GLOBAL_CONFIG_PATH, errors);
	const projectPriority = normalizePriority(projectConfig, projectPath, errors);

	if (errors.length > 0) {
		notify(ctx, "error", errors.join("\n"));
		return null;
	}

	const mappings = mergeMappings(globalMappings, projectMappings);
	if (requireMappings && mappings.length === 0) {
		notify(
			ctx,
			"error",
			`No model selector mappings found. Add mappings to ${GLOBAL_CONFIG_PATH} or ${projectPath}, or run /model-select-config.`
		);
		return null;
	}

	return {
		mappings,
		priority: projectPriority ?? globalPriority ?? DEFAULT_PRIORITY,
		sources: { globalPath: GLOBAL_CONFIG_PATH, projectPath },
		raw: { global: globalRaw, project: projectRaw },
	};
}

// ============================================================================
// Usage Fetchers (copied from usage-bar.ts)
// ============================================================================

function formatReset(date: Date): string {
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

// --------------------------------------------------------------------------
// Claude Usage
// --------------------------------------------------------------------------

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

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
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

// --------------------------------------------------------------------------
// Copilot Usage
// --------------------------------------------------------------------------

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

async function fetchCopilotUsage(_modelRegistry: any): Promise<UsageSnapshot> {
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

// --------------------------------------------------------------------------
// Gemini Usage
// --------------------------------------------------------------------------

async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number } | null> {
	try {
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "947318989803-6bn6qk8qdgf4n4g3pfee6491hc0brc4i.apps.googleusercontent.com", // Common Google Cloud SDK client ID
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

async function fetchGeminiUsage(_modelRegistry: any): Promise<UsageSnapshot> {
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

	// If no token from auth.json, try direct credential file
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

		if ((res.status === 401 || res.status === 403)) {
			let refreshed = false;

			// 1. Try refreshing using refresh token from auth.json
			if (refreshToken) {
				const newData = await refreshGoogleToken(refreshToken);
				if (newData?.accessToken) {
					token = newData.accessToken;
					res = await doFetch(token);
					refreshed = true;
				}
			}

			// 2. If still failing, try loading fresh token from .gemini/oauth_creds.json
			if (!refreshed || (res.status === 401 || res.status === 403)) {
				const credPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
				try {
					if (fs.existsSync(credPath)) {
						const data = JSON.parse(fs.readFileSync(credPath, "utf-8"));
						if (data.access_token && data.access_token !== token) {
							token = data.access_token;
							res = await doFetch(token);
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

// --------------------------------------------------------------------------
// Antigravity Usage
// --------------------------------------------------------------------------

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

async function refreshAntigravityAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number } | null> {
	return refreshGoogleToken(refreshToken);
}

async function fetchAntigravityUsage(modelRegistry: any): Promise<UsageSnapshot> {
	const auth = await loadAntigravityAuth(modelRegistry);
	if (!auth?.accessToken) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "No credentials" };
	}

	if (!auth.projectId) {
		return { provider: "antigravity", displayName: "Antigravity", windows: [], error: "Missing projectId" };
	}

	let accessToken = auth.accessToken;

	if (auth.refreshToken && auth.expiresAt && auth.expiresAt < Date.now() + 5 * 60 * 1000) {
		const refreshed = await refreshAntigravityAccessToken(auth.refreshToken);
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

			// 1. Try refreshing with current auth's refresh token
			if (auth.refreshToken) {
				const refreshedToken = await refreshAntigravityAccessToken(auth.refreshToken);
				if (refreshedToken?.accessToken) {
					accessToken = refreshedToken.accessToken;
					res = await fetchModels(accessToken);
					refreshed = true;
				}
			}

			// 2. Fallback: If still 401, try loading directly from auth.json (in case registry token was stale/partial)
			if (!refreshed || res.status === 401 || res.status === 403) {
				const fallbackAuth = loadAntigravityAuthFromPiAuthJson();
				if (fallbackAuth && (fallbackAuth.accessToken !== auth.accessToken || fallbackAuth.refreshToken)) {
					let fallbackToken = fallbackAuth.accessToken;
					
					// Pre-emptively refresh the fallback token if we have a refresh token
					if (fallbackAuth.refreshToken) {
						const refreshedFallback = await refreshAntigravityAccessToken(fallbackAuth.refreshToken);
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

// --------------------------------------------------------------------------
// Codex (OpenAI) Usage
// --------------------------------------------------------------------------

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

async function fetchAllCodexUsages(modelRegistry: any): Promise<UsageSnapshot[]> {
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

// --------------------------------------------------------------------------
// Kiro (AWS)
// --------------------------------------------------------------------------

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

async function fetchKiroUsage(): Promise<UsageSnapshot> {
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

// --------------------------------------------------------------------------
// z.ai
// --------------------------------------------------------------------------

async function fetchZaiUsage(): Promise<UsageSnapshot> {
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

async function fetchAllUsages(modelRegistry: any): Promise<UsageSnapshot[]> {
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

// ============================================================================
// Selection Logic
// ============================================================================

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return NaN;
	return Math.max(0, Math.min(100, value));
}

function buildCandidates(usages: UsageSnapshot[]): UsageCandidate[] {
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

function compareCandidates(
	a: UsageCandidate,
	b: UsageCandidate,
	priority: PriorityRule[],
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

function pickBestCandidate(candidates: UsageCandidate[], priority: PriorityRule[]): UsageCandidate | null {
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

function sortCandidates(candidates: UsageCandidate[], priority: PriorityRule[]): UsageCandidate[] {
	return [...candidates].sort((a, b) => {
		const diff = compareByPriority(a, b, priority);
		if (diff === 0) return 0;
		return diff > 0 ? -1 : 1;
	});
}

function selectionReason(best: UsageCandidate, runnerUp: UsageCandidate | undefined, priority: PriorityRule[]): string {
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

function findModelMapping(candidate: UsageCandidate, mappings: MappingEntry[]): MappingEntry | undefined {
	return findMappingBy(candidate, mappings, (mapping) => !mapping.ignore && !!mapping.model);
}

function findIgnoreMapping(candidate: UsageCandidate, mappings: MappingEntry[]): MappingEntry | undefined {
	return findMappingBy(candidate, mappings, (mapping) => mapping.ignore === true);
}

function candidateKey(candidate: UsageCandidate): string {
	return `${candidate.provider}|${candidate.windowLabel}`;
}

function dedupeCandidates(candidates: UsageCandidate[]): UsageCandidate[] {
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

function upsertMapping(raw: Record<string, any>, mapping: MappingEntry): void {
	const existing = Array.isArray(raw.mappings) ? raw.mappings : [];
	const targetKey = mappingKey(mapping);
	const filtered = existing.filter((entry: any) => {
		const usage = entry?.usage ?? {};
		const entryKey = `${usage.provider ?? ""}|${usage.window ?? ""}|${usage.windowPattern ?? ""}`;
		return entryKey !== targetKey;
	});
	raw.mappings = [...filtered, mapping];
}

function saveConfigFile(filePath: string, raw: Record<string, any>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

async function runMappingWizard(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "error", "Model selector configuration requires interactive mode.");
		return;
	}

	const config = loadConfig(ctx, { requireMappings: false });
	if (!config) return;

	const locationLabels = [
		`Global (${config.sources.globalPath})`,
		`Project (${config.sources.projectPath})`,
	];
	const priorityOptions: Array<{ label: string; value: PriorityRule[] }> = [
		{ label: "fullAvailability → remainingPercent → earliestReset", value: ["fullAvailability", "remainingPercent", "earliestReset"] },
		{ label: "fullAvailability → earliestReset → remainingPercent", value: ["fullAvailability", "earliestReset", "remainingPercent"] },
		{ label: "remainingPercent → fullAvailability → earliestReset", value: ["remainingPercent", "fullAvailability", "earliestReset"] },
		{ label: "remainingPercent → earliestReset → fullAvailability", value: ["remainingPercent", "earliestReset", "fullAvailability"] },
		{ label: "earliestReset → fullAvailability → remainingPercent", value: ["earliestReset", "fullAvailability", "remainingPercent"] },
		{ label: "earliestReset → remainingPercent → fullAvailability", value: ["earliestReset", "remainingPercent", "fullAvailability"] },
	];

	let cachedCandidates: UsageCandidate[] | null = null;
	let cachedModels: Array<{ provider: string; id: string }> | null = null;

	const loadCandidates = async (): Promise<UsageCandidate[] | null> => {
		if (cachedCandidates) return cachedCandidates;
		const usages = await fetchAllUsages(ctx.modelRegistry);
		const candidates = dedupeCandidates(buildCandidates(usages));
		if (candidates.length === 0) {
			notify(ctx, "error", "No usage windows found. Check provider credentials and connectivity.");
			return null;
		}
		cachedCandidates = candidates;
		return candidates;
	};

	const loadModels = async (): Promise<Array<{ provider: string; id: string }> | null> => {
		if (cachedModels) return cachedModels;
		try {
			const availableModels = await ctx.modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				notify(ctx, "error", "No available models found. Ensure API keys are configured.");
				return null;
			}
			cachedModels = availableModels;
			return availableModels;
		} catch (error) {
			notify(ctx, "error", `Failed to load available models: ${error}`);
			return null;
		}
	};

	const configurePriority = async (): Promise<void> => {
		const currentPriority = config.priority.join(" → ");
		const priorityLabels = priorityOptions.map((option) => option.label);
		const priorityChoice = await ctx.ui.select(
			`Select priority order (current: ${currentPriority})`,
			priorityLabels
		);
		if (!priorityChoice) return;

		const priorityIndex = priorityLabels.indexOf(priorityChoice);
		if (priorityIndex < 0) return;
		const selectedPriority = priorityOptions[priorityIndex].value;

		const priorityLocation = await ctx.ui.select("Save priority to", locationLabels);
		if (!priorityLocation) return;

		const saveToProject = priorityLocation === locationLabels[1];
		const targetRaw = saveToProject ? config.raw.project : config.raw.global;
		const targetPath = saveToProject ? config.sources.projectPath : config.sources.globalPath;

		try {
			targetRaw.priority = selectedPriority;
			saveConfigFile(targetPath, targetRaw);
		} catch (error) {
			notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
			return;
		}

		config.priority = selectedPriority;
		notify(ctx, "info", `Priority updated: ${selectedPriority.join(" → ")}.`);
	};

	const configureMappings = async (): Promise<void> => {
		const candidates = await loadCandidates();
		if (!candidates) return;
		const availableModels = await loadModels();
		if (!availableModels) return;

		const sortedCandidates = [...candidates].sort((a, b) => {
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.windowLabel.localeCompare(b.windowLabel);
		});

		const modelLabels = availableModels.map((model) => `${model.provider}/${model.id}`);

		let continueMapping = true;
		while (continueMapping) {
			const optionLabels = sortedCandidates.map((candidate) => {
				const ignored = findIgnoreMapping(candidate, config.mappings);
				const mapping = findModelMapping(candidate, config.mappings);
				const mappingLabel = ignored
					? "ignored"
					: mapping
					? `mapped: ${mapping.model?.provider}/${mapping.model?.id}`
					: "unmapped";
				return `${candidate.provider}/${candidate.windowLabel} (${candidate.remainingPercent.toFixed(0)}% remaining, ${candidate.displayName}) [${mappingLabel}]`;
			});

			const selectedLabel = await ctx.ui.select("Select a usage bucket to map", optionLabels);
			if (!selectedLabel) return;

			const selectedIndex = optionLabels.indexOf(selectedLabel);
			if (selectedIndex < 0) return;
			const selectedCandidate = sortedCandidates[selectedIndex];

			const actionChoice = await ctx.ui.select(
				`Select action for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}`,
				["Map to model", "Ignore bucket"]
			);
			if (!actionChoice) return;

			let selectedModel: { provider: string; id: string } | undefined;
			if (actionChoice === "Map to model") {
				const modelChoice = await ctx.ui.select(
					`Select model for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}`,
					modelLabels
				);
				if (!modelChoice) return;

				const modelIndex = modelLabels.indexOf(modelChoice);
				if (modelIndex < 0) return;
				selectedModel = availableModels[modelIndex];
			}

			const locationChoice = await ctx.ui.select("Save mapping to", locationLabels);
			if (!locationChoice) return;

			const saveToProject = locationChoice === locationLabels[1];
			const targetRaw = saveToProject ? config.raw.project : config.raw.global;
			const targetPath = saveToProject ? config.sources.projectPath : config.sources.globalPath;

			const mappingEntry: MappingEntry = selectedModel
				? {
						usage: { provider: selectedCandidate.provider, window: selectedCandidate.windowLabel },
						model: { provider: selectedModel.provider, id: selectedModel.id },
					}
				: {
						usage: { provider: selectedCandidate.provider, window: selectedCandidate.windowLabel },
						ignore: true,
					};

			try {
				upsertMapping(targetRaw, mappingEntry);
				saveConfigFile(targetPath, targetRaw);
			} catch (error) {
				notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
				return;
			}

			const key = mappingKey(mappingEntry);
			config.mappings = [...config.mappings.filter((entry) => mappingKey(entry) !== key), mappingEntry];

			const actionSummary = mappingEntry.ignore
				? `Ignored ${selectedCandidate.provider}/${selectedCandidate.windowLabel}.`
				: `Mapped ${selectedCandidate.provider}/${selectedCandidate.windowLabel} to ${mappingEntry.model?.provider}/${mappingEntry.model?.id}.`;
			notify(ctx, "info", actionSummary);

			const addMore = await ctx.ui.confirm("Add another mapping?", "Do you want to map another usage bucket?");
			if (!addMore) continueMapping = false;
		}
	};

	const menuOptions = ["Edit mappings", "Configure priority", "Done"];

	while (true) {
		const action = await ctx.ui.select("Model selector configuration", menuOptions);
		if (!action || action === "Done") return;

		if (action === "Configure priority") {
			await configurePriority();
			continue;
		}

		if (action === "Edit mappings") {
			await configureMappings();
			continue;
		}
	}
}

function isAuthError(error: string): boolean {
	const lower = error.toLowerCase();
	return (
		lower.includes("401") ||
		lower.includes("403") ||
		lower.includes("unauthorized") ||
		lower.includes("token expired") ||
		lower.includes("invalid token") ||
		lower.includes("not logged in")
	);
}

function isProviderIgnored(provider: string, mappings: MappingEntry[]): boolean {
	return mappings.some(
		(m) =>
			m.usage.provider === provider &&
			m.ignore === true &&
			((!m.usage.window && !m.usage.windowPattern) || m.usage.windowPattern === ".*" || m.usage.windowPattern === "^.*$")
	);
}

// ============================================================================
// Extension Hook
// ============================================================================

export default function modelSelectorExtension(pi: ExtensionAPI) {
	let running = false;

	const runSelector = async (ctx: ExtensionContext, reason: "startup" | "command") => {
		if (running) {
			notify(ctx, "warning", "Model selector is already running.");
			return;
		}
		running = true;

		try {
			const config = loadConfig(ctx);
			if (!config) return;

			const usages = await fetchAllUsages(ctx.modelRegistry);

			for (const usage of usages) {
				if (usage.error && isAuthError(usage.error) && !isProviderIgnored(usage.provider, config.mappings)) {
					notify(ctx, "warning", `Usage check failed for ${usage.displayName}: ${usage.error}`);
				}
			}

			const candidates = buildCandidates(usages);
			const eligibleCandidates = candidates.filter((candidate) => !findIgnoreMapping(candidate, config.mappings));

			if (eligibleCandidates.length === 0) {
				const detail = candidates.length === 0
					? "No usage windows found. Check provider credentials and connectivity."
					: "All usage buckets are ignored. Remove an ignore mapping or add a model mapping.";
				notify(ctx, "error", detail);
				return;
			}

			const rankedCandidates = sortCandidates(eligibleCandidates, config.priority);
			const best = rankedCandidates[0];
			if (!best) {
				notify(ctx, "error", "Unable to determine a best usage window.");
				return;
			}
			const runnerUp = rankedCandidates[1];

			const mapping = findModelMapping(best, config.mappings);
			if (!mapping || !mapping.model) {
				const suggestedMapping = JSON.stringify(
					{
						usage: { provider: best.provider, window: best.windowLabel },
						model: { provider: "<provider>", id: "<model-id>" },
					},
					null,
					2
				);
				const suggestedIgnore = JSON.stringify(
					{
						usage: { provider: best.provider, window: best.windowLabel },
						ignore: true,
					},
					null,
					2
				);
				notify(
					ctx,
					"error",
					`No model mapping for best usage bucket ${best.provider}/${best.windowLabel} (${best.remainingPercent.toFixed(0)}% remaining, ${best.displayName}).\nAdd a mapping to ${config.sources.projectPath} or ${config.sources.globalPath}:\n${suggestedMapping}\n\nOr ignore this bucket:\n${suggestedIgnore}`
				);
				return;
			}

			const model = ctx.modelRegistry.find(mapping.model.provider, mapping.model.id);
			if (!model) {
				notify(ctx, "error", `Mapped model not found: ${mapping.model.provider}/${mapping.model.id}.`);
				return;
			}

			const current = ctx.model;
			const isAlreadySelected =
				current && current.provider === mapping.model.provider && current.id === mapping.model.id;
			if (isAlreadySelected && reason === "command") {
				notify(ctx, "info", `Model already set to ${mapping.model.provider}/${mapping.model.id}.`);
			}

			const success = await pi.setModel(model);
			if (!success) {
				notify(ctx, "error", `No API key available for ${mapping.model.provider}/${mapping.model.id}.`);
				return;
			}

			const priorityLabel = config.priority.join(" → ");
			const reasonDetail = selectionReason(best, runnerUp, config.priority);
			if (isAlreadySelected) {
				const message = `Model already set to ${mapping.model.provider}/${mapping.model.id}. Selected bucket: ${best.displayName} ${best.windowLabel} (${best.remainingPercent.toFixed(0)}% remaining). Priority: ${priorityLabel}. Reason: ${reasonDetail}.`;
				notify(ctx, "info", message);
				return;
			}

			const baseMessage = `Selected ${mapping.model.provider}/${mapping.model.id} using ${best.displayName} ${best.windowLabel} (${best.remainingPercent.toFixed(0)}% remaining).`;
			const detail = `Priority: ${priorityLabel}. Reason: ${reasonDetail}.`;

			if (reason === "startup") {
				notify(ctx, "info", `${baseMessage} ${detail}`);
				return;
			}

			notify(ctx, "info", `${baseMessage} ${detail}`);
		} finally {
			running = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await runSelector(ctx, "startup");
	});

	pi.on("session_switch", async (event, ctx) => {
		if (event.reason === "new") {
			await runSelector(ctx, "startup");
		}
	});

	pi.registerCommand("model-select", {
		description: "Select the best starting model based on quota usage",
		handler: async (_args, ctx) => {
			await runSelector(ctx, "command");
		},
	});

	pi.registerCommand("model-select-config", {
		description: "Configure usage-to-model mappings",
		handler: async (_args, ctx) => {
			await runMappingWizard(ctx);
		},
	});
}
