import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import from modular sources
import type {
  LoadedConfig,
  MappingEntry,
  PriorityRule,
  ProviderName,
  UsageCandidate,
  UsageMappingKey,
  UsageSnapshot,
  WidgetConfig,
} from "./src/types.js";
import {
  ALL_PROVIDERS,
  notify,
  setGlobalConfig,
  writeDebugLog,
} from "./src/types.js";
import { fetchAllUsages, loadPiAuth } from "./src/usage-fetchers.js";
import {
  loadConfig,
  saveConfigFile,
  updateWidgetConfig,
  upsertMapping,
  removeMapping,
  getRawMappings,
} from "./src/config.js";
import {
  buildCandidates,
  candidateKey,
  dedupeCandidates,
  findIgnoreMapping,
  findModelMapping,
  selectionReason,
  sortCandidates,
} from "./src/candidates.js";
import {
  clearWidget,
  getWidgetState,
  renderUsageWidget,
  updateWidgetState,
} from "./src/widget.js";

// Re-export for external use
export type {
  MappingEntry,
  PriorityRule,
  UsageCandidate,
  LoadedConfig,
  WidgetConfig,
};

// ============================================================================
// Helpers
// ============================================================================

const CATCH_ALL_PATTERNS = ["*", ".*", "^.*$", "^.*", ".*$", ".+", "^.+$"];

function isCatchAllIgnoreMapping(m: MappingEntry): boolean {
  const { usage } = m,
    hasWindow =
      usage.window !== undefined &&
      usage.window !== null &&
      usage.window !== "",
    hasWindowPattern =
      usage.windowPattern !== undefined &&
      usage.windowPattern !== null &&
      usage.windowPattern !== "";

  if (!hasWindow && !hasWindowPattern) {
    return true;
  }

  if (usage.windowPattern) {
    if (CATCH_ALL_PATTERNS.includes(usage.windowPattern)) {
      return true;
    }
  }

  return false;
}

function isProviderIgnored(
  provider: string,
  account: string | undefined,
  mappings: MappingEntry[],
): boolean {
  return mappings.some(
    (m) =>
      m.usage.provider === provider &&
      (m.usage.account === undefined || m.usage.account === account) &&
      m.ignore === true &&
      isCatchAllIgnoreMapping(m),
  );
}

function getWildcardKey(provider: string, account?: string | null): string {
  return `${provider}|${account ?? ""}|*`;
}

const priorityOptions: Array<{ label: string; value: PriorityRule[] }> = [
  {
    label: "fullAvailability → remainingPercent → earliestReset",
    value: ["fullAvailability", "remainingPercent", "earliestReset"],
  },
  {
    label: "fullAvailability → earliestReset → remainingPercent",
    value: ["fullAvailability", "earliestReset", "remainingPercent"],
  },
  {
    label: "remainingPercent → fullAvailability → earliestReset",
    value: ["remainingPercent", "fullAvailability", "earliestReset"],
  },
  {
    label: "remainingPercent → earliestReset → fullAvailability",
    value: ["remainingPercent", "earliestReset", "fullAvailability"],
  },
  {
    label: "earliestReset → fullAvailability → remainingPercent",
    value: ["earliestReset", "fullAvailability", "remainingPercent"],
  },
  {
    label: "earliestReset → remainingPercent → fullAvailability",
    value: ["earliestReset", "remainingPercent", "fullAvailability"],
  },
];

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Claude",
  copilot: "Copilot",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  zai: "z.ai",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasTokenPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [record.access, record.refresh, record.key].some(isNonEmptyString);
}

