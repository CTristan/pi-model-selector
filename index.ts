import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Import from modular sources
import type {
	MappingEntry,
	PriorityRule,
	UsageCandidate,
	LoadedConfig,
	WidgetConfig,
} from "./src/types.js";
import { notify, mappingKey, setGlobalConfig, writeDebugLog } from "./src/types.js";
import { fetchAllUsages } from "./src/usage-fetchers.js";
import {
	loadConfig,
	saveConfigFile,
	upsertMapping,
	updateWidgetConfig,
} from "./src/config.js";
import {
	buildCandidates,
	sortCandidates,
	selectionReason,
	findModelMapping,
	findIgnoreMapping,
	dedupeCandidates,
} from "./src/candidates.js";
import {
	updateWidgetState,
	getWidgetState,
	renderUsageWidget,
	clearWidget,
} from "./src/widget.js";

// Re-export for external use
export type { MappingEntry, PriorityRule, UsageCandidate, LoadedConfig, WidgetConfig };

// ============================================================================
// Helpers
// ============================================================================

function isProviderIgnored(provider: string, account: string | undefined, mappings: MappingEntry[]): boolean {
	const isCatchAll = (pattern: string) => {
		try {
			// A catch-all pattern is one that matches almost any string.
			// We test against several diverse strings to verify.
			const re = new RegExp(pattern);
			const testStrings = ["", "abc", "123", "Some Window", "---"];
			return testStrings.every(s => re.test(s));
		} catch {
			return false;
		}
	};

	return mappings.some(
		(m) =>
			m.usage.provider === provider &&
			(m.usage.account === undefined || m.usage.account === account) &&
			m.ignore === true &&
			((!m.usage.window && !m.usage.windowPattern) || 
			 (m.usage.windowPattern && isCatchAll(m.usage.windowPattern)))
	);
}

const priorityOptions: Array<{ label: string; value: PriorityRule[] }> = [
	{ label: "fullAvailability → remainingPercent → earliestReset", value: ["fullAvailability", "remainingPercent", "earliestReset"] },
	{ label: "fullAvailability → earliestReset → remainingPercent", value: ["fullAvailability", "earliestReset", "remainingPercent"] },
	{ label: "remainingPercent → fullAvailability → earliestReset", value: ["remainingPercent", "fullAvailability", "earliestReset"] },
	{ label: "remainingPercent → earliestReset → fullAvailability", value: ["remainingPercent", "earliestReset", "fullAvailability"] },
	{ label: "earliestReset → fullAvailability → remainingPercent", value: ["earliestReset", "fullAvailability", "remainingPercent"] },
	{ label: "earliestReset → remainingPercent → fullAvailability", value: ["earliestReset", "remainingPercent", "fullAvailability"] },
];

// ============================================================================
// Mapping Wizard
// ============================================================================

