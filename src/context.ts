import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { findModelMapping } from "./candidates.js";
import type { LoadedConfig, UsageCandidate } from "./types.js";
import { writeDebugLog } from "./types.js";

// Safety buffer to leave headroom for model response and overhead
export const CONTEXT_WINDOW_SAFETY_RATIO = 0.8;

export function filterByContextWindow(
  candidates: UsageCandidate[],
  config: LoadedConfig,
  ctx: ExtensionContext,
): { eligible: UsageCandidate[]; filtered: UsageCandidate[] } {
  const usage = ctx.getContextUsage();
  const currentTokens = usage?.tokens;

  // If unknown context size, skip filtering entirely
  if (currentTokens === null || currentTokens === undefined) {
    return { eligible: candidates, filtered: [] };
  }

  const eligible: UsageCandidate[] = [];
  const filtered: UsageCandidate[] = [];

  for (const candidate of candidates) {
    const mapping = findModelMapping(candidate, config.mappings);

    // Candidates without a model mapping skip context filtering here
    // (they'll fail later at the mapping check, but we shouldn't filter them here)
    if (!mapping?.model) {
      eligible.push(candidate);
      continue;
    }

    const model = ctx.modelRegistry.find(
      mapping.model.provider,
      mapping.model.id,
    );

    if (!model) {
      eligible.push(candidate);
      continue;
    }

    // Safety buffer (e.g. 0.8) ensures we leave room for the response
    const maxAllowedTokens = model.contextWindow * CONTEXT_WINDOW_SAFETY_RATIO;

    if (currentTokens > maxAllowedTokens) {
      candidate.contextFiltered = true;
      filtered.push(candidate);
    } else {
      eligible.push(candidate);
    }
  }

  return { eligible, filtered };
}

export function compactAndAwait(
  ctx: ExtensionContext,
  options?: { customInstructions?: string },
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Timeout to prevent indefinite hanging (e.g., if pi internal fails silently)
    const timeoutId = setTimeout(() => {
      resolve({ success: false, error: "Compaction timed out after 120s" });
    }, 120000);

    try {
      ctx.compact({
        ...options,
        onComplete: () => {
          clearTimeout(timeoutId);
          resolve({ success: true });
        },
        onError: (err: Error) => {
          clearTimeout(timeoutId);
          resolve({ success: false, error: err.message || String(err) });
        },
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      resolve({ success: false, error: String(err) });
    }
  });
}

export async function handleCompactOnSwitch(
  ctx: ExtensionContext,
  currentModel: ExtensionContext["model"],
  selectedModel: { provider: string; id: string },
  config: LoadedConfig,
): Promise<{ compacted: boolean; error?: string }> {
  if (!config.compactOnSwitch) {
    return { compacted: false };
  }

  // Check if we are actually switching models
  if (
    currentModel &&
    currentModel.provider === selectedModel.provider &&
    currentModel.id === selectedModel.id
  ) {
    writeDebugLog(
      `[context] Model unchanged (${currentModel.id}), skipping compaction`,
    );
    return { compacted: false };
  }

  writeDebugLog(
    `[context] Model switch detected (${currentModel?.id ?? "none"} -> ${selectedModel.id}). Compacting context...`,
  );

  const result = await compactAndAwait(ctx); // Internal timeout is 120s

  if (result.success) {
    writeDebugLog(`[context] Compaction successful`);
  } else {
    writeDebugLog(`[context] Compaction failed: ${result.error}`);
  }

  return result.error
    ? { compacted: result.success, error: result.error }
    : { compacted: result.success };
}