async function hasProviderCredential(
  provider: ProviderName,
  piAuth: Record<string, unknown>,
  modelRegistry?: {
    authStorage?: {
      getApiKey?: (
        id: string,
      ) => Promise<string | undefined> | string | undefined;
      get?: (
        id: string,
      ) =>
        | Promise<Record<string, unknown> | undefined>
        | Record<string, unknown>
        | undefined;
    };
  },
): Promise<boolean> {
  // Check environment variables
  if (provider === "zai") {
    if (isNonEmptyString(process.env.Z_AI_API_KEY)) return true;
  }

  if (provider === "antigravity") {
    if (isNonEmptyString(process.env.ANTIGRAVITY_API_KEY)) return true;
  }

  // Check authStorage for applicable providers
  if (modelRegistry?.authStorage) {
    try {
      if (provider === "copilot") {
        const githubCopilotKey = await Promise.resolve(
          modelRegistry.authStorage.getApiKey?.("github-copilot"),
        );
        const githubKey = await Promise.resolve(
          modelRegistry.authStorage.getApiKey?.("github"),
        );
        const githubCopilotData = await Promise.resolve(
          modelRegistry.authStorage.get?.("github-copilot"),
        );
        const githubData = await Promise.resolve(
          modelRegistry.authStorage.get?.("github"),
        );

        if (
          isNonEmptyString(githubCopilotKey) ||
          isNonEmptyString(githubKey) ||
          hasTokenPayload(githubCopilotData) ||
          hasTokenPayload(githubData)
        ) {
          return true;
        }
      }

      if (provider === "gemini") {
        const geminiKey = await Promise.resolve(
          modelRegistry.authStorage.getApiKey?.("google-gemini"),
        );
        const geminiCliKey = await Promise.resolve(
          modelRegistry.authStorage.getApiKey?.("google-gemini-cli"),
        );
        const geminiData = await Promise.resolve(
          modelRegistry.authStorage.get?.("google-gemini"),
        );
        const geminiCliData = await Promise.resolve(
          modelRegistry.authStorage.get?.("google-gemini-cli"),
        );

        if (
          isNonEmptyString(geminiKey) ||
          isNonEmptyString(geminiCliKey) ||
          hasTokenPayload(geminiData) ||
          hasTokenPayload(geminiCliData)
        ) {
          return true;
        }
      }

      if (provider === "antigravity") {
        const antigravityKey = await Promise.resolve(
          modelRegistry.authStorage.getApiKey?.("google-antigravity"),
        );
        const antigravityData = await Promise.resolve(
          modelRegistry.authStorage.get?.("google-antigravity"),
        );

        if (
          isNonEmptyString(antigravityKey) ||
          hasTokenPayload(antigravityData)
        ) {
          return true;
        }
      }
    } catch {
      // Ignore registry access errors
    }
  }

  // Check piAuth for applicable providers
  if (provider === "zai") {
    if (hasTokenPayload(piAuth["z-ai"] ?? piAuth.zai)) return true;
  }

  if (provider === "codex") {
    return Object.entries(piAuth).some(([authProvider, payload]) => {
      return (
        authProvider.startsWith("openai-codex") && hasTokenPayload(payload)
      );
    });
  }

  if (provider === "antigravity") {
    if (
      hasTokenPayload(
        piAuth["google-antigravity"] ??
          piAuth.antigravity ??
          piAuth["anti-gravity"],
      )
    )
      return true;
  }

  // For remaining providers (anthropic, copilot, gemini, kiro), check piAuth aliases
  const providerAliases: Record<string, string[]> = {
    anthropic: ["anthropic"],
    copilot: ["github-copilot", "copilot", "github"],
    gemini: ["google-gemini", "google-gemini-cli", "gemini"],
    kiro: ["kiro"],
  };

  const aliases = providerAliases[provider];
  if (!aliases) return false;

  return aliases.some((alias) => hasTokenPayload(piAuth[alias]));
}

// ============================================================================
// Cooldown Persistence (for print-mode / automation support)
// ============================================================================

interface CooldownState {
  cooldowns: Record<string, number>; // CandidateKey -> expiry timestamp
  lastSelected: string | null;
}

const COOLDOWN_STATE_PATH = path.join(
  os.homedir(),
  ".pi",
  "model-selector-cooldowns.json",
);

async function loadCooldownState(): Promise<CooldownState> {
  try {
    await fs.promises.access(COOLDOWN_STATE_PATH);
    const data = await fs.promises.readFile(COOLDOWN_STATE_PATH, "utf-8"),
      parsed = JSON.parse(data) as Partial<CooldownState>,
      cooldowns =
        parsed.cooldowns && typeof parsed.cooldowns === "object"
          ? parsed.cooldowns
          : {},
      lastSelected =
        typeof parsed.lastSelected === "string" ? parsed.lastSelected : null;
    return { cooldowns, lastSelected };
  } catch {
    // Ignore read errors or missing file, start fresh
  }
  return { cooldowns: {}, lastSelected: null };
}

async function saveCooldownState(state: CooldownState): Promise<void> {
  const dir = path.dirname(COOLDOWN_STATE_PATH);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${COOLDOWN_STATE_PATH}.tmp.${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(state, null, 2),
      "utf-8",
    );
    await fs.promises.rename(tempPath, COOLDOWN_STATE_PATH);
  } catch (error: unknown) {
    console.error(
      `[model-selector] Failed to save cooldown state: ${String(error)}`,
    );
  }
}

// ============================================================================
// Mapping Wizard
// ============================================================================

