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
    // Skip model selection if auto-selection is disabled for this session
    if (autoSelectionDisabled) {
      writeDebugLog("Skipping model selection: auto-selection is disabled");
      return;
    }
    await runSelectorWrapper(ctx, "startup");
  });

  pi.on("session_switch", async (event, ctx) => {
    if (event.reason === "new" || event.reason === "resume") {
      // Skip model selection if auto-selection is disabled for this session
      if (autoSelectionDisabled) {
        writeDebugLog("Skipping model selection: auto-selection is disabled");
        return;
      }
      await runSelectorWrapper(ctx, "startup");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Skip model selection if auto-selection is disabled for this session.
    // Maintain cross-instance coordination by acquiring a lock for the current
    // model, keeping an existing lock if it already matches, or swapping to
    // a new lock if the model has changed.
    if (autoSelectionDisabled) {
      writeDebugLog("Skipping model selection: auto-selection is disabled");
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
      await runSelectorWrapper(ctx, "command");
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
          lastSelectedCandidateKey = candidateKey(ranked[0]);
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
      } else {
        notify(ctx, "error", "Could not determine a candidate to skip.");
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