async function runMappingWizard(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "error", "Model selector configuration requires interactive mode.");
		return;
	}

	const config = await loadConfig(ctx, { requireMappings: false });
	if (!config) return;

	const locationLabels = [
		`Global (${config.sources.globalPath})`,
		`Project (${config.sources.projectPath})`,
	];

	let cachedCandidates: UsageCandidate[] | null = null;
	let cachedModels: Array<{ provider: string; id: string }> | null = null;

	const loadCandidates = async (): Promise<UsageCandidate[] | null> => {
		if (cachedCandidates) return cachedCandidates;
		const usages = await fetchAllUsages(ctx.modelRegistry, config.disabledProviders);
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
			await saveConfigFile(targetPath, targetRaw);
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
				["Map to model", "Map by pattern", "Ignore bucket"]
			);
			if (!actionChoice) return;

			let pattern: string | undefined;
			if (actionChoice === "Map by pattern") {
				pattern = await ctx.ui.input(`Enter regex pattern (e.g. ^${selectedCandidate.windowLabel}$)`);
				if (!pattern) return;
				try {
					new RegExp(pattern);
				} catch (e) {
					notify(ctx, "error", `Invalid regex: ${e}`);
					return;
				}
			}

			let selectedModel: { provider: string; id: string } | undefined;
			if (actionChoice === "Map to model" || actionChoice === "Map by pattern") {
				const modelChoice = await ctx.ui.select(
					`Select model for ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel}`,
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
						usage: {
							provider: selectedCandidate.provider,
							account: selectedCandidate.account,
							window: pattern ? undefined : selectedCandidate.windowLabel,
							windowPattern: pattern,
						},
						model: { provider: selectedModel.provider, id: selectedModel.id },
					}
				: {
						usage: {
							provider: selectedCandidate.provider,
							account: selectedCandidate.account,
							window: selectedCandidate.windowLabel,
						},
						ignore: true,
					};

			try {
				upsertMapping(targetRaw, mappingEntry);
				await saveConfigFile(targetPath, targetRaw);
			} catch (error) {
				notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
				return;
			}

			const key = mappingKey(mappingEntry);
			config.mappings = [...config.mappings.filter((entry) => mappingKey(entry) !== key), mappingEntry];

			const actionSummary = mappingEntry.ignore
				? `Ignored ${selectedCandidate.provider}/${selectedCandidate.windowLabel}.`
				: `Mapped ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel} to ${mappingEntry.model?.provider}/${mappingEntry.model?.id}.`;
			notify(ctx, "info", actionSummary);

			const addMore = await ctx.ui.confirm("Add another mapping?", "Do you want to map another usage bucket?");
			if (!addMore) continueMapping = false;
		}
	};

	const configureWidget = async (): Promise<void> => {
		const currentStatus = config.widget.enabled ? "enabled" : "disabled";
		const widgetChoice = await ctx.ui.select(
			`Usage widget (current: ${currentStatus})`,
			["Enable widget", "Disable widget", "Configure placement", "Configure count"]
		);
		if (!widgetChoice) return;

		let widgetUpdate: Partial<WidgetConfig> = {};

		if (widgetChoice === "Enable widget") {
			widgetUpdate.enabled = true;
		} else if (widgetChoice === "Disable widget") {
			widgetUpdate.enabled = false;
		} else if (widgetChoice === "Configure placement") {
			const placementChoice = await ctx.ui.select(
				`Widget placement (current: ${config.widget.placement})`,
				["Above editor", "Below editor"]
			);
			if (!placementChoice) return;
			widgetUpdate.placement = placementChoice === "Above editor" ? "aboveEditor" : "belowEditor";
		} else if (widgetChoice === "Configure count") {
			const countChoice = await ctx.ui.select(
				`Number of candidates to show (current: ${config.widget.showCount})`,
				["1", "2", "3", "4", "5"]
			);
			if (!countChoice) return;
			widgetUpdate.showCount = parseInt(countChoice, 10);
		}

		if (Object.keys(widgetUpdate).length === 0) return;

		const locationChoice = await ctx.ui.select("Save widget settings to", locationLabels);
		if (!locationChoice) return;

		const saveToProject = locationChoice === locationLabels[1];
		const targetRaw = saveToProject ? config.raw.project : config.raw.global;
		const targetPath = saveToProject ? config.sources.projectPath : config.sources.globalPath;

		try {
			updateWidgetConfig(targetRaw, widgetUpdate);
			await saveConfigFile(targetPath, targetRaw);
		} catch (error) {
			notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
			return;
		}

		// Update local config
		config.widget = { ...config.widget, ...widgetUpdate };
		notify(ctx, "info", `Widget settings updated.`);

		// Update widget state with new config if it exists
		const state = getWidgetState();
		if (state) {
			updateWidgetState({ ...state, config });
		}

		// Refresh widget display
		renderUsageWidget(ctx);
	};

	const configureDebugLog = async (): Promise<void> => {
		const currentLog = config.debugLog?.path || "model-selector.log";
		const currentStatus = config.debugLog?.enabled ? "enabled" : "disabled";
		
		const choice = await ctx.ui.select(`Debug logging (current: ${currentStatus}, path: ${currentLog})`, [
			config.debugLog?.enabled ? "Disable logging" : "Enable logging",
			"Change log file path",
		]);
		if (!choice) return;

		let debugUpdate: any = { ...config.debugLog };

		if (choice === "Enable logging") {
			debugUpdate.enabled = true;
		} else if (choice === "Disable logging") {
			debugUpdate.enabled = false;
		} else if (choice === "Change log file path") {
			const newPath = await ctx.ui.input("Enter log file path (relative to project or absolute)");
			if (!newPath) return;
			debugUpdate.path = newPath;
		}

		const locationChoice = await ctx.ui.select("Save debug log setting to", locationLabels);
		if (!locationChoice) return;

		const saveToProject = locationChoice === locationLabels[1];
		const targetRaw = saveToProject ? config.raw.project : config.raw.global;
		const targetPath = saveToProject ? config.sources.projectPath : config.sources.globalPath;

		try {
			targetRaw.debugLog = debugUpdate;
			await saveConfigFile(targetPath, targetRaw);
		} catch (error) {
			notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
			return;
		}

		// Reload config to apply path resolution
		const reloaded = await loadConfig(ctx, { requireMappings: false });
		if (reloaded) {
			config.debugLog = reloaded.debugLog;
			setGlobalConfig(reloaded);
		}
		
		notify(ctx, "info", `Debug logging ${config.debugLog?.enabled ? "enabled" : "disabled"}.`);
	};

	const configureAutoRun = async (): Promise<void> => {
		const currentStatus = config.autoRun ? "enabled" : "disabled";
		const choice = await ctx.ui.select(`Auto-run after every turn (current: ${currentStatus})`, [
			config.autoRun ? "Disable auto-run" : "Enable auto-run",
		]);
		if (!choice) return;

		const newValue = choice === "Enable auto-run";

		const locationChoice = await ctx.ui.select("Save auto-run setting to", locationLabels);
		if (!locationChoice) return;

		const saveToProject = locationChoice === locationLabels[1];
		const targetRaw = saveToProject ? config.raw.project : config.raw.global;
		const targetPath = saveToProject ? config.sources.projectPath : config.sources.globalPath;

		try {
			targetRaw.autoRun = newValue;
			await saveConfigFile(targetPath, targetRaw);
		} catch (error) {
			notify(ctx, "error", `Failed to write ${targetPath}: ${error}`);
			return;
		}

		config.autoRun = newValue;
		notify(ctx, "info", `Auto-run ${newValue ? "enabled" : "disabled"}.`);
	};

	const menuOptions = ["Edit mappings", "Configure priority", "Configure widget", "Configure auto-run", "Configure debug log", "Done"];

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

		if (action === "Configure widget") {
			await configureWidget();
			continue;
		}

		if (action === "Configure auto-run") {
			await configureAutoRun();
			continue;
		}

		if (action === "Configure debug log") {
			await configureDebugLog();
			continue;
		}
	}
}

