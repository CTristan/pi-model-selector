import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  buildCandidates,
  combineCandidates,
  findIgnoreMapping,
  sortCandidates,
} from "./src/candidates.js";
import { loadConfig } from "./src/config.js";
import { CooldownManager } from "./src/cooldown.js";

import { createModelLockCoordinator } from "./src/model-locks.js";
import { runSelector, type SelectorReason } from "./src/selector.js";
import type { LoadedConfig, UsageSnapshot } from "./src/types.js";
import { notify, writeDebugLog } from "./src/types.js";
import { fetchAllUsages } from "./src/usage-fetchers.js";
import { renderUsageWidget, updateWidgetState } from "./src/widget.js";
import { runMappingWizard } from "./src/wizard.js";

// ============================================================================
// Extension Hook
// ============================================================================

export default function modelSelectorExtension(pi: ExtensionAPI) {
  const cooldownManager = new CooldownManager();
  const modelLockCoordinator = createModelLockCoordinator();

  const modelLockStatusKey = "model-selector-lock";

  const lockHeartbeatTimer = { current: null as NodeJS.Timeout | null };
  let autoSelectionDisabled = false; // Session-scoped flag to disable auto model selection

  const setLockStatus = (ctx: ExtensionContext, message?: string): void => {
      if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
      ctx.ui.setStatus(modelLockStatusKey, message);
    },
    stopLockHeartbeat = (): void => {
      if (lockHeartbeatTimer.current) {
        clearInterval(lockHeartbeatTimer.current);
        lockHeartbeatTimer.current = null;
      }
    },
    releaseActiveModelLock = async (): Promise<void> => {
      const lockKey = activeModelLockKey.current;
      if (!lockKey) return;
      activeModelLockKey.current = null;
      stopLockHeartbeat();
      try {
        await modelLockCoordinator.release(lockKey);
      } catch (err) {
        writeDebugLog(
          `Error while releasing model lock for key "${lockKey}": ${String(err)}`,
        );
      }
    },
    activeModelLockKey = { current: null as string | null };

  let running = false;

  // Flag to track self-initiated model changes (so we don't pause when WE call setModel)
  const selfInitiatedModelChange = { current: false };

  const runSelectorWrapper = async (
    ctx: ExtensionContext,
    reason: SelectorReason,
    options: {
      preloadedConfig?: LoadedConfig;
      preloadedUsages?: UsageSnapshot[];
      acquireModelLock?: boolean;
      waitForModelLock?: boolean;
    } = {},
  ): Promise<boolean> => {
    if (running) {
      if (reason !== "request") {
        notify(ctx, "warning", "Model selector is already running.");
      }
      return false;
    }
    running = true;

    try {
      const result = await runSelector(
        ctx,
        cooldownManager,
        modelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        autoSelectionDisabled,
        reason,
        options,
        pi,
        selfInitiatedModelChange,
      );
      return result;
    } finally {
      if (options.acquireModelLock) {
        setLockStatus(ctx);
      }
      running = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    void _event;
    // Check for --model CLI flag - if passed, skip auto-selection entirely for this session
    if (process.argv.includes("--model")) {
      autoSelectionDisabled = true;
      writeDebugLog("Auto-selection disabled: --model CLI flag detected");
      // Ensure any existing widget reflects that auto-selection is disabled
      try {
        const { getWidgetState } = await import("./src/widget.js");
        const state = getWidgetState();
        if (state) {
          updateWidgetState({ ...state, autoSelectionDisabled: true });
          renderUsageWidget(ctx);
        }
      } catch (err) {
        // Widget updates are best-effort; log and continue
        writeDebugLog(
          `Failed to update widget state after disabling auto-selection: ${String(
            err,
          )}`,
        );
      }
      return;
    }
    // Skip model selection if auto-selection is disabled for this session
    if (autoSelectionDisabled) {
      writeDebugLog("Skipping model selection: auto-selection is disabled");
      return;
    }
    await runSelectorWrapper(ctx, "startup");
  });

  // Handle explicit model selection events - pause auto-selection when user or external extension chooses a model
  pi.on("model_select", async (event, ctx) => {
    // If this is our own model change, ignore it
    // Don't clear the flag here - let the setModel caller (in selector.ts) handle it
    // This prevents multiple model_select events from breaking the guard window
    if (selfInitiatedModelChange.current) {
      return;
    }
    // Session restore is not an explicit choice
    if (event.source === "restore") {
      return;
    }
    // "set" (external extension) or "cycle" (user via Ctrl+P/Ctrl+L) - pause auto-selection
    if (event.source === "set" || event.source === "cycle") {
      autoSelectionDisabled = true;
      writeDebugLog(
        `Auto-selection paused: model explicitly selected (source: ${event.source})`,
      );
      // Update widget to reflect paused state
      const { getWidgetState } = await import("./src/widget.js");
      const state = getWidgetState();
      if (state) {
        updateWidgetState({ ...state, autoSelectionDisabled: true });
        renderUsageWidget(ctx);
      }
      // Notify user (skip for CLI subprocesses which have no UI)
      if (ctx.hasUI) {
        notify(
          ctx,
          "info",
          "Auto model selection paused: model was explicitly selected. Use /model-select or start a new session to resume.",
        );
      }
    }
  });

  pi.on("session_switch" as any, async (event: any, ctx: any) => {
    if (event.reason === "new" || event.reason === "resume") {
      // Re-enable auto-selection on session switch (new/resume)
      autoSelectionDisabled = false;
      writeDebugLog("Auto-selection re-enabled on session switch");
      // Skip model selection if auto-selection is disabled for this session
      if (autoSelectionDisabled) {
        writeDebugLog("Skipping model selection: auto-selection is disabled");
        return;
      }
      await runSelectorWrapper(ctx, "startup");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    void _event;
    // Skip model selection if auto-selection is disabled for this session.
    // Maintain cross-instance coordination by acquiring a lock for the current
    // model, keeping an existing lock if it already matches, or swapping to
    // a new lock if the model has changed.
    if (autoSelectionDisabled) {
      writeDebugLog("Skipping model selection: auto-selection is disabled");
      const lockingConfig = await loadConfig(ctx, {
        requireMappings: false,
        seedGlobal: false,
      });
      if (lockingConfig && !lockingConfig.enableModelLocking) {
        // Release any lock/heartbeat carried over from a prior run with locking
        // enabled so the coordinator stops touching model-locks.json.
        await releaseActiveModelLock();
        writeDebugLog(
          "Skipping cross-instance lock acquisition: enableModelLocking is false",
        );
        return;
      }
      // If we have an active lock that matches the current model, keep it.
      // Otherwise, acquire a lock for the current model to maintain coordination.
      if (ctx.model) {
        const { modelLockKey } = await import("./src/model-locks.js");
        const currentModelKey = modelLockKey(ctx.model.provider, ctx.model.id);
        if (activeModelLockKey.current !== currentModelKey) {
          // Try to acquire the new lock first, then release the old lock.
          // This ensures we never run without coordination if the lock is busy.
          const oldLockKey = activeModelLockKey.current;
          try {
            const acquireResult =
              await modelLockCoordinator.acquire(currentModelKey);
            if (!acquireResult.acquired) {
              const heldByMsg = acquireResult.heldBy
                ? ` (held by ${acquireResult.heldBy.instanceId}, pid ${acquireResult.heldBy.pid})`
                : "";
              notify(
                ctx,
                "warning",
                `Model lock for current model ${ctx.model.provider}/${ctx.model.id} is busy${heldByMsg}. Cross-instance coordination may be impaired.`,
              );
              writeDebugLog(
                `Lock for current model ${ctx.model.provider}/${ctx.model.id} is busy${heldByMsg}; releasing existing lock "${oldLockKey ?? "none"}" to avoid stale lock.`,
              );
              await releaseActiveModelLock();
              return;
            }
            activeModelLockKey.current = currentModelKey;
            startLockHeartbeat(currentModelKey);
            if (oldLockKey) {
              await modelLockCoordinator.release(oldLockKey);
            }
            writeDebugLog(
              `Acquired lock for current model ${ctx.model.provider}/${ctx.model.id}`,
            );
          } catch (err) {
            notify(
              ctx,
              "error",
              `Failed to acquire lock for current model ${ctx.model.provider}/${ctx.model.id}: ${String(err)}. Cross-instance coordination may be impaired.`,
            );
            writeDebugLog(
              `Failed to acquire lock for current model ${ctx.model.provider}/${ctx.model.id}: ${String(err)}`,
            );
          }
        } else {
          writeDebugLog(
            `Keeping existing lock for current model ${ctx.model.provider}/${ctx.model.id}`,
          );
        }
      }
      return;
    }
    await releaseActiveModelLock();
    await runSelectorWrapper(ctx, "request", {
      acquireModelLock: true,
      waitForModelLock: true,
    });
  });

  pi.on("agent_end", async (_event, ctx) => {
    await releaseActiveModelLock();
    const config = await loadConfig(ctx, { requireMappings: false });
    if (config?.autoRun) {
      // Skip auto-run if auto-selection is disabled
      if (autoSelectionDisabled) {
        writeDebugLog("Skipping auto-run: auto-selection is disabled");
        return;
      }
      await runSelectorWrapper(ctx, "auto", { preloadedConfig: config });
    }
  });

  pi.on("session_shutdown", async () => {
    await releaseActiveModelLock();
    await modelLockCoordinator.releaseAll();
    autoSelectionDisabled = false; // Reset session-scoped flag
  });

  pi.registerCommand("model-select", {
    description: "Select the best starting model based on quota usage",
    handler: async (_args, ctx) => {
      void _args;
      // Re-enable auto-selection if it was paused
      if (autoSelectionDisabled) {
        autoSelectionDisabled = false;
        writeDebugLog("Auto-selection re-enabled via /model-select command");
        // Update widget to reflect resumed state
        const { getWidgetState } = await import("./src/widget.js");
        const state = getWidgetState();
        if (state) {
          updateWidgetState({ ...state, autoSelectionDisabled: false });
          renderUsageWidget(ctx);
        }
        notify(ctx, "info", "Auto model selection re-enabled.");
      }
      const config = await loadConfig(ctx);
      if (!config) return;
      await runSelectorWrapper(ctx, "command", { preloadedConfig: config });
      if (!config.enableModelLocking) {
        notify(ctx, "info", "Model locking: disabled.");
      }
    },
  });

  pi.registerCommand("model-select-config", {
    description: "Configure mappings, providers, and widget settings",
    handler: async (_args, ctx) => {
      void _args;
      await runMappingWizard(ctx);
    },
  });

  pi.registerCommand("model-skip", {
    description:
      "Skip the current best model for 1 hour and select the next best",
    handler: async (_args, ctx) => {
      void _args;
      // Load persisted state first (for print-mode support)
      await cooldownManager.loadPersistedCooldowns();

      const config = await loadConfig(ctx);
      if (!config) return;

      const usages = await fetchAllUsages(
        ctx.modelRegistry,
        config.disabledProviders,
        config.providerSettings,
      );

      const { candidateKey } = await import("./src/candidates.js");

      let lastSelectedCandidateKey = cooldownManager.getLastSelectedKey();

      if (!lastSelectedCandidateKey) {
        const candidates = combineCandidates(
          buildCandidates(usages),
          config.mappings,
        );
        const eligible = candidates.filter(
          (c) =>
            !findIgnoreMapping(c, config.mappings) && c.remainingPercent > 0,
        );
        const ranked = sortCandidates(
          eligible,
          config.priority,
          config.mappings,
        );
        if (ranked.length > 0) {
          const topCandidate = ranked[0];
          if (topCandidate) {
            lastSelectedCandidateKey = candidateKey(topCandidate);
          }
        }
      }

      if (lastSelectedCandidateKey) {
        // Check if the last selected model is the fallback
        if (lastSelectedCandidateKey.startsWith("fallback:")) {
          notify(
            ctx,
            "warning",
            "Cannot skip the fallback model. The fallback is exempt from cooldowns.",
          );
          return;
        }

        cooldownManager.addCooldown(lastSelectedCandidateKey);
        await cooldownManager.persistCooldowns(); // Save to file immediately
        notify(
          ctx,
          "info",
          `Added temporary cooldown (1h) for usage bucket: ${lastSelectedCandidateKey}`,
        );
        lastSelectedCandidateKey = null;
        cooldownManager.setLastSelectedKey(null);
        // Run selector with pre-fetched usages to avoid second network roundtrip
        await runSelectorWrapper(ctx, "command", {
          preloadedConfig: config,
          preloadedUsages: usages,
        });
        // Explicitly refresh widget to show updated cooldown state
        const { getWidgetState } = await import("./src/widget.js");
        const state = getWidgetState();
        if (state) {
          updateWidgetState({ ...state, config });
          renderUsageWidget(ctx);
        }
      } else {
        notify(ctx, "error", "Could not determine a candidate to skip.");
      }
    },
  });

  pi.registerCommand("model-unskip", {
    description:
      "Remove all skip cooldowns and re-enable skipped models for selection",
    handler: async (_args, ctx) => {
      void _args;
      // Load persisted state first (for print-mode support)
      await cooldownManager.loadPersistedCooldowns();

      const removedCount = cooldownManager.clearSkipCooldowns();
      await cooldownManager.persistCooldowns();

      if (removedCount > 0) {
        notify(
          ctx,
          "info",
          `Cleared ${removedCount} skip cooldown(s). Skipped models are now eligible.`,
        );
        // Re-run selection to pick from the newly un-skipped models
        const config = await loadConfig(ctx);
        if (config) {
          const usages = await fetchAllUsages(
            ctx.modelRegistry,
            config.disabledProviders,
            config.providerSettings,
          );
          await runSelectorWrapper(ctx, "command", {
            preloadedConfig: config,
            preloadedUsages: usages,
          });
          // Explicitly refresh widget to show updated cooldown state
          const { getWidgetState } = await import("./src/widget.js");
          const state = getWidgetState();
          if (state) {
            updateWidgetState({ ...state, config });
            renderUsageWidget(ctx);
          }
        }
      } else {
        notify(ctx, "info", "No skip cooldowns to clear.");
        // Still refresh widget to reflect current state
        const config = await loadConfig(ctx);
        if (config) {
          const { getWidgetState } = await import("./src/widget.js");
          const state = getWidgetState();
          if (state) {
            updateWidgetState({ ...state, config });
            renderUsageWidget(ctx);
          }
        }
      }
    },
  });

  pi.registerCommand("model-auto-toggle", {
    description: "Toggle auto model selection on/off for this session",
    handler: async (_args, ctx) => {
      void _args;
      const config = await loadConfig(ctx, { requireMappings: false });
      if (!config) return;

      autoSelectionDisabled = !autoSelectionDisabled;

      if (autoSelectionDisabled) {
        notify(
          ctx,
          "info",
          "Auto model selection disabled for this session. Use Pi's built-in model selection to choose a model manually.",
        );
        // Refresh widget to show the disabled status
        const { getWidgetState } = await import("./src/widget.js");
        const state = getWidgetState();
        if (state) {
          updateWidgetState({ ...state, autoSelectionDisabled: true });
          renderUsageWidget(ctx);
        }
      } else {
        notify(
          ctx,
          "info",
          "Auto model selection enabled for this session. The extension will now automatically select the best model.",
        );
        // Re-enable auto-selection and run it immediately
        const { getWidgetState } = await import("./src/widget.js");
        const state = getWidgetState();
        if (state) {
          updateWidgetState({ ...state, autoSelectionDisabled: false });
          renderUsageWidget(ctx);
        }
        await runSelectorWrapper(ctx, "command");
      }
    },
  });

  function startLockHeartbeat(lockKey: string): void {
    stopLockHeartbeat();

    const MODEL_LOCK_HEARTBEAT_MS = 5000;
    let heartbeatInProgress = false;

    lockHeartbeatTimer.current = setInterval(() => {
      void (async () => {
        if (heartbeatInProgress) {
          return;
        }

        try {
          heartbeatInProgress = true;
          const stillHeld = await modelLockCoordinator.refresh(lockKey);
          if (!stillHeld) {
            if (activeModelLockKey.current === lockKey) {
              activeModelLockKey.current = null;
            }
            stopLockHeartbeat();
            writeDebugLog(
              `Model lock heartbeat lost lock for key "${lockKey}", stopping heartbeat.`,
            );
          }
        } catch (err) {
          stopLockHeartbeat();
          writeDebugLog(
            `Error while refreshing model lock heartbeat for key "${lockKey}": ${String(err)}`,
          );
        } finally {
          heartbeatInProgress = false;
        }
      })();
    }, MODEL_LOCK_HEARTBEAT_MS);
    lockHeartbeatTimer.current.unref?.();
  }
}

// Re-export cooldown functions for backward compatibility with tests
export { loadCooldownState, saveCooldownState } from "./src/cooldown.js";