async function runMappingWizard(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(
      ctx,
      "error",
      "Model selector configuration requires interactive mode.",
    );
    return;
  }

  const config = await loadConfig(ctx, { requireMappings: false });
  if (!config) return;

  const locationLabels = [
    `Global (${config.sources.globalPath})`,
    `Project (${config.sources.projectPath})`,
  ];

  let cachedCandidates: UsageCandidate[] | null = null,
    cachedModels: Array<{ provider: string; id: string }> | null = null,
    cachedPiAuth: Record<string, unknown> | null = null;

  const loadAuth = async (): Promise<Record<string, unknown>> => {
      if (cachedPiAuth) return cachedPiAuth;
      cachedPiAuth = await loadPiAuth();
      return cachedPiAuth;
    },
    loadCandidates = async (): Promise<UsageCandidate[] | null> => {
      if (cachedCandidates) return cachedCandidates;
      const usages = await fetchAllUsages(
          ctx.modelRegistry,
          config.disabledProviders,
        ),
        candidates = dedupeCandidates(buildCandidates(usages));
      if (candidates.length === 0) {
        let detail =
          "No usage windows found. Check provider credentials and connectivity.";
        if (config.disabledProviders.length > 0) {
          const piAuth = await loadAuth();
          const disabledWithCredentials: ProviderName[] = [];
          for (const provider of config.disabledProviders) {
            if (
              await hasProviderCredential(provider, piAuth, ctx.modelRegistry)
            ) {
              disabledWithCredentials.push(provider);
            }
          }

          if (disabledWithCredentials.length > 0) {
            const labels = disabledWithCredentials.map(
              (provider) => PROVIDER_LABELS[provider],
            );
            detail += ` Detected credentials for disabled provider(s): ${labels.join(", ")}. Enable them via "Configure providers".`;
          }
        }

        notify(ctx, "error", detail);
        return null;
      }
      cachedCandidates = candidates;
      return candidates;
    },
    loadModels = async (): Promise<Array<{
      provider: string;
      id: string;
    }> | null> => {
      if (cachedModels) return cachedModels;
      try {
        const availableModels = await Promise.resolve(
          ctx.modelRegistry.getAvailable(),
        );
        if (availableModels.length === 0) {
          notify(
            ctx,
            "error",
            "No available models found. Ensure API keys are configured.",
          );
          return null;
        }
        cachedModels = availableModels;
        return availableModels;
      } catch (error: unknown) {
        notify(
          ctx,
          "error",
          `Failed to load available models: ${String(error)}`,
        );
        return null;
      }
    },
    configurePriority = async (): Promise<void> => {
      const currentPriority = config.priority.join(" → "),
        priorityLabels = priorityOptions.map((option) => option.label),
        priorityChoice = await ctx.ui.select(
          `Select priority order (current: ${currentPriority})`,
          priorityLabels,
        );
      if (!priorityChoice) return;

      const priorityIndex = priorityLabels.indexOf(priorityChoice);
      if (priorityIndex < 0) return;
      const selectedPriority = priorityOptions[priorityIndex].value,
        priorityLocation = await ctx.ui.select(
          "Save priority to",
          locationLabels,
        );
      if (!priorityLocation) return;

      const saveToProject = priorityLocation === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      try {
        targetRaw.priority = selectedPriority;
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      config.priority = selectedPriority;
      notify(ctx, "info", `Priority updated: ${selectedPriority.join(" → ")}.`);
    },
    configureMappings = async (): Promise<void> => {
      const candidates = await loadCandidates();
      if (!candidates) return;
      const availableModels = await loadModels();
      if (!availableModels) return;

      const sortedCandidates = [...candidates].sort((a, b) => {
          if (a.provider !== b.provider)
            return a.provider.localeCompare(b.provider);
          return a.windowLabel.localeCompare(b.windowLabel);
        }),
        modelLabels = availableModels.map(
          (model) => `${model.provider}/${model.id}`,
        );

      let continueMapping = true;
      while (continueMapping) {
        const optionLabels = sortedCandidates.map((candidate) => {
            const ignored = findIgnoreMapping(candidate, config.mappings),
              mapping = findModelMapping(candidate, config.mappings),
              mappingLabel = ignored
                ? "ignored"
                : mapping
                  ? `mapped: ${mapping.model?.provider}/${mapping.model?.id}`
                  : "unmapped";
            return `${candidate.provider}/${candidate.windowLabel} (${candidate.remainingPercent.toFixed(0)}% remaining, ${candidate.displayName}) [${mappingLabel}]`;
          }),
          selectedLabel = await ctx.ui.select(
            "Select a usage bucket to map",
            optionLabels,
          );
        if (!selectedLabel) return;

        const selectedIndex = optionLabels.indexOf(selectedLabel);
        if (selectedIndex < 0) return;
        const selectedCandidate = sortedCandidates[selectedIndex];

        // Ask which config file (Global / Project) the user wants to modify first
        const locationChoice = await ctx.ui.select(
          `Modify mapping in`,
          locationLabels,
        );
        if (!locationChoice) return;

        const saveToProject = locationChoice === locationLabels[1];
        const targetRaw = saveToProject
          ? config.raw.project
          : config.raw.global;
        const targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

        // Determine which actions make sense for this target file
        const targetMappings = getRawMappings(targetRaw),
          matchedIgnoreInTarget = findIgnoreMapping(
            selectedCandidate,
            targetMappings,
          ),
          matchedModelInTarget = findModelMapping(
            selectedCandidate,
            targetMappings,
          ),
          hasIgnoreInTarget = matchedIgnoreInTarget !== undefined,
          hasModelInTarget = matchedModelInTarget !== undefined;

        const actionOptions = [
          "Map to model",
          "Map by pattern",
          "Ignore bucket",
          "Ignore by pattern",
        ];
        if (hasIgnoreInTarget) actionOptions.push("Stop ignoring");
        if (hasIgnoreInTarget || hasModelInTarget)
          actionOptions.push("Remove mapping");

        const actionChoice = await ctx.ui.select(
          `Select action for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}`,
          actionOptions,
        );
        if (!actionChoice) return;

        if (
          actionChoice === "Stop ignoring" ||
          actionChoice === "Remove mapping"
        ) {
          const mappingToRemove =
            actionChoice === "Stop ignoring"
              ? matchedIgnoreInTarget
              : (matchedModelInTarget ?? matchedIgnoreInTarget);

          if (!mappingToRemove) {
            notify(
              ctx,
              "warning",
              `No matching ${actionChoice === "Stop ignoring" ? "ignore" : "mapping"} found in ${targetPath}.`,
            );
          } else {
            try {
              const res = removeMapping(targetRaw, mappingToRemove, {
                onlyIgnore: actionChoice === "Stop ignoring",
              });
              if (!res.removed) {
                notify(
                  ctx,
                  "warning",
                  `No matching ${actionChoice === "Stop ignoring" ? "ignore" : "mapping"} found in ${targetPath}.`,
                );
              } else {
                await saveConfigFile(targetPath, targetRaw);

                const reloaded = await loadConfig(ctx, {
                  requireMappings: false,
                });
                if (reloaded) {
                  config.mappings = reloaded.mappings;
                }

                notify(
                  ctx,
                  "info",
                  `Removed ${actionChoice === "Stop ignoring" ? "ignore mapping" : "mapping"} for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}.`,
                );
              }
            } catch (error: unknown) {
              notify(
                ctx,
                "error",
                `Failed to write ${targetPath}: ${String(error)}`,
              );
              return;
            }
          }

          const addMoreAfterRemove = await ctx.ui.confirm(
            "Modify another mapping?",
            "Do you want to modify another usage bucket?",
          );
          if (!addMoreAfterRemove) continueMapping = false;
          continue;
        }

        let pattern: string | undefined;
        if (
          actionChoice === "Map by pattern" ||
          actionChoice === "Ignore by pattern"
        ) {
          pattern = await ctx.ui.input(
            `Enter regex pattern (e.g. ^${selectedCandidate.windowLabel}$)`,
          );
          if (!pattern) return;
          try {
            new RegExp(pattern);
          } catch (e: unknown) {
            notify(ctx, "error", `Invalid regex: ${String(e)}`);
            return;
          }
        }

        let selectedModel: { provider: string; id: string } | undefined;
        if (
          actionChoice === "Map to model" ||
          actionChoice === "Map by pattern"
        ) {
          const modelChoice = await ctx.ui.select(
            `Select model for ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel}`,
            modelLabels,
          );
          if (!modelChoice) return;

          const modelIndex = modelLabels.indexOf(modelChoice);
          if (modelIndex < 0) return;
          selectedModel = availableModels[modelIndex];
        }

        // Build the usage descriptor for this candidate/pattern
        const usageDesc = {
          provider: selectedCandidate.provider,
          account: selectedCandidate.account,
          window: pattern ? undefined : selectedCandidate.windowLabel,
          windowPattern: pattern,
        } as MappingEntry["usage"];

        const mappingEntry: MappingEntry =
          actionChoice === "Map to model" || actionChoice === "Map by pattern"
            ? {
                usage: usageDesc,
                model: {
                  provider: selectedModel!.provider,
                  id: selectedModel!.id,
                },
              }
            : {
                usage: usageDesc,
                ignore: true,
              };

        try {
          upsertMapping(targetRaw, mappingEntry);
          await saveConfigFile(targetPath, targetRaw);
        } catch (error: unknown) {
          notify(
            ctx,
            "error",
            `Failed to write ${targetPath}: ${String(error)}`,
          );
          return;
        }

        const reloaded = await loadConfig(ctx, { requireMappings: false });
        if (reloaded) {
          config.mappings = reloaded.mappings;
        }

        const actionSummary = mappingEntry.ignore
          ? `Ignored ${selectedCandidate.provider}/${selectedCandidate.windowLabel}.`
          : `Mapped ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel} to ${mappingEntry.model?.provider}/${mappingEntry.model?.id}.`;
        notify(ctx, "info", actionSummary);

        const addMore = await ctx.ui.confirm(
          "Add another mapping?",
          "Do you want to map another usage bucket?",
        );
        if (!addMore) continueMapping = false;
      }
    },
    configureWidget = async (): Promise<void> => {
      const currentStatus = config.widget.enabled ? "enabled" : "disabled",
        widgetChoice = await ctx.ui.select(
          `Usage widget (current: ${currentStatus})`,
          [
            "Enable widget",
            "Disable widget",
            "Configure placement",
            "Configure count",
          ],
        );
      if (!widgetChoice) return;

      const widgetUpdate: Partial<WidgetConfig> = {};

      if (widgetChoice === "Enable widget") {
        widgetUpdate.enabled = true;
      } else if (widgetChoice === "Disable widget") {
        widgetUpdate.enabled = false;
      } else if (widgetChoice === "Configure placement") {
        const placementChoice = await ctx.ui.select(
          `Widget placement (current: ${config.widget.placement})`,
          ["Above editor", "Below editor"],
        );
        if (!placementChoice) return;
        widgetUpdate.placement =
          placementChoice === "Above editor" ? "aboveEditor" : "belowEditor";
      } else if (widgetChoice === "Configure count") {
        const countChoice = await ctx.ui.select(
          `Number of candidates to show (current: ${config.widget.showCount})`,
          ["1", "2", "3", "4", "5"],
        );
        if (!countChoice) return;
        widgetUpdate.showCount = parseInt(countChoice, 10);
      }

      if (Object.keys(widgetUpdate).length === 0) return;

      const locationChoice = await ctx.ui.select(
        "Save widget settings to",
        locationLabels,
      );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      try {
        updateWidgetConfig(targetRaw, widgetUpdate);
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
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
    },
    configureDebugLog = async (): Promise<void> => {
      const currentLog = config.debugLog?.path || "model-selector.log",
        currentStatus = config.debugLog?.enabled ? "enabled" : "disabled",
        choice = await ctx.ui.select(
          `Debug logging (current: ${currentStatus}, path: ${currentLog})`,
          [
            config.debugLog?.enabled ? "Disable logging" : "Enable logging",
            "Change log file path",
          ],
        );
      if (!choice) return;

      const debugUpdate: { enabled?: boolean; path?: string } = {
        ...config.debugLog,
      };

      if (choice === "Enable logging") {
        debugUpdate.enabled = true;
      } else if (choice === "Disable logging") {
        debugUpdate.enabled = false;
      } else if (choice === "Change log file path") {
        const newPath = await ctx.ui.input(
          "Enter log file path (relative to project or absolute)",
        );
        if (!newPath) return;
        debugUpdate.path = newPath;
      }

      const locationChoice = await ctx.ui.select(
        "Save debug log setting to",
        locationLabels,
      );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      try {
        targetRaw.debugLog = debugUpdate;
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      // Reload config to apply path resolution
      const reloaded = await loadConfig(ctx, { requireMappings: false });
      if (reloaded) {
        config.debugLog = reloaded.debugLog;
        setGlobalConfig(reloaded);
      }

      notify(
        ctx,
        "info",
        `Debug logging ${config.debugLog?.enabled ? "enabled" : "disabled"}.`,
      );
    },
    configureAutoRun = async (): Promise<void> => {
      const currentStatus = config.autoRun ? "enabled" : "disabled",
        choice = await ctx.ui.select(
          `Auto-run after every turn (current: ${currentStatus})`,
          [config.autoRun ? "Disable auto-run" : "Enable auto-run"],
        );
      if (!choice) return;

      const newValue = choice === "Enable auto-run",
        locationChoice = await ctx.ui.select(
          "Save auto-run setting to",
          locationLabels,
        );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      try {
        targetRaw.autoRun = newValue;
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      config.autoRun = newValue;
      notify(ctx, "info", `Auto-run ${newValue ? "enabled" : "disabled"}.`);
    },
    configureProviders = async (): Promise<void> => {
      const piAuth = await loadAuth();
      const locationChoice = await ctx.ui.select(
        "Select configuration scope",
        locationLabels,
      );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      const currentRawDisabled = Array.isArray(targetRaw.disabledProviders)
        ? targetRaw.disabledProviders.filter(
            (value): value is ProviderName =>
              typeof value === "string" &&
              ALL_PROVIDERS.includes(value as ProviderName),
          )
        : [];

      // Check credentials for all providers in parallel to avoid UI sluggishness
      const credentialChecks = await Promise.all(
        ALL_PROVIDERS.map((provider) =>
          hasProviderCredential(provider, piAuth, ctx.modelRegistry).then(
            (hasCredentials) => ({ provider, hasCredentials }),
          ),
        ),
      );

      const providerOptions: string[] = [];
      for (const { provider, hasCredentials } of credentialChecks) {
        const disabledInTarget = currentRawDisabled.includes(provider);
        const providerLabel = PROVIDER_LABELS[provider];
        const mergedDisabled = config.disabledProviders.includes(provider);

        let statusLabel = disabledInTarget ? "⏸ disabled" : "✅ enabled";
        if (disabledInTarget !== mergedDisabled) {
          statusLabel += ` (overall: ${mergedDisabled ? "disabled" : "enabled"})`;
        }

        providerOptions.push(
          `${statusLabel} ${providerLabel} (${provider}) — credentials: ${hasCredentials ? "detected" : "missing"}`,
        );
      }

      const selectedProviderLabel = await ctx.ui.select(
        `Configure providers in ${saveToProject ? "Project" : "Global"}`,
        providerOptions,
      );

      if (!selectedProviderLabel) return;
      const selectedIndex = providerOptions.indexOf(selectedProviderLabel);
      if (selectedIndex < 0) return;

      const selectedProvider = ALL_PROVIDERS[selectedIndex],
        currentlyDisabledInTarget =
          currentRawDisabled.includes(selectedProvider),
        nextDisabled = !currentlyDisabledInTarget,
        disabledSet = new Set(currentRawDisabled);

      if (nextDisabled) {
        disabledSet.add(selectedProvider);
      } else {
        disabledSet.delete(selectedProvider);
      }

      try {
        targetRaw.disabledProviders = [...disabledSet];
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      const reloaded = await loadConfig(ctx, { requireMappings: false });
      if (reloaded) {
        config.disabledProviders = reloaded.disabledProviders;
        config.raw = reloaded.raw;
      }

      cachedCandidates = null;

      const selectedProviderLabelFriendly = PROVIDER_LABELS[selectedProvider];
      const isActuallyDisabled =
        config.disabledProviders.includes(selectedProvider);
      const scopeLabel = saveToProject ? "Project" : "Global";

      notify(
        ctx,
        "info",
        `${nextDisabled ? "Disabled" : "Enabled"} ${selectedProviderLabelFriendly} in ${scopeLabel} config. Overall status: ${isActuallyDisabled ? "Disabled" : "Enabled"}.`,
      );
    },
    menuOptions = [
      "Edit mappings",
      "Configure providers",
      "Configure priority",
      "Configure widget",
      "Configure auto-run",
      "Configure debug log",
      "Done",
    ];

  while (true) {
    const action = await ctx.ui.select(
      "Model selector configuration",
      menuOptions,
    );
    if (!action || action === "Done") return;

    if (action === "Configure priority") {
      await configurePriority();
      continue;
    }

    if (action === "Configure providers") {
      await configureProviders();
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
  // Cooldown State - backed by file for cross-invocation persistence
  const modelCooldowns = new Map<string, number>(),
    COOLDOWN_DURATION = 60 * 60 * 1000; // 1 hour
  let cooldownsLoaded = false,
    lastSelectedCandidateKey: string | null = null;

  // Load persisted cooldown state from file
  const loadPersistedCooldowns = async (): Promise<void> => {
      if (cooldownsLoaded) return;
      const state = await loadCooldownState(),
        now = Date.now();

      // Load non-expired cooldowns into the Map
      for (const [key, expiry] of Object.entries(state.cooldowns)) {
        if (expiry > now) {
          modelCooldowns.set(key, expiry);
        }
      }

      // Restore last selected (useful for /model-skip in print mode)
      if (state.lastSelected) {
        lastSelectedCandidateKey = state.lastSelected;
      }
      cooldownsLoaded = true;
    },
    // Save current cooldown state to file
    persistCooldowns = async (): Promise<void> => {
      const cooldowns: Record<string, number> = {},
        now = Date.now();

      for (const [key, expiry] of modelCooldowns) {
        if (expiry > now) {
          cooldowns[key] = expiry;
        }
      }

      await saveCooldownState({
        cooldowns,
        lastSelected: lastSelectedCandidateKey,
      });
    },
    pruneExpiredCooldowns = (now = Date.now()): boolean => {
      let removed = false;
      for (const [key, expiry] of modelCooldowns) {
        if (expiry <= now) {
          modelCooldowns.delete(key);
          removed = true;
        }
      }
      return removed;
    },
    setOrExtendProviderCooldown = (
      provider: string,
      account: string | undefined,
      now: number,
    ): boolean => {
      const wildcardKey = getWildcardKey(provider, account),
        existingExpiry = modelCooldowns.get(wildcardKey) ?? 0,
        newExpiry = now + COOLDOWN_DURATION;
      if (newExpiry <= existingExpiry) {
        return false;
      }
      modelCooldowns.set(wildcardKey, newExpiry);
      return true;
    },
    // Check if a candidate is on cooldown (handles exact and wildcard keys)
    isOnCooldown = (c: UsageCandidate): boolean => {
      const key = candidateKey(c),
        wildcardKey = getWildcardKey(c.provider, c.account),
        now = Date.now();

      const expiry = modelCooldowns.get(key),
        wildcardExpiry = modelCooldowns.get(wildcardKey);

      return (
        (expiry !== undefined && expiry > now) ||
        (wildcardExpiry !== undefined && wildcardExpiry > now)
      );
    };

  let running = false;

  const runSelector = async (
    ctx: ExtensionContext,
    reason: "startup" | "command" | "auto",
    options: {
      preloadedConfig?: LoadedConfig;
      preloadedUsages?: UsageSnapshot[];
    } = {},
  ) => {
    if (running) {
      notify(ctx, "warning", "Model selector is already running.");
      return;
    }
    running = true;

    try {
      // Load persisted cooldowns on startup (for print-mode support)
      await loadPersistedCooldowns();

      const config = options.preloadedConfig || (await loadConfig(ctx));
      if (!config) return;
      setGlobalConfig(config);
      writeDebugLog(`Running selector (reason: ${reason})`);

      const usages =
        options.preloadedUsages ||
        (await fetchAllUsages(ctx.modelRegistry, config.disabledProviders));

      // Clean up stale cooldowns first so fresh 429s can always re-arm cooldowns.
      pruneExpiredCooldowns();

      if (!options.preloadedUsages) {
        let saveNeeded = false;
        const now = Date.now();

        for (const usage of usages) {
          // Detect 429 errors and apply provider-wide cooldown
          // Skip ignored providers to avoid noisy UX for intentionally-ignored providers
          if (usage.error?.includes("429")) {
            if (
              !isProviderIgnored(usage.provider, usage.account, config.mappings)
            ) {
              const updated = setOrExtendProviderCooldown(
                usage.provider,
                usage.account,
                now,
              );
              if (updated) {
                saveNeeded = true;
                notify(
                  ctx,
                  "warning",
                  `Rate limit (429) detected for ${usage.displayName}. Pausing this provider for 1 hour.`,
                );
              }
            }
          } else if (
            usage.error &&
            !isProviderIgnored(usage.provider, usage.account, config.mappings)
          ) {
            // Suppress warnings if provider is already on cooldown
            const wildcardKey = getWildcardKey(usage.provider, usage.account),
              wildcardExpiry = modelCooldowns.get(wildcardKey);

            if (!wildcardExpiry || wildcardExpiry <= now) {
              notify(
                ctx,
                "warning",
                `Usage check failed for ${usage.displayName}: ${usage.error}`,
              );
            }
          }
        }

        if (saveNeeded) {
          await persistCooldowns();
        }
      }

      // Clean up any cooldowns that may have just expired.
      pruneExpiredCooldowns();

      const candidates = buildCandidates(usages);
      let eligibleCandidates = candidates.filter(
        (candidate) => !findIgnoreMapping(candidate, config.mappings),
      );

      // Filter out cooldowns
      const cooldownCount = eligibleCandidates.filter((c) =>
        isOnCooldown(c),
      ).length;
      if (cooldownCount > 0) {
        eligibleCandidates = eligibleCandidates.filter((c) => !isOnCooldown(c));
        if (reason === "command") {
          notify(
            ctx,
            "info",
            `${cooldownCount} usage bucket(s) skipped due to temporary cooldown.`,
          );
        }
      }

      if (eligibleCandidates.length === 0) {
        if (cooldownCount > 0) {
          notify(
            ctx,
            "warning",
            "All eligible candidates are on cooldown. Resetting cooldowns.",
          );
          modelCooldowns.clear();
          await persistCooldowns();
          eligibleCandidates = candidates.filter(
            (candidate) => !findIgnoreMapping(candidate, config.mappings),
          );
        } else {
          const detail =
            candidates.length === 0
              ? "No usage windows found. Check provider credentials and connectivity."
              : "All usage buckets are ignored. Remove an ignore mapping or add a model mapping.";
          notify(ctx, "error", detail);
          clearWidget(ctx);
          return;
        }
      }

      const rankedCandidates = sortCandidates(
        eligibleCandidates,
        config.priority,
        config.mappings,
      );

      // Update widget with ranked candidates
      updateWidgetState({ candidates: rankedCandidates, config });
      renderUsageWidget(ctx);

      const best = rankedCandidates[0];
      if (!best) {
        notify(ctx, "error", "Unable to determine a best usage window.");
        return;
      }
      lastSelectedCandidateKey = candidateKey(best);
      await persistCooldowns(); // Save state for print-mode support
      const runnerUp = rankedCandidates[1],
        mapping = findModelMapping(best, config.mappings);
      if (!mapping || !mapping.model) {
        const usage: UsageMappingKey = { provider: best.provider };
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
            2,
          ),
          suggestedIgnore = JSON.stringify(
            {
              usage,
              ignore: true,
            },
            null,
            2,
          );
        notify(
          ctx,
          "error",
          `No model mapping for best usage bucket ${best.provider}/${best.windowLabel} (${best.remainingPercent.toFixed(0)}% remaining, ${best.displayName}).\nAdd a mapping to ${config.sources.projectPath} or ${config.sources.globalPath}:\n${suggestedMapping}\n\nOr ignore this bucket:\n${suggestedIgnore}`,
        );
        return;
      }

      const model = ctx.modelRegistry.find(
        mapping.model.provider,
        mapping.model.id,
      );
      if (!model) {
        notify(
          ctx,
          "error",
          `Mapped model not found: ${mapping.model.provider}/${mapping.model.id}.`,
        );
        return;
      }

      const current = ctx.model,
        isAlreadySelected =
          current &&
          current.provider === mapping.model.provider &&
          current.id === mapping.model.id;

      if (!isAlreadySelected) {
        const success = await pi.setModel(model);
        if (!success) {
          notify(
            ctx,
            "error",
            `Failed to set model to ${mapping.model.provider}/${mapping.model.id}. Check provider status or credentials.`,
          );
          return;
        }
      }

      const reasonDetail = runnerUp
          ? selectionReason(best, runnerUp, config.priority, config.mappings)
          : "Only one candidate available",
        selectionMsg = isAlreadySelected
          ? `Already using ${mapping.model.provider}/${mapping.model.id}`
          : `Set model to ${mapping.model.provider}/${mapping.model.id}`,
        bucketMsg = `${best.displayName}/${best.windowLabel} (${best.remainingPercent.toFixed(0)}% left)`;

      notify(
        ctx,
        "info",
        `${selectionMsg} via ${bucketMsg}. Reason: ${reasonDetail}.`,
      );
    } finally {
      running = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await runSelector(ctx, "startup");
  });

  pi.on("session_switch", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "resume") {
      await runSelector(ctx, "startup");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const config = await loadConfig(ctx, { requireMappings: false });
    if (config?.autoRun) {
      await runSelector(ctx, "auto", { preloadedConfig: config });
    }
  });

  pi.registerCommand("model-select", {
    description: "Select the best starting model based on quota usage",
    handler: async (_args, ctx) => {
      await runSelector(ctx, "command");
    },
  });

  pi.registerCommand("model-select-config", {
    description: "Configure mappings, providers, and widget settings",
    handler: async (_args, ctx) => {
      await runMappingWizard(ctx);
    },
  });

  pi.registerCommand("model-skip", {
    description:
      "Skip the current best model for 1 hour and select the next best",
    handler: async (_args, ctx) => {
      // Load persisted state first (for print-mode support)
      await loadPersistedCooldowns();

      const config = await loadConfig(ctx);
      if (!config) return;

      const usages = await fetchAllUsages(
        ctx.modelRegistry,
        config.disabledProviders,
      );

      if (!lastSelectedCandidateKey) {
        const candidates = buildCandidates(usages),
          eligible = candidates.filter(
            (c) => !findIgnoreMapping(c, config.mappings),
          ),
          ranked = sortCandidates(eligible, config.priority, config.mappings);
        if (ranked.length > 0) {
          lastSelectedCandidateKey = candidateKey(ranked[0]);
        }
      }

      if (lastSelectedCandidateKey) {
        modelCooldowns.set(
          lastSelectedCandidateKey,
          Date.now() + COOLDOWN_DURATION,
        );
        await persistCooldowns(); // Save to file immediately
        notify(
          ctx,
          "info",
          `Added temporary cooldown (1h) for usage bucket: ${lastSelectedCandidateKey}`,
        );
        lastSelectedCandidateKey = null;
        // Run selector with pre-fetched usages to avoid second network roundtrip
        await runSelector(ctx, "command", {
          preloadedConfig: config,
          preloadedUsages: usages,
        });
      } else {
        notify(ctx, "error", "Could not determine a candidate to skip.");
      }
    },
  });
}
