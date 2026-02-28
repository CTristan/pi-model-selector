import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  buildCandidates,
  combineCandidates,
  dedupeCandidates,
  findCombinationMapping,
  findIgnoreMapping,
  findModelMapping,
} from "./candidates.js";

import {
  cleanupConfigRaw,
  clearBucketMappings,
  getRawMappings,
  loadConfig,
  removeMapping,
  saveConfigFile,
  updateWidgetConfig,
  upsertMapping,
} from "./config.js";

import { hasProviderCredential, PROVIDER_LABELS } from "./credential-check.js";

import type {
  MappingEntry,
  ProviderName,
  UsageCandidate,
  UsageSnapshot,
  WidgetConfig,
} from "./types.js";
import {
  ALL_PROVIDERS,
  notify,
  setGlobalConfig,
  writeDebugLog,
} from "./types.js";
import { priorityOptions, selectWrapped } from "./ui-helpers.js";
import { fetchAllUsages, loadPiAuth } from "./usage-fetchers.js";
import {
  getWidgetState,
  renderUsageWidget,
  updateWidgetState,
} from "./widget.js";

const RESERVE_INPUT_ERROR =
  "Invalid reserve value. Must be an integer between 0 and 99.";

function parseReserveInput(input: string): number | undefined {
  const trimmedInput = input.trim();
  if (trimmedInput.length === 0) return undefined;

  const reserveValue = Number(trimmedInput);
  if (
    Number.isNaN(reserveValue) ||
    !Number.isInteger(reserveValue) ||
    reserveValue < 0 ||
    reserveValue >= 100
  ) {
    return undefined;
  }

  return reserveValue;
}

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

  let cachedUsages: UsageSnapshot[] | null = null,
    cachedModels: Array<{ provider: string; id: string }> | null = null,
    cachedPiAuth: Record<string, unknown> | null = null;

  const loadAuth = async (): Promise<Record<string, unknown>> => {
      if (cachedPiAuth !== null) return cachedPiAuth;
      cachedPiAuth = (await loadPiAuth()) || {};
      return cachedPiAuth;
    },
    loadCandidates = async (): Promise<UsageCandidate[] | null> => {
      if (!cachedUsages) {
        cachedUsages = await fetchAllUsages(
          ctx.modelRegistry,
          config.disabledProviders,
        );
      }
      const rawCandidates = buildCandidates(cachedUsages);
      const combined = combineCandidates(rawCandidates, config.mappings);
      // For the wizard, we want to see everything, including members of combinations
      // so users can remove their individual combination mappings.
      const dedupedRaw = dedupeCandidates(rawCandidates);
      const syntheticOnly = combined.filter(
        (c: UsageCandidate) => c.isSynthetic,
      );
      // Avoid cross-deduping raw vs. synthetic candidates so both remain visible.
      const candidates = [...dedupedRaw, ...syntheticOnly];
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
        priorityChoice = await selectWrapped(
          ctx,
          `Select priority order (current: ${currentPriority})`,
          priorityLabels,
        );
      if (!priorityChoice) return;

      const priorityIndex = priorityLabels.indexOf(priorityChoice);
      if (priorityIndex < 0) return;
      const priorityOption = priorityOptions[priorityIndex];
      if (!priorityOption) return;
      const selectedPriority = priorityOption.value,
        priorityLocation = await selectWrapped(
          ctx,
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
      const availableModels = await loadModels();
      if (!availableModels) return;

      const modelLabels = availableModels.map(
        (model) => `${model.provider}/${model.id}`,
      );

      let continueMapping = true;
      while (continueMapping) {
        const candidates = await loadCandidates();
        if (!candidates) return;

        const sortedCandidates = [...candidates].sort((a, b) => {
          if (a.provider !== b.provider)
            return a.provider.localeCompare(b.provider);
          return a.windowLabel.localeCompare(b.windowLabel);
        });

        const optionLabels = sortedCandidates.map((candidate) => {
          const ignored = findIgnoreMapping(candidate, config.mappings),
            mapping = findModelMapping(candidate, config.mappings),
            combination = findCombinationMapping(candidate, config.mappings);
          let mappingLabel: string;
          if (ignored) {
            mappingLabel = "ignored";
          } else if (mapping) {
            const reserveSuffix =
              (mapping.reserve ?? 0) > 0
                ? ` (reserve: ${mapping.reserve}%)`
                : "";
            mappingLabel = `mapped: ${mapping.model?.provider}/${mapping.model?.id}${reserveSuffix}`;
          } else if (combination) {
            mappingLabel = `combined: ${combination.combine}`;
          } else {
            mappingLabel = "unmapped";
          }
          const accountPart = candidate.account ? `${candidate.account}/` : "";
          return `${candidate.provider}/${accountPart}${candidate.windowLabel} (${candidate.remainingPercent.toFixed(0)}% remaining, ${candidate.displayName}) [${mappingLabel}]`;
        });

        const selectedLabel = await selectWrapped(
          ctx,
          "Select a usage bucket to map",
          optionLabels,
        );
        if (!selectedLabel) return;

        const selectedIndex = optionLabels.indexOf(selectedLabel);
        if (selectedIndex < 0) return;
        const selectedCandidate = sortedCandidates[selectedIndex];
        if (!selectedCandidate) return;

        // Ask which config file (Global / Project) the user wants to modify first
        const locationChoice = await selectWrapped(
          ctx,
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
          matchedCombinationInTarget = findCombinationMapping(
            selectedCandidate,
            targetMappings,
          ),
          hasIgnoreInTarget = matchedIgnoreInTarget !== undefined,
          hasModelInTarget = matchedModelInTarget !== undefined,
          hasCombinationInTarget = matchedCombinationInTarget !== undefined,
          isSynthetic = selectedCandidate.isSynthetic === true;

        const actionOptions = [
          "Map to model",
          "Map by pattern",
          "Ignore bucket",
          "Ignore by pattern",
        ];
        if (!isSynthetic) {
          actionOptions.push("Combine bucket", "Combine by pattern");
        }
        if (hasIgnoreInTarget) actionOptions.push("Stop ignoring");
        if (hasCombinationInTarget) actionOptions.push("Stop combining");
        if (isSynthetic) actionOptions.push("Dissolve combination");
        if (hasModelInTarget) actionOptions.push("Change reserve");
        if (hasIgnoreInTarget || hasModelInTarget || hasCombinationInTarget)
          actionOptions.push("Remove mapping");

        const actionChoice = await selectWrapped(
          ctx,
          `Select action for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}`,
          actionOptions,
        );
        if (!actionChoice) return;

        if (actionChoice === "Dissolve combination") {
          try {
            const existing = Array.isArray(targetRaw.mappings)
              ? targetRaw.mappings
              : [];
            const filtered = existing.filter((entry: unknown) => {
              if (!entry || typeof entry !== "object") return true;
              const e = entry as MappingEntry;
              const combineRaw =
                typeof e.combine === "string" ? e.combine.trim() : e.combine;
              const targetLabel = selectedCandidate.windowLabel.trim();
              if (combineRaw !== targetLabel) return true;

              const providerMatch =
                e.usage?.provider === selectedCandidate.provider;
              const accountsMatch =
                selectedCandidate.account === undefined
                  ? e.usage?.account === undefined
                  : e.usage?.account === selectedCandidate.account;
              const isMatch = providerMatch && accountsMatch;

              return !isMatch;
            });

            if (filtered.length === existing.length) {
              notify(
                ctx,
                "warning",
                `No combination group "${selectedCandidate.windowLabel}" found in ${targetPath}.`,
              );
            } else {
              targetRaw.mappings = filtered;
              await saveConfigFile(targetPath, targetRaw);

              const reloaded = await loadConfig(ctx, {
                requireMappings: false,
              });
              if (reloaded) {
                config.mappings = reloaded.mappings;
                cachedUsages = null;
              }

              notify(
                ctx,
                "info",
                `Dissolved combination group "${selectedCandidate.windowLabel}" in ${targetPath}.`,
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

          const addMoreAfterDissolve = await ctx.ui.confirm(
            "Modify another mapping?",
            "Do you want to modify another usage bucket?",
          );
          if (!addMoreAfterDissolve) continueMapping = false;
          continue;
        }

        if (actionChoice === "Change reserve") {
          const currentReserve = matchedModelInTarget?.reserve ?? 0;
          const currentReserveText =
            currentReserve > 0 ? `${currentReserve}%` : "none (0)";

          const reserveChoice = await selectWrapped(
            ctx,
            `Set reserve for ${matchedModelInTarget?.model?.provider}/${matchedModelInTarget?.model?.id} (current: ${currentReserveText})`,
            ["No reserve (0)", "Set reserve"],
          );
          if (!reserveChoice) return;

          let newReserve: number | undefined;
          if (reserveChoice === "Set reserve") {
            const reserveInput = await ctx.ui.input(
              "Enter reserve percentage (0-99, e.g., 20 means always keep at least 20% available)",
            );
            if (!reserveInput) return;

            const parsedReserve = parseReserveInput(reserveInput);
            if (parsedReserve === undefined) {
              notify(ctx, "error", RESERVE_INPUT_ERROR);
              return;
            }
            newReserve = parsedReserve;
          }

          try {
            const existing = Array.isArray(targetRaw.mappings)
                ? targetRaw.mappings
                : [],
              targetEntries: MappingEntry[] = [];

            for (const entry of existing) {
              if (!entry || typeof entry !== "object") continue;
              const typed = entry as MappingEntry;
              if (typed.model && !typed.ignore) {
                targetEntries.push(typed);
              }
            }

            const mappingToUpdate = findModelMapping(
              selectedCandidate,
              targetEntries,
            );

            if (!mappingToUpdate || !mappingToUpdate.model) {
              notify(
                ctx,
                "warning",
                `No matching model mapping found in ${targetPath}. Reserve was not changed.`,
              );
            } else {
              if (newReserve !== undefined && newReserve > 0) {
                mappingToUpdate.reserve = newReserve;
              } else {
                delete mappingToUpdate.reserve;
              }

              await saveConfigFile(targetPath, targetRaw);

              const reloaded = await loadConfig(ctx, {
                requireMappings: false,
              });
              if (reloaded) {
                config.mappings = reloaded.mappings;
                cachedUsages = null;
              }

              const newReserveText =
                newReserve !== undefined && newReserve > 0
                  ? `${newReserve}%`
                  : "none (0)";
              notify(
                ctx,
                "info",
                `Reserve updated to ${newReserveText} for ${mappingToUpdate.model.provider}/${mappingToUpdate.model.id}.`,
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

          const addMoreAfterReserve = await ctx.ui.confirm(
            "Modify another mapping?",
            "Do you want to modify another usage bucket?",
          );
          if (!addMoreAfterReserve) continueMapping = false;
          continue;
        }

        if (
          actionChoice === "Stop ignoring" ||
          actionChoice === "Stop combining" ||
          actionChoice === "Remove mapping"
        ) {
          const mappingToRemove =
            actionChoice === "Stop ignoring"
              ? matchedIgnoreInTarget
              : actionChoice === "Stop combining"
                ? matchedCombinationInTarget
                : (matchedModelInTarget ??
                  matchedIgnoreInTarget ??
                  matchedCombinationInTarget);

          if (!mappingToRemove) {
            notify(
              ctx,
              "warning",
              `No matching ${
                actionChoice === "Stop ignoring"
                  ? "ignore"
                  : actionChoice === "Stop combining"
                    ? "combination"
                    : "mapping"
              } found in ${targetPath}.`,
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
                  `No matching ${
                    actionChoice === "Stop ignoring"
                      ? "ignore"
                      : actionChoice === "Stop combining"
                        ? "combination"
                        : "mapping"
                  } found in ${targetPath}.`,
                );
              } else {
                await saveConfigFile(targetPath, targetRaw);

                const reloaded = await loadConfig(ctx, {
                  requireMappings: false,
                });
                if (reloaded) {
                  config.mappings = reloaded.mappings;
                  cachedUsages = null;
                }

                notify(
                  ctx,
                  "info",
                  `Removed ${
                    actionChoice === "Stop ignoring"
                      ? "ignore mapping"
                      : actionChoice === "Stop combining"
                        ? "combination mapping"
                        : "mapping"
                  } for ${selectedCandidate.provider}/${selectedCandidate.windowLabel}.`,
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
          actionChoice === "Ignore by pattern" ||
          actionChoice === "Combine by pattern"
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
        let selectedReserve: number | undefined;
        if (
          actionChoice === "Map to model" ||
          actionChoice === "Map by pattern"
        ) {
          const modelChoice = await selectWrapped(
            ctx,
            `Select model for ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel}`,
            modelLabels,
          );
          if (!modelChoice) return;

          const modelIndex = modelLabels.indexOf(modelChoice);
          if (modelIndex < 0) return;
          const model = availableModels[modelIndex];
          if (!model) return;
          selectedModel = model;

          // Ask for reserve threshold
          const reserveChoice = await selectWrapped(
            ctx,
            "Set a minimum reserve to preserve? (0 = no reserve, model can be used fully)",
            ["No reserve (0)", "Set reserve"],
          );
          if (!reserveChoice) return;

          if (reserveChoice === "Set reserve") {
            const reserveInput = await ctx.ui.input(
              "Enter reserve percentage (0-99, e.g., 20 means always keep at least 20% available)",
            );
            if (!reserveInput) return;

            const parsedReserve = parseReserveInput(reserveInput);
            if (parsedReserve === undefined) {
              notify(ctx, "error", RESERVE_INPUT_ERROR);
              return;
            }
            selectedReserve = parsedReserve;
          }
        }

        let combineName: string | undefined;
        if (
          actionChoice === "Combine bucket" ||
          actionChoice === "Combine by pattern"
        ) {
          const existingCombineNames = Array.from(
            new Set<string>(
              config.mappings
                .map((m: MappingEntry) => m.combine)
                .filter(
                  (name: unknown): name is string => typeof name === "string",
                ),
            ),
          ).sort();

          if (existingCombineNames.length > 0) {
            const options = [...existingCombineNames, "Enter new name..."];
            const choice = await selectWrapped(
              ctx,
              "Select combination group",
              options,
            );
            if (!choice) return;

            if (choice === "Enter new name...") {
              combineName = await ctx.ui.input(
                "Enter new combination group name (e.g. 'Codex Combined')",
              );
            } else {
              combineName = choice;
            }
          } else {
            combineName = await ctx.ui.input(
              "Enter combination group name (e.g. 'Codex Combined')",
            );
          }

          if (combineName != null) {
            combineName = combineName.trim();
          }

          if (!combineName) return;
        }

        // Build the usage descriptor for this candidate/pattern
        const usageDesc: MappingEntry["usage"] = {
          provider: selectedCandidate.provider,
        };

        if (selectedCandidate.account !== undefined) {
          usageDesc.account = selectedCandidate.account;
        }
        if (pattern) {
          usageDesc.windowPattern = pattern;
        } else {
          usageDesc.window = selectedCandidate.windowLabel;
        }

        let mappingEntry: MappingEntry;
        if (
          (actionChoice === "Map to model" ||
            actionChoice === "Map by pattern") &&
          selectedModel
        ) {
          mappingEntry = {
            usage: usageDesc,
            model: {
              provider: selectedModel.provider,
              id: selectedModel.id,
            },
            ...(selectedReserve !== undefined
              ? { reserve: selectedReserve }
              : {}),
          };
        } else if (combineName) {
          mappingEntry = {
            usage: usageDesc,
            combine: combineName,
          };
        } else {
          mappingEntry = {
            usage: usageDesc,
            ignore: true,
          };
        }

        try {
          clearBucketMappings(targetRaw, {
            provider: selectedCandidate.provider,
            ...(selectedCandidate.account !== undefined
              ? { account: selectedCandidate.account }
              : {}),
            window: selectedCandidate.windowLabel,
          });

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
          cachedUsages = null;
        }

        const actionSummary = mappingEntry.combine
          ? `Combined ${selectedCandidate.provider}/${pattern || selectedCandidate.windowLabel} into "${mappingEntry.combine}".`
          : mappingEntry.ignore
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
        widgetChoice = await selectWrapped(
          ctx,
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
        const placementChoice = await selectWrapped(
          ctx,
          `Widget placement (current: ${config.widget.placement})`,
          ["Above editor", "Below editor"],
        );
        if (!placementChoice) return;
        widgetUpdate.placement =
          placementChoice === "Above editor" ? "aboveEditor" : "belowEditor";
      } else if (widgetChoice === "Configure count") {
        const countChoice = await selectWrapped(
          ctx,
          `Number of candidates to show (current: ${config.widget.showCount})`,
          ["1", "2", "3", "4", "5"],
        );
        if (!countChoice) return;
        widgetUpdate.showCount = parseInt(countChoice, 10);
      }

      if (Object.keys(widgetUpdate).length === 0) return;

      const locationChoice = await selectWrapped(
        ctx,
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
        choice = await selectWrapped(
          ctx,
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

      const locationChoice = await selectWrapped(
        ctx,
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
        if (reloaded.debugLog) {
          config.debugLog = reloaded.debugLog;
        } else {
          delete config.debugLog;
        }
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
        choice = await selectWrapped(
          ctx,
          `Auto-run after every turn (current: ${currentStatus})`,
          [config.autoRun ? "Disable auto-run" : "Enable auto-run"],
        );
      if (!choice) return;

      const newValue = choice === "Enable auto-run",
        locationChoice = await selectWrapped(
          ctx,
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
      const locationChoice = await selectWrapped(
        ctx,
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
        ? (targetRaw.disabledProviders as unknown[]).filter(
            (value: unknown): value is ProviderName =>
              typeof value === "string" &&
              (ALL_PROVIDERS as readonly string[]).includes(value),
          )
        : [];

      const credentialChecks = await Promise.all(
        ALL_PROVIDERS.map((provider: ProviderName) =>
          hasProviderCredential(provider, piAuth, ctx.modelRegistry).then(
            (hasCredentials) => ({ provider, hasCredentials }),
          ),
        ),
      );

      const providerOptions: string[] = [];
      for (const { provider, hasCredentials } of credentialChecks) {
        const disabledInTarget = currentRawDisabled.includes(
          provider as ProviderName,
        );
        const providerLabel = PROVIDER_LABELS[provider as ProviderName];
        const mergedDisabled = config.disabledProviders.includes(
          provider as ProviderName,
        );

        let statusLabel = disabledInTarget ? "⏸ disabled" : "✅ enabled";
        if (disabledInTarget !== mergedDisabled) {
          statusLabel += ` (overall: ${mergedDisabled ? "disabled" : "enabled"})`;
        }

        providerOptions.push(
          `${statusLabel} ${providerLabel} (${provider}) — credentials: ${hasCredentials ? "detected" : "missing"}`,
        );
      }

      const selectedProviderLabel = await selectWrapped(
        ctx,
        `Configure providers in ${saveToProject ? "Project" : "Global"}`,
        providerOptions,
      );

      if (!selectedProviderLabel) return;
      const selectedIndex = providerOptions.indexOf(selectedProviderLabel);
      if (selectedIndex < 0) return;

      const selectedProvider = ALL_PROVIDERS[selectedIndex] as ProviderName,
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

      cachedUsages = null;

      const selectedProviderLabelFriendly =
        PROVIDER_LABELS[selectedProvider as ProviderName];
      const isActuallyDisabled =
        config.disabledProviders.includes(selectedProvider);
      const scopeLabel = saveToProject ? "Project" : "Global";

      notify(
        ctx,
        "info",
        `${nextDisabled ? "Disabled" : "Enabled"} ${selectedProviderLabelFriendly} in ${scopeLabel} config. Overall status: ${isActuallyDisabled ? "Disabled" : "Enabled"}.`,
      );
    },
    configureCleanup = async (): Promise<void> => {
      const locationChoice = await selectWrapped(
        ctx,
        "Select config file to clean",
        locationLabels,
      );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath,
        candidateRaw = JSON.parse(JSON.stringify(targetRaw)) as Record<
          string,
          unknown
        >,
        modelFinder =
          typeof ctx.modelRegistry?.find === "function"
            ? ctx.modelRegistry.find.bind(ctx.modelRegistry)
            : undefined;

      let availableModelKeys: Set<string> | null = null;
      if (typeof ctx.modelRegistry?.getAvailable === "function") {
        try {
          const availableModels = await Promise.resolve(
            ctx.modelRegistry.getAvailable(),
          );
          availableModelKeys = new Set(
            availableModels.map(
              (model) => `${model.provider}\u0000${model.id}`,
            ),
          );
        } catch {
          // If availability cannot be loaded, fall back to find() when possible.
        }
      }

      const modelExists =
        availableModelKeys !== null
          ? (provider: string, id: string) =>
              availableModelKeys.has(`${provider}\u0000${id}`)
          : modelFinder
            ? (provider: string, id: string) => {
                try {
                  return Boolean(modelFinder(provider, id));
                } catch (error) {
                  writeDebugLog(
                    `Error while checking model existence for ${provider}/${id}: ${String(
                      error,
                    )}`,
                  );
                  throw error;
                }
              }
            : undefined;

      const cleanupResult = cleanupConfigRaw(candidateRaw, {
        scope: saveToProject ? "project" : "global",
        ...(modelExists ? { modelExists } : {}),
      });

      const cleanupSummary = [...cleanupResult.summary],
        autoDisabledProviders: ProviderName[] = [];

      const mappedUsageProviders = new Set(
        (Array.isArray(candidateRaw.mappings) ? candidateRaw.mappings : [])
          .map((entry) => {
            if (!entry || typeof entry !== "object") return undefined;
            const usage = (entry as { usage?: { provider?: unknown } }).usage;
            return usage?.provider;
          })
          .filter(
            (provider): provider is string => typeof provider === "string",
          )
          .filter((p): p is ProviderName =>
            ALL_PROVIDERS.includes(p as ProviderName),
          ),
      );

      if (mappedUsageProviders.size > 0) {
        const piAuth = await loadAuth();
        const existingDisabled = Array.isArray(candidateRaw.disabledProviders)
          ? candidateRaw.disabledProviders
              .filter((value): value is string => typeof value === "string")
              .filter((p): p is ProviderName =>
                ALL_PROVIDERS.includes(p as ProviderName),
              )
          : [];
        const disabledSet = new Set<ProviderName>(existingDisabled);

        for (const provider of mappedUsageProviders) {
          if (disabledSet.has(provider)) continue;
          const hasCredential = await hasProviderCredential(
            provider,
            piAuth,
            ctx.modelRegistry,
          );
          if (!hasCredential) {
            disabledSet.add(provider);
            autoDisabledProviders.push(provider);
          }
        }

        if (autoDisabledProviders.length > 0) {
          candidateRaw.disabledProviders = [...disabledSet];
          const providerLabels = autoDisabledProviders.map(
            (provider) => `${PROVIDER_LABELS[provider]} (${provider})`,
          );
          cleanupSummary.push(
            `Disabled ${autoDisabledProviders.length} provider${autoDisabledProviders.length === 1 ? "" : "s"} with missing credentials: ${providerLabels.join(", ")}.`,
          );
        }
      }

      const changed = cleanupResult.changed || autoDisabledProviders.length > 0;
      if (!changed) {
        notify(ctx, "info", `No cleanup changes needed for ${targetPath}.`);
        return;
      }

      const summaryLines = cleanupSummary.map((item) => `• ${item}`),
        confirmed = await ctx.ui.confirm(
          "Apply config cleanup?",
          `This will update ${targetPath}:\n${summaryLines.join("\n")}`,
        );
      if (!confirmed) {
        notify(ctx, "info", "Config cleanup cancelled.");
        return;
      }

      try {
        await saveConfigFile(targetPath, candidateRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      const reloaded = await loadConfig(ctx, { requireMappings: false });
      if (reloaded) {
        config.mappings = reloaded.mappings;
        config.priority = reloaded.priority;
        config.widget = reloaded.widget;
        config.autoRun = reloaded.autoRun;
        config.disabledProviders = reloaded.disabledProviders;
        if (reloaded.debugLog) {
          config.debugLog = reloaded.debugLog;
        } else {
          delete config.debugLog;
        }
        config.raw = reloaded.raw;
      }

      cachedUsages = null;
      notify(
        ctx,
        "info",
        `Config cleanup applied to ${targetPath}: ${cleanupSummary.join(" ")}`,
      );
    },
    configureFallback = async (): Promise<void> => {
      const availableModels = await loadModels();
      if (!availableModels) return;

      const currentFallback = config.fallback;
      const currentDesc = currentFallback
        ? `${currentFallback.provider}/${currentFallback.id} (lock: ${currentFallback.lock !== false})`
        : "not set";

      const actionChoice = await selectWrapped(
        ctx,
        `Fallback model (current: ${currentDesc})`,
        [
          "Set fallback model",
          ...(currentFallback ? ["Clear fallback model"] : []),
        ],
      );
      if (!actionChoice) return;

      if (actionChoice === "Clear fallback model") {
        const locationChoice = await selectWrapped(
          ctx,
          "Clear fallback from",
          locationLabels,
        );
        if (!locationChoice) return;

        const saveToProject = locationChoice === locationLabels[1],
          targetRaw = saveToProject ? config.raw.project : config.raw.global,
          targetPath = saveToProject
            ? config.sources.projectPath
            : config.sources.globalPath;

        try {
          delete targetRaw.fallback;
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
          if (reloaded.fallback) {
            config.fallback = reloaded.fallback;
          } else {
            delete config.fallback;
          }
        }

        notify(ctx, "info", "Fallback model cleared.");
        return;
      }

      // Set fallback model
      const modelLabels = availableModels.map(
        (model) => `${model.provider}/${model.id}`,
      );
      const modelChoice = await selectWrapped(
        ctx,
        "Select fallback model",
        modelLabels,
      );
      if (!modelChoice) return;

      const modelIndex = modelLabels.indexOf(modelChoice);
      if (modelIndex < 0) return;
      const selectedModel = availableModels[modelIndex];
      if (!selectedModel) return;

      const lockChoice = await selectWrapped(
        ctx,
        "Acquire cross-instance lock for fallback? (recommended for most models)",
        ["Yes — acquire lock (default)", "No — allow concurrent use"],
      );
      if (!lockChoice) return;

      const useLock = lockChoice.startsWith("Yes");

      const locationChoice = await selectWrapped(
        ctx,
        "Save fallback to",
        locationLabels,
      );
      if (!locationChoice) return;

      const saveToProject = locationChoice === locationLabels[1],
        targetRaw = saveToProject ? config.raw.project : config.raw.global,
        targetPath = saveToProject
          ? config.sources.projectPath
          : config.sources.globalPath;

      try {
        targetRaw.fallback = {
          provider: selectedModel.provider,
          id: selectedModel.id,
          lock: useLock,
        };
        await saveConfigFile(targetPath, targetRaw);
      } catch (error: unknown) {
        notify(ctx, "error", `Failed to write ${targetPath}: ${String(error)}`);
        return;
      }

      const reloaded = await loadConfig(ctx, { requireMappings: false });
      if (reloaded) {
        if (reloaded.fallback) {
          config.fallback = reloaded.fallback;
        } else {
          delete config.fallback;
        }
      }

      notify(
        ctx,
        "info",
        `Fallback model set to ${selectedModel.provider}/${selectedModel.id} (lock: ${useLock}).`,
      );
    },
    menuOptions = [
      "Edit mappings",
      "Configure providers",
      "Configure priority",
      "Configure fallback",
      "Configure widget",
      "Configure auto-run",
      "Configure debug log",
      "Clean up config",
      "Done",
    ];

  while (true) {
    const action = await selectWrapped(
      ctx,
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

    if (action === "Configure fallback") {
      await configureFallback();
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

    if (action === "Clean up config") {
      await configureCleanup();
      // biome-ignore lint/complexity/noUselessContinue: consistency with other handlers
      continue;
    }
  }
}

export { runMappingWizard };
