import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXTENSION_DIR } from "./adapter.js";

import { candidateKey } from "./candidates.js";
import type { UsageCandidate } from "./types.js";

/**
 * Persisted skip and provider cooldown data shared across Pi sessions.
 */
export interface CooldownState {
  /** Expiry timestamp by candidate or provider wildcard key. */
  cooldowns: Record<string, number>;
  /** Last selected candidate key used by manual skip commands. */
  lastSelected: string | null;
}

/** Default duration for manual skips and provider cooldowns, in milliseconds. */
export const COOLDOWN_DURATION = 60 * 60 * 1000; // 1 hour

const COOLDOWN_STATE_PATH = path.join(
  os.homedir(),
  EXTENSION_DIR,
  "model-selector-cooldowns.json",
);

/**
 * Loads persisted cooldown state, returning an empty state when unavailable.
 */
export async function loadCooldownState(): Promise<CooldownState> {
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

/**
 * Persists cooldown state with an atomic write when possible.
 */
export async function saveCooldownState(state: CooldownState): Promise<void> {
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

/**
 * Builds the provider/account wildcard key used for provider-wide cooldowns.
 */
export function getWildcardKey(
  provider: string,
  account?: string | null,
): string {
  return `${provider}|${account ?? ""}|*`;
}

/**
 * Tracks manual skip and provider-wide cooldowns for model candidates.
 */
export class CooldownManager {
  private modelCooldowns = new Map<string, number>();
  private cooldownsLoaded = false;
  private lastSelectedCandidateKey: string | null = null;

  /**
   * Loads persisted non-expired cooldowns once into memory.
   */
  async loadPersistedCooldowns(): Promise<void> {
    if (this.cooldownsLoaded) return;
    const state = await loadCooldownState();
    const now = Date.now();

    // Load non-expired cooldowns into the Map
    for (const [key, expiry] of Object.entries(state.cooldowns)) {
      if (expiry > now) {
        this.modelCooldowns.set(key, expiry);
        // Migration for legacy keys (missing |raw/|synthetic suffix)
        // Wildcard keys end with |*, leave them alone
        if (
          !key.endsWith("|raw") &&
          !key.endsWith("|synthetic") &&
          !key.endsWith("|*")
        ) {
          this.modelCooldowns.set(`${key}|raw`, expiry);
        }
      }
    }

    // Restore last selected (useful for /model-skip in print mode)
    if (state.lastSelected) {
      this.lastSelectedCandidateKey = state.lastSelected;
      // Migrate legacy lastSelected key if needed (skip fallback marker keys)
      if (
        !this.lastSelectedCandidateKey.startsWith("fallback:") &&
        !this.lastSelectedCandidateKey.endsWith("|raw") &&
        !this.lastSelectedCandidateKey.endsWith("|synthetic") &&
        !this.lastSelectedCandidateKey.endsWith("|*")
      ) {
        this.lastSelectedCandidateKey = `${this.lastSelectedCandidateKey}|raw`;
      }
    }
    this.cooldownsLoaded = true;
  }

  /**
   * Writes the current non-expired cooldown set and last selection to disk.
   */
  async persistCooldowns(): Promise<void> {
    const cooldowns: Record<string, number> = {};
    const now = Date.now();

    for (const [key, expiry] of this.modelCooldowns) {
      if (expiry > now) {
        cooldowns[key] = expiry;
      }
    }

    await saveCooldownState({
      cooldowns,
      lastSelected: this.lastSelectedCandidateKey,
    });
  }

  /**
   * Removes expired cooldown entries and reports whether anything changed.
   */
  pruneExpiredCooldowns(now = Date.now()): boolean {
    let removed = false;
    for (const [key, expiry] of this.modelCooldowns) {
      if (expiry <= now) {
        this.modelCooldowns.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  /**
   * Applies or extends a provider-wide cooldown after a rate-limit response.
   */
  setOrExtendProviderCooldown(
    provider: string,
    account: string | undefined,
    now: number,
  ): boolean {
    const wildcardKey = getWildcardKey(provider, account),
      existingExpiry = this.modelCooldowns.get(wildcardKey) ?? 0,
      newExpiry = now + COOLDOWN_DURATION;
    if (newExpiry <= existingExpiry) {
      return false;
    }
    this.modelCooldowns.set(wildcardKey, newExpiry);
    return true;
  }

  /**
   * Reports whether a candidate is blocked by model-specific or provider cooldowns.
   */
  isOnCooldown(c: UsageCandidate, now = Date.now()): boolean {
    const key = candidateKey(c);
    const wildcardKey = getWildcardKey(c.provider, c.account);

    const expiry = this.modelCooldowns.get(key);
    const wildcardExpiry = this.modelCooldowns.get(wildcardKey);

    return (
      (expiry !== undefined && expiry > now) ||
      (wildcardExpiry !== undefined && wildcardExpiry > now)
    );
  }

  /**
   * Adds a model-specific cooldown for a candidate key.
   */
  addCooldown(key: string): void {
    this.modelCooldowns.set(key, Date.now() + COOLDOWN_DURATION);
  }

  /**
   * Returns the provider-wide cooldown expiry for a provider/account pair.
   */
  getWildcardExpiry(
    provider: string,
    account: string | undefined,
  ): number | undefined {
    const wildcardKey = getWildcardKey(provider, account);
    return this.modelCooldowns.get(wildcardKey);
  }

  /**
   * Removes all in-memory cooldowns without persisting the change.
   */
  clear(): void {
    this.modelCooldowns.clear();
  }

  /**
   * Removes all model-specific skip cooldowns (non-wildcard keys).
   * This clears cooldowns added by /model-skip but preserves
   * provider-wide 429 rate-limit cooldowns.
   */
  clearSkipCooldowns(): number {
    // Collect keys first to avoid mutating the Map while iterating it,
    // and accurately count all deleted entries (including legacy variants).
    const allKeys = Array.from(this.modelCooldowns.keys());
    const deleted = new Set<string>();

    for (const key of allKeys) {
      // Skip wildcard keys (provider/account cooldowns from 429s)
      if (key.endsWith("|*")) {
        continue;
      }

      // Normalize to a base key by stripping legacy suffixes if present.
      const baseKey = key.replace(/\|(raw|synthetic)$/, "");
      const variants = [baseKey, `${baseKey}|raw`, `${baseKey}|synthetic`];

      for (const variant of variants) {
        if (this.modelCooldowns.delete(variant)) {
          deleted.add(variant);
        }
      }
    }

    return deleted.size;
  }

  /**
   * Returns the last selected candidate key used by manual skip commands.
   */
  getLastSelectedKey(): string | null {
    return this.lastSelectedCandidateKey;
  }

  /**
   * Stores the last selected candidate key for later manual skip commands.
   */
  setLastSelectedKey(key: string | null): void {
    this.lastSelectedCandidateKey = key;
  }
}
