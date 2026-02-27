import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { candidateKey } from "./candidates.js";
import type { UsageCandidate } from "./types.js";

export interface CooldownState {
  cooldowns: Record<string, number>; // CandidateKey -> expiry timestamp
  lastSelected: string | null;
}

export const COOLDOWN_DURATION = 60 * 60 * 1000; // 1 hour

const COOLDOWN_STATE_PATH = path.join(
  os.homedir(),
  ".pi",
  "model-selector-cooldowns.json",
);

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

export function getWildcardKey(
  provider: string,
  account?: string | null,
): string {
  return `${provider}|${account ?? ""}|*`;
}

export class CooldownManager {
  private modelCooldowns = new Map<string, number>();
  private cooldownsLoaded = false;
  private lastSelectedCandidateKey: string | null = null;

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

  addCooldown(key: string): void {
    this.modelCooldowns.set(key, Date.now() + COOLDOWN_DURATION);
  }

  getWildcardExpiry(
    provider: string,
    account: string | undefined,
  ): number | undefined {
    const wildcardKey = getWildcardKey(provider, account);
    return this.modelCooldowns.get(wildcardKey);
  }

  clear(): void {
    this.modelCooldowns.clear();
  }

  getLastSelectedKey(): string | null {
    return this.lastSelectedCandidateKey;
  }

  setLastSelectedKey(key: string | null): void {
    this.lastSelectedCandidateKey = key;
  }
}
