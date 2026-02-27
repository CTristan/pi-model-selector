import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  buildCandidates,
  candidateKey,
  combineCandidates,
  findIgnoreMapping,
  findModelMapping,
  selectionReason,
  sortCandidates,
} from "./candidates.js";

import { loadConfig } from "./config.js";
import type { CooldownManager } from "./cooldown.js";

import {
  createModelLockCoordinator as createModelLockCoordinatorImpl,
  modelLockKey,
} from "./model-locks.js";

import type {
  LoadedConfig,
  MappingEntry,
  UsageCandidate,
  UsageSnapshot,
} from "./types.js";
import {
  ALL_PROVIDERS,
  notify,
  setGlobalConfig,
  writeDebugLog,
} from "./types.js";
import { isProviderIgnored } from "./ui-helpers.js";
import { fetchAllUsages } from "./usage-fetchers.js";
import { clearWidget, renderUsageWidget, updateWidgetState } from "./widget.js";

const MODEL_LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_LOCK_POLL_MS = 1250;

export interface SelectorOptions {
  preloadedConfig?: LoadedConfig;
  preloadedUsages?: UsageSnapshot[];
  acquireModelLock?: boolean;
  waitForModelLock?: boolean;
}

export interface SelectorResult {
  success: boolean;
  model?: { provider: string; id: string };
}

export interface ModelLockCoordinator {
  acquire(
    key: string,
    options?: { timeoutMs?: number },
  ): Promise<{
    acquired: boolean;
    heldBy?: {
      instanceId: string;
      pid: number;
      acquiredAt: number;
      heartbeatAt: number;
    };
  }>;
  refresh(key: string): Promise<boolean>;
  release(key: string): Promise<boolean>;
  releaseAll(): Promise<number>;
}

export type SelectorReason = "startup" | "command" | "auto" | "request";

export function createModelLockCoordinator(): ModelLockCoordinator {
  return createModelLockCoordinatorImpl();
}