// ============================================================================
// Extension Hook
// ============================================================================

export default function modelSelectorExtension(pi: ExtensionAPI) {
	let running = false;

	const runSelector = async (ctx: ExtensionContext, reason: "startup" | "command" | "auto", preloadedConfig?: LoadedConfig) => {
		if (running) {
			notify(ctx, "warning", "Model selector is already running.");
			return;
		}
		running = true;

		try {
			const config = preloadedConfig || (await loadConfig(ctx));
			if (!config) return;
			setGlobalConfig(config);
			writeDebugLog(`Running selector (reason: ${reason})`);

			const usages = await fetchAllUsages(ctx.modelRegistry, config.disabledProviders);

			for (const usage of usages) {
				if (usage.error && !isProviderIgnored(usage.provider, usage.account, config.mappings)) {
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
				clearWidget(ctx);
				return;
			}

			const rankedCandidates = sortCandidates(eligibleCandidates, config.priority);

			// Update widget with ranked candidates
			updateWidgetState({ candidates: rankedCandidates, config });
			renderUsageWidget(ctx);

			const best = rankedCandidates[0];
			if (!best) {
				notify(ctx, "error", "Unable to determine a best usage window.");
				return;
			}
			const runnerUp = rankedCandidates[1];

			const mapping = findModelMapping(best, config.mappings);
			if (!mapping || !mapping.model) {
				const usage: any = { provider: best.provider };
				if (best.account && best.account !== "none") {
					usage.account = best.account;
				}
				usage.window = best.windowLabel;

				const suggestedMapping = JSON.stringify(
					{
						usage,
						model: { provider: "<provider>", id: "<model-id>" },
					},
					null,
					2
				);
				const suggestedIgnore = JSON.stringify(
					{
						usage,
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

			const success = await pi.setModel(model);
			if (!success) {
				notify(ctx, "error", `Failed to set model to ${mapping.model.provider}/${mapping.model.id}. Check provider status or credentials.`);
				return;
			}

			const priorityLabel = config.priority.join(" → ");
			const reasonDetail = runnerUp ? selectionReason(best, runnerUp, config.priority) : "Only one candidate available";
			
			const baseMessage = isAlreadySelected 
				? `Model already set to ${mapping.model.provider}/${mapping.model.id}.`
				: `Selected ${mapping.model.provider}/${mapping.model.id}.`;
				
			const bucketInfo = `Using ${best.displayName} ${best.windowLabel} (${best.remainingPercent.toFixed(0)}% remaining).`;
			const selectionInfo = `Priority: ${priorityLabel}. Reason: ${reasonDetail}.`;

			notify(ctx, "info", `${baseMessage} ${bucketInfo} ${selectionInfo}`);
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

	pi.on("agent_end", async (_event, ctx) => {
		const config = await loadConfig(ctx, { requireMappings: false });
		if (config?.autoRun) {
			await runSelector(ctx, "auto", config);
		}
	});

	pi.registerCommand("model-select", {
		description: "Select the best starting model based on quota usage",
		handler: async (_args, ctx) => {
			await runSelector(ctx, "command");
		},
	});

	pi.registerCommand("model-select-config", {
		description: "Configure usage-to-model mappings and widget settings",
		handler: async (_args, ctx) => {
			await runMappingWizard(ctx);
		},
	});
}