export async function runSelector(
  ctx: ExtensionContext,
  cooldownManager: CooldownManager,
  modelLockCoordinator: ModelLockCoordinator,
  lockHeartbeatTimer: { current: NodeJS.Timeout | null },
  activeModelLockKey: { current: string | null },
  autoSelectionDisabled: boolean,
  reason: SelectorReason,
  options: SelectorOptions = {},
  pi: ExtensionAPI,
): Promise<boolean> {
  let lockKeyForErrorCleanup: string | undefined;

  try {
    // Load persisted cooldowns on startup (for print-mode support)
    await cooldownManager.loadPersistedCooldowns();

    const config = options.preloadedConfig || (await loadConfig(ctx));
    if (!config) return false;
    setGlobalConfig(config);
    writeDebugLog(`Running selector (reason: ${reason})`);

    const mappedUsageProviders = new Set(
        config.mappings.map((mapping) => mapping.usage.provider),
      ),
      implicitDisabledProviders = ALL_PROVIDERS.filter(
        (provider) => !mappedUsageProviders.has(provider),
      ),
      effectiveDisabledProviders = [
        ...new Set([...config.disabledProviders, ...implicitDisabledProviders]),
      ],
      usages =
        options.preloadedUsages ||
        (await fetchAllUsages(ctx.modelRegistry, effectiveDisabledProviders));

    // Clean up stale cooldowns first so fresh 429s can always re-arm cooldowns.
    cooldownManager.pruneExpiredCooldowns();

    // Apply 429 cooldowns for all usages (including preloaded)
    // This ensures rate-limit detection works even when /model-skip provides preloaded usages
    let saveNeeded = false;
    const now = Date.now();

    for (const usage of usages) {
      // Detect 429 errors and apply provider-wide cooldown
      // Skip ignored providers to avoid noisy UX for intentionally-ignored providers
      if (usage.error?.includes("429")) {
        if (
          !isProviderIgnored(usage.provider, usage.account, config.mappings)
        ) {
          const updated = cooldownManager.setOrExtendProviderCooldown(
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
      }
    }

    if (saveNeeded) {
      await cooldownManager.persistCooldowns();
    }

    // Show error notifications only for non-preloaded usages
    if (!options.preloadedUsages) {
      for (const usage of usages) {
        if (
          usage.error &&
          !usage.error.includes("429") &&
          !isProviderIgnored(usage.provider, usage.account, config.mappings)
        ) {
          // Suppress warnings if provider is already on cooldown
          const wildcardExpiry = cooldownManager.getWildcardExpiry(
            usage.provider,
            usage.account,
          );

          if (!wildcardExpiry || wildcardExpiry <= now) {
            notify(
              ctx,
              "warning",
              `Usage check failed for ${usage.displayName}: ${usage.error}`,
            );
          }
        }
      }
    }

    // Clean up any cooldowns that may have just expired.
    cooldownManager.pruneExpiredCooldowns();

    const candidates = combineCandidates(
      buildCandidates(usages),
      config.mappings,
    );
    let eligibleCandidates = candidates.filter(
      (candidate: UsageCandidate) =>
        !findIgnoreMapping(candidate, config.mappings),
    );

    // Filter out cooldowns - reuse the now captured earlier for consistency
    const cooldownCount = eligibleCandidates.filter((c: UsageCandidate) =>
      cooldownManager.isOnCooldown(c, now),
    ).length;
    if (cooldownCount > 0) {
      eligibleCandidates = eligibleCandidates.filter(
        (c: UsageCandidate) => !cooldownManager.isOnCooldown(c, now),
      );
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
        cooldownManager.clear();
        await cooldownManager.persistCooldowns();
        eligibleCandidates = candidates.filter(
          (candidate: UsageCandidate) =>
            !findIgnoreMapping(candidate, config.mappings),
        );
      } else {
        const detail =
          candidates.length === 0
            ? "No usage windows found. Check provider credentials and connectivity."
            : "All usage buckets are ignored. Remove an ignore mapping or add a model mapping.";
        notify(ctx, "error", detail);
        clearWidget(ctx);
        return false;
      }
    }

    // Save candidates for widget display (includes exhausted buckets)
    const displayCandidates = eligibleCandidates.slice();

    // Hard filter: never pick fully exhausted buckets for model selection.
    eligibleCandidates = eligibleCandidates.filter(
      (candidate: UsageCandidate) => candidate.remainingPercent > 0,
    );

    // Sort display candidates for the widget (includes exhausted buckets)
    const rankedDisplayCandidates = sortCandidates(
      displayCandidates,
      config.priority,
      config.mappings,
    );

    // Update widget with all non-ignored, non-cooldown candidates (including exhausted)
    updateWidgetState({
      candidates: rankedDisplayCandidates,
      config,
      autoSelectionDisabled,
    });
    renderUsageWidget(ctx);

    if (eligibleCandidates.length === 0) {
      // All candidates are exhausted - check for fallback model
      return await handleExhaustedCandidates(
        ctx,
        config,
        pi,
        modelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
        lockKeyForErrorCleanup,
        cooldownManager,
        autoSelectionDisabled,
      );
    }

    // Rank eligible candidates (excluded exhausted) for model selection
    const rankedCandidates = sortCandidates(
      eligibleCandidates,
      config.priority,
      config.mappings,
    );

    const initialBest = rankedCandidates[0];
    if (!initialBest) {
      notify(ctx, "error", "Unable to determine a best usage window.");
      return false;
    }

    let best = initialBest,
      bestIndex = 0,
      mapping = findModelMapping(best, config.mappings),
      model =
        mapping?.model &&
        ctx.modelRegistry.find(mapping.model.provider, mapping.model.id),
      lockKey: string | undefined,
      waitedForLockMs = 0;

    if (options.acquireModelLock) {
      const lockResult = await acquireModelLock(
        ctx,
        config,
        modelLockCoordinator,
        rankedCandidates,
        options.waitForModelLock || false,
        activeModelLockKey,
      );

      if (!lockResult.selected) {
        return false;
      }

      best = lockResult.selected.candidate;
      bestIndex = lockResult.selected.index;
      mapping = lockResult.selected.mapping;
      model = lockResult.selected.model;
      lockKey = lockResult.selected.lockKey;
      lockKeyForErrorCleanup = lockKey;
      waitedForLockMs = lockResult.waitedForLockMs;
    }

    const fallbackConfig = config.fallback;
    const isFallbackSelection =
      !!fallbackConfig &&
      best.windowLabel === "fallback" &&
      mapping?.model?.provider === fallbackConfig.provider &&
      mapping?.model?.id === fallbackConfig.id;

    const lastSelectedKey =
      isFallbackSelection && fallbackConfig
        ? `fallback:${fallbackConfig.provider}/${fallbackConfig.id}`
        : candidateKey(best);

    cooldownManager.setLastSelectedKey(lastSelectedKey);
    await cooldownManager.persistCooldowns(); // Save state for print-mode support

    return await finalizeSelection(
      ctx,
      pi,
      best,
      bestIndex,
      mapping,
      model,
      lockKey,
      config,
      rankedCandidates,
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      waitedForLockMs,
      reason,
    );
  } catch (error: unknown) {
    if (lockKeyForErrorCleanup) {
      try {
        await modelLockCoordinator.release(lockKeyForErrorCleanup);
      } catch {
        // Best-effort cleanup of partially acquired lock.
      }
    }

    const errorMessage = String(error);
    writeDebugLog(`runSelector failed (reason: ${reason}): ${errorMessage}`);
    notify(
      ctx,
      "error",
      reason === "request"
        ? `Model selection failed before request start: ${errorMessage}`
        : `Model selection failed: ${errorMessage}`,
    );
    return false;
  }
}

async function handleExhaustedCandidates(
  ctx: ExtensionContext,
  config: LoadedConfig,
  pi: ExtensionAPI,
  modelLockCoordinator: ModelLockCoordinator,
  lockHeartbeatTimer: { current: NodeJS.Timeout | null },
  activeModelLockKey: { current: string | null },
  _lockKeyForErrorCleanup: string | undefined,
  cooldownManager: CooldownManager,
  _autoSelectionDisabled: boolean,
): Promise<boolean> {
  void _lockKeyForErrorCleanup;
  void _autoSelectionDisabled;

  if (!config.fallback) {
    notify(
      ctx,
      "error",
      "All non-ignored usage buckets are exhausted (0% remaining).",
    );
    return false;
  }

  writeDebugLog("All candidates exhausted, attempting fallback model");
  const fallbackModel = ctx.modelRegistry.find(
    config.fallback.provider,
    config.fallback.id,
  );
  if (!fallbackModel) {
    notify(
      ctx,
      "error",
      `Fallback model not found: ${config.fallback.provider}/${config.fallback.id}.`,
    );
    return false;
  }

  let fallbackLockKey: string | undefined;
  if (config.fallback.lock !== false) {
    const lockKey = modelLockKey(config.fallback.provider, config.fallback.id);
    const result = await modelLockCoordinator.acquire(lockKey, {
      timeoutMs: 0,
    });
    if (!result.acquired) {
      notify(ctx, "error", "Fallback model lock is busy.");
      return false;
    }
    fallbackLockKey = lockKey;
  }

  const current = ctx.model,
    isAlreadySelected =
      current &&
      current.provider === config.fallback.provider &&
      current.id === config.fallback.id;

  if (!isAlreadySelected) {
    const success = await pi.setModel(fallbackModel);
    if (!success) {
      notify(
        ctx,
        "error",
        `Failed to set fallback model to ${config.fallback.provider}/${config.fallback.id}. Check provider status or credentials.`,
      );
      if (fallbackLockKey) {
        await modelLockCoordinator.release(fallbackLockKey);
      }
      return false;
    }
  }

  if (fallbackLockKey) {
    if (
      activeModelLockKey.current &&
      activeModelLockKey.current !== fallbackLockKey
    ) {
      await releaseActiveModelLock(
        modelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
      );
    }
    activeModelLockKey.current = fallbackLockKey;
    startLockHeartbeat(
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      fallbackLockKey,
    );
  }

  if (config.fallback.lock === false && activeModelLockKey.current) {
    await releaseActiveModelLock(
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
    );
  }

  notify(
    ctx,
    "info",
    `Set model to ${config.fallback.provider}/${config.fallback.id} (last-resort fallback; all quota-tracked models exhausted)`,
  );

  // Set a synthetic candidate key to avoid confusing cooldown state
  cooldownManager.setLastSelectedKey(
    `fallback:${config.fallback.provider}/${config.fallback.id}`,
  );
  await cooldownManager.persistCooldowns();

  return true;
}

async function acquireModelLock(
  ctx: ExtensionContext,
  config: LoadedConfig,
  modelLockCoordinator: ModelLockCoordinator,
  rankedCandidates: UsageCandidate[],
  waitForLock: boolean,
  _activeModelLockKey: { current: string | null },
): Promise<{
  selected?: {
    candidate: UsageCandidate;
    mapping: MappingEntry;
    model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
    lockKey: string;
    index: number;
  };
  waitedForLockMs: number;
}> {
  void _activeModelLockKey;
  type LockableCandidate = {
    candidate: UsageCandidate;
    mapping: NonNullable<ReturnType<typeof findModelMapping>>;
    model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
    lockKey: string;
    index: number;
  };

  const lockableCandidates: LockableCandidate[] = [],
    seenModelLocks = new Set<string>();

  for (const [index, candidate] of rankedCandidates.entries()) {
    const candidateMapping = findModelMapping(candidate, config.mappings);
    if (!candidateMapping?.model) continue;

    const candidateModel = ctx.modelRegistry.find(
      candidateMapping.model.provider,
      candidateMapping.model.id,
    );
    if (!candidateModel) continue;

    const candidateLockKey = modelLockKey(
      candidateMapping.model.provider,
      candidateMapping.model.id,
    );
    if (seenModelLocks.has(candidateLockKey)) continue;
    seenModelLocks.add(candidateLockKey);

    lockableCandidates.push({
      candidate,
      mapping: candidateMapping,
      model: candidateModel,
      lockKey: candidateLockKey,
      index,
    });
  }

  // Add fallback model as the last lockable candidate (lowest priority)
  // Only if fallback.lock is true (default)
  if (config.fallback && config.fallback.lock !== false) {
    const fallbackModel = ctx.modelRegistry.find(
      config.fallback.provider,
      config.fallback.id,
    );
    if (
      fallbackModel &&
      !seenModelLocks.has(
        modelLockKey(config.fallback.provider, config.fallback.id),
      )
    ) {
      lockableCandidates.push({
        candidate: {
          provider: config.fallback.provider,
          displayName: config.fallback.provider,
          windowLabel: "fallback",
          usedPercent: 0,
          remainingPercent: 100,
        },
        mapping: {
          usage: {
            provider: config.fallback.provider,
            window: "fallback",
          },
          model: {
            provider: config.fallback.provider,
            id: config.fallback.id,
          },
        },
        model: fallbackModel,
        lockKey: modelLockKey(config.fallback.provider, config.fallback.id),
        index: lockableCandidates.length,
      });
    }
  }

  if (lockableCandidates.length === 0) {
    writeDebugLog(
      "No mapped models available for lock acquisition. Skipping model lock acquisition step.",
    );
    notify(
      ctx,
      "error",
      "No mapped models are available to lock for the current selection. Check your model mappings and configuration.",
    );
    return { waitedForLockMs: 0 };
  }

  const loggedBusyLocks = new Set<string>();

  const tryAcquireLock = async (): Promise<LockableCandidate | undefined> => {
    for (const candidate of lockableCandidates) {
      const result = await modelLockCoordinator.acquire(candidate.lockKey, {
        timeoutMs: 0,
      });
      if (result.acquired) {
        return candidate;
      }

      const heldBy = result.heldBy;
      if (!heldBy) {
        continue;
      }

      const signature = `${candidate.lockKey}|${heldBy.instanceId}|${heldBy.pid}`;
      if (loggedBusyLocks.has(signature)) {
        continue;
      }
      loggedBusyLocks.add(signature);

      const nowMs = Date.now();
      const heartbeatAgeSeconds = Math.max(
        0,
        Math.floor((nowMs - heldBy.heartbeatAt) / 1000),
      );
      const lockAgeSeconds = Math.max(
        0,
        Math.floor((nowMs - heldBy.acquiredAt) / 1000),
      );

      writeDebugLog(
        `Model lock busy for key "${candidate.lockKey}" (rank #${candidate.index + 1}); held by instance "${heldBy.instanceId}" (pid ${heldBy.pid}), lock age ${lockAgeSeconds}s, heartbeat age ${heartbeatAgeSeconds}s.`,
      );
    }
    return undefined;
  };

  let selectedWithLock = await tryAcquireLock();
  let waitedForLockMs = 0;

  if (!selectedWithLock && waitForLock) {
    const waitStart = Date.now();
    notify(
      ctx,
      "info",
      "All mapped models are busy. Waiting for an available model lock...",
    );

    while (Date.now() - waitStart < MODEL_LOCK_WAIT_TIMEOUT_MS) {
      const elapsedMs = Date.now() - waitStart;
      if (ctx.hasUI && typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus(
          "model-selector-lock",
          `Waiting for available model lock (${Math.floor(elapsedMs / 1000)}s)...`,
        );
      }
      await new Promise((resolve) => {
        setTimeout(resolve, MODEL_LOCK_POLL_MS);
      });

      selectedWithLock = await tryAcquireLock();
      if (selectedWithLock) {
        waitedForLockMs = Date.now() - waitStart;
        break;
      }
    }
  }

  if (!selectedWithLock) {
    // All quota-tracked models are locked - try fallback without locking if fallback.lock is false
    if (config.fallback && config.fallback.lock === false) {
      const fallbackModel = ctx.modelRegistry.find(
        config.fallback.provider,
        config.fallback.id,
      );
      if (fallbackModel) {
        return {
          selected: {
            candidate: {
              provider: config.fallback.provider,
              displayName: config.fallback.provider,
              windowLabel: "fallback",
              usedPercent: 0,
              remainingPercent: 100,
            },
            mapping: {
              usage: {
                provider: config.fallback.provider,
                window: "fallback",
              },
              model: {
                provider: config.fallback.provider,
                id: config.fallback.id,
              },
            },
            model: fallbackModel,
            lockKey: "", // No lock when fallback.lock is false
            index: lockableCandidates.length,
          },
          waitedForLockMs,
        };
      } else {
        notify(
          ctx,
          "error",
          `Fallback model not found: ${config.fallback.provider}/${config.fallback.id}.`,
        );
        return { waitedForLockMs };
      }
    } else {
      notify(
        ctx,
        "error",
        "All mapped models are busy and no lock became available in time.",
      );
      return { waitedForLockMs };
    }
  }

  return {
    selected: {
      candidate: selectedWithLock.candidate,
      mapping: selectedWithLock.mapping,
      model: selectedWithLock.model,
      lockKey: selectedWithLock.lockKey,
      index: selectedWithLock.index,
    },
    waitedForLockMs,
  };
}

async function finalizeSelection(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  best: UsageCandidate,
  bestIndex: number,
  mapping: ReturnType<typeof findModelMapping>,
  model: ReturnType<ExtensionContext["modelRegistry"]["find"]> | undefined,
  lockKey: string | undefined,
  config: LoadedConfig,
  rankedCandidates: UsageCandidate[],
  modelLockCoordinator: ModelLockCoordinator,
  lockHeartbeatTimer: { current: NodeJS.Timeout | null },
  activeModelLockKey: { current: string | null },
  waitedForLockMs: number,
  reason: SelectorReason,
): Promise<boolean> {
  if (!mapping || !mapping.model) {
    const usage = { provider: best.provider } as {
      provider: string;
      account?: string;
      window: string;
    };
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
    if (lockKey) {
      await modelLockCoordinator.release(lockKey);
    }
    return false;
  }

  if (!model) {
    notify(
      ctx,
      "error",
      `Mapped model not found: ${mapping.model.provider}/${mapping.model.id}.`,
    );
    if (lockKey) {
      await modelLockCoordinator.release(lockKey);
    }
    return false;
  }

  const isFallbackSelection =
    config.fallback &&
    best.windowLabel === "fallback" &&
    mapping.model.provider === config.fallback.provider &&
    mapping.model.id === config.fallback.id;
  const shouldReleaseForFallbackNoLock =
    isFallbackSelection && config.fallback?.lock === false;

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
      if (lockKey) {
        await modelLockCoordinator.release(lockKey);
      }
      return false;
    }
  }

  if (shouldReleaseForFallbackNoLock && activeModelLockKey.current) {
    await releaseActiveModelLock(
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
    );
  }

  if (lockKey) {
    if (activeModelLockKey.current && activeModelLockKey.current !== lockKey) {
      await releaseActiveModelLock(
        modelLockCoordinator,
        lockHeartbeatTimer,
        activeModelLockKey,
      );
    }
    activeModelLockKey.current = lockKey;
    startLockHeartbeat(
      modelLockCoordinator,
      lockHeartbeatTimer,
      activeModelLockKey,
      lockKey,
    );
  }

  const runnerUp =
      rankedCandidates.length > 1
        ? candidateKey(rankedCandidates[0]) === candidateKey(best)
          ? rankedCandidates[1]
          : rankedCandidates[0]
        : undefined,
    baseReason = runnerUp
      ? selectionReason(best, runnerUp, config.priority, config.mappings)
      : "Only one candidate available",
    lockReason =
      best.windowLabel === "fallback"
        ? undefined
        : bestIndex > 0
          ? `first unlocked model (rank #${bestIndex + 1})`
          : undefined,
    waitReason =
      waitedForLockMs > 0
        ? `waited ${(waitedForLockMs / 1000).toFixed(1)}s for lock`
        : undefined,
    reasonDetail = [lockReason, waitReason, baseReason]
      .filter(Boolean)
      .join("; "),
    selectionMsg = isAlreadySelected
      ? `Already using ${mapping.model.provider}/${mapping.model.id}`
      : `Set model to ${mapping.model.provider}/${mapping.model.id}`,
    bucketMsg =
      best.windowLabel === "fallback"
        ? "last-resort fallback"
        : `${best.displayName}/${best.windowLabel} (${best.remainingPercent.toFixed(0)}% left)`;

  const shouldNotifySelection =
    reason !== "request" ||
    !isAlreadySelected ||
    bestIndex > 0 ||
    waitedForLockMs > 0;
  if (shouldNotifySelection) {
    const isFallback = best.windowLabel === "fallback";
    const fallbackContext = isFallback
      ? " (last-resort fallback; all quota-tracked models exhausted/busy)"
      : "";
    notify(
      ctx,
      "info",
      `${selectionMsg}${fallbackContext} via ${bucketMsg}. Reason: ${reasonDetail}.`,
    );
  }

  return true;
}

async function releaseActiveModelLock(
  modelLockCoordinator: ModelLockCoordinator,
  lockHeartbeatTimer: { current: NodeJS.Timeout | null },
  activeModelLockKey: { current: string | null },
): Promise<void> {
  const lockKey = activeModelLockKey.current;
  if (!lockKey) return;
  activeModelLockKey.current = null;

  if (lockHeartbeatTimer.current) {
    clearInterval(lockHeartbeatTimer.current);
    lockHeartbeatTimer.current = null;
  }

  try {
    await modelLockCoordinator.release(lockKey);
  } catch (err) {
    writeDebugLog(
      `Error while releasing model lock for key "${lockKey}": ${String(err)}`,
    );
  }
}

function startLockHeartbeat(
  modelLockCoordinator: ModelLockCoordinator,
  lockHeartbeatTimer: { current: NodeJS.Timeout | null },
  activeModelLockKey: { current: string | null },
  lockKey: string,
): void {
  if (lockHeartbeatTimer.current) {
    clearInterval(lockHeartbeatTimer.current);
    lockHeartbeatTimer.current = null;
  }

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
          if (lockHeartbeatTimer.current) {
            clearInterval(lockHeartbeatTimer.current);
            lockHeartbeatTimer.current = null;
          }
          writeDebugLog(
            `Model lock heartbeat lost lock for key "${lockKey}", stopping heartbeat.`,
          );
        }
      } catch (err) {
        if (lockHeartbeatTimer.current) {
          clearInterval(lockHeartbeatTimer.current);
          lockHeartbeatTimer.current = null;
        }
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
