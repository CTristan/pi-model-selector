import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateKey } from "../src/candidates.js";
import { CooldownManager } from "../src/cooldown.js";

describe("Cooldown Manager - Extension Branches", () => {
  let cooldownManager: CooldownManager;

  beforeEach(() => {
    vi.useFakeTimers();
    cooldownManager = new CooldownManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("setOrExtendProviderCooldown", () => {
    it("returns false when existing cooldown expiry is already in the future", () => {
      const now = Date.now();

      // First, set a cooldown
      const firstResult = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        undefined,
        now,
      );
      expect(firstResult).toBe(true);

      // Get the expiry timestamp
      const wildcardKey = "anthropic||*";
      const firstExpiry = (cooldownManager as any).modelCooldowns.get(
        wildcardKey,
      );
      expect(firstExpiry).toBeGreaterThan(now);

      // Try to extend it immediately (should not extend because it's already set)
      const secondResult = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        undefined,
        now,
      );
      expect(secondResult).toBe(false);

      // Verify the expiry didn't change
      const secondExpiry = (cooldownManager as any).modelCooldowns.get(
        wildcardKey,
      );
      expect(secondExpiry).toBe(firstExpiry);
    });

    it("returns true and extends cooldown when called after some time has passed", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      const now = Date.now();

      // Set initial cooldown
      const firstResult = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        undefined,
        now,
      );
      expect(firstResult).toBe(true);

      const wildcardKey = "anthropic||*";
      const firstExpiry = (cooldownManager as any).modelCooldowns.get(
        wildcardKey,
      );

      // Move time forward by 30 minutes
      vi.setSystemTime(new Date("2024-01-01T00:30:00.000Z"));
      const later = Date.now();

      // Try to extend - should succeed because time has passed
      const secondResult = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        undefined,
        later,
      );
      expect(secondResult).toBe(true);

      // Verify the expiry was extended
      const secondExpiry = (cooldownManager as any).modelCooldowns.get(
        wildcardKey,
      );
      expect(secondExpiry).toBeGreaterThan(firstExpiry);
    });

    it("handles provider-specific accounts separately", () => {
      const now = Date.now();

      // Set cooldown for account1
      const result1 = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        "account1",
        now,
      );
      expect(result1).toBe(true);

      // Try to set same cooldown for same account immediately - should not extend
      const result2 = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        "account1",
        now,
      );
      expect(result2).toBe(false);

      // Set cooldown for different account - should succeed
      const result3 = cooldownManager.setOrExtendProviderCooldown(
        "anthropic",
        "account2",
        now,
      );
      expect(result3).toBe(true);

      // Verify separate cooldown keys
      const account1Key = "anthropic|account1|*";
      const account2Key = "anthropic|account2|*";
      const cooldowns = (cooldownManager as any).modelCooldowns;

      expect(cooldowns.has(account1Key)).toBe(true);
      expect(cooldowns.has(account2Key)).toBe(true);
    });

    it("sets new cooldown when no existing cooldown exists", () => {
      const now = Date.now();

      const result = cooldownManager.setOrExtendProviderCooldown(
        "newProvider",
        undefined,
        now,
      );

      expect(result).toBe(true);

      const wildcardKey = "newProvider||*";
      const expiry = (cooldownManager as any).modelCooldowns.get(wildcardKey);

      expect(expiry).toBe(now + 3600000); // 1 hour in milliseconds
    });
  });

  describe("getWildcardExpiry", () => {
    it("returns undefined when no cooldown exists for provider", () => {
      const expiry = cooldownManager.getWildcardExpiry(
        "nonexistent",
        undefined,
      );
      expect(expiry).toBeUndefined();
    });

    it("returns expiry timestamp when cooldown exists", () => {
      const now = Date.now();

      cooldownManager.setOrExtendProviderCooldown("anthropic", undefined, now);

      const expiry = cooldownManager.getWildcardExpiry("anthropic", undefined);
      expect(expiry).toBe(now + 3600000);
    });

    it("returns correct expiry for specific account", () => {
      const now = Date.now();

      cooldownManager.setOrExtendProviderCooldown("anthropic", "account1", now);

      const expiry = cooldownManager.getWildcardExpiry("anthropic", "account1");
      expect(expiry).toBe(now + 3600000);
    });

    it("returns undefined for wrong account", () => {
      const now = Date.now();

      cooldownManager.setOrExtendProviderCooldown("anthropic", "account1", now);

      const expiry = cooldownManager.getWildcardExpiry("anthropic", "account2");
      expect(expiry).toBeUndefined();
    });
  });

  describe("isOnCooldown", () => {
    it("returns false when no cooldown exists for candidate", () => {
      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: undefined,
      };

      const result = cooldownManager.isOnCooldown(candidate);
      expect(result).toBe(false);
    });

    it("returns true when specific candidate key cooldown is active", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: undefined,
        isSynthetic: false,
      };

      // Set specific candidate cooldown
      const key = candidateKey(candidate);
      cooldownManager.addCooldown(key);

      // Check it's on cooldown using current time
      const now = Date.now();
      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(true);
    });

    it("returns true when wildcard provider cooldown is active", () => {
      const now = Date.now();

      // Set provider-wide cooldown
      cooldownManager.setOrExtendProviderCooldown("anthropic", undefined, now);

      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: undefined,
      };

      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(true);
    });

    it("returns true when wildcard account cooldown is active", () => {
      const now = Date.now();

      // Set account-specific cooldown
      cooldownManager.setOrExtendProviderCooldown("anthropic", "account1", now);

      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: "account1",
      };

      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(true);
    });

    it("returns false for different account when wildcard account cooldown is active", () => {
      const now = Date.now();

      // Set cooldown for account1
      cooldownManager.setOrExtendProviderCooldown("anthropic", "account1", now);

      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: "account2",
      };

      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(false);
    });

    it("returns false when specific cooldown has expired (not yet pruned)", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

      // Set a specific cooldown
      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: undefined,
        isSynthetic: false,
      };
      const key = candidateKey(candidate);
      cooldownManager.addCooldown(key);

      // Move time past the cooldown expiry
      vi.setSystemTime(new Date("2024-01-01T02:00:00.000Z"));
      const now = Date.now();

      // Should return false even though the key exists in the map (expiry <= now)
      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(false);
    });

    it("returns false when wildcard cooldown has expired (not yet pruned)", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      const past = Date.now();

      // Set a wildcard cooldown
      cooldownManager.setOrExtendProviderCooldown("anthropic", undefined, past);

      // Move time past the cooldown expiry
      vi.setSystemTime(new Date("2024-01-01T02:00:00.000Z"));
      const now = Date.now();

      const candidate = {
        provider: "anthropic",
        displayName: "Claude",
        windowLabel: "Sonnet",
        usedPercent: 50,
        remainingPercent: 50,
        account: undefined,
      };

      // Should return false even though the key exists in the map (expiry <= now)
      const result = cooldownManager.isOnCooldown(candidate, now);
      expect(result).toBe(false);
    });
  });

  describe("pruneExpiredCooldowns", () => {
    it("returns true when it removes expired cooldowns", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

      // Set some cooldowns
      cooldownManager.addCooldown("key1");
      cooldownManager.addCooldown("key2");

      // Move time past expiry
      vi.setSystemTime(new Date("2024-01-01T02:00:00.000Z"));
      const later = Date.now();

      // Prune should return true
      const result = cooldownManager.pruneExpiredCooldowns(later);
      expect(result).toBe(true);

      // Cooldowns should be removed
      expect((cooldownManager as any).modelCooldowns.size).toBeLessThan(2);
    });

    it("returns false when no cooldowns are expired", () => {
      const now = Date.now();

      // Set some cooldowns
      cooldownManager.addCooldown("key1");
      cooldownManager.addCooldown("key2");

      // Prune should return false (nothing to remove)
      const result = cooldownManager.pruneExpiredCooldowns(now);
      expect(result).toBe(false);

      // Cooldowns should still exist
      expect((cooldownManager as any).modelCooldowns.size).toBe(2);
    });

    it("removes only expired cooldowns, keeping active ones", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

      // Set some cooldowns
      cooldownManager.addCooldown("key1");
      cooldownManager.addCooldown("key2");

      // Move time partially past expiry
      vi.setSystemTime(new Date("2024-01-01T01:00:00.000Z"));
      const later = Date.now();

      // Manually set key2 to a future expiry (simulating it was added later)
      (cooldownManager as any).modelCooldowns.set("key2", later + 3600000);

      // Prune should return true (removed key1)
      const result = cooldownManager.pruneExpiredCooldowns(later);
      expect(result).toBe(true);

      // key1 should be removed, key2 should remain
      expect((cooldownManager as any).modelCooldowns.has("key1")).toBe(false);
      expect((cooldownManager as any).modelCooldowns.has("key2")).toBe(true);
    });
  });

  describe("clear", () => {
    it("clears all cooldowns from the map", () => {
      // Set some cooldowns
      cooldownManager.addCooldown("key1");
      cooldownManager.addCooldown("key2");
      cooldownManager.addCooldown("key3");

      expect((cooldownManager as any).modelCooldowns.size).toBe(3);

      // Clear all
      cooldownManager.clear();

      expect((cooldownManager as any).modelCooldowns.size).toBe(0);
    });

    it("does not clear last selected key", () => {
      cooldownManager.setLastSelectedKey("some-key");
      expect(cooldownManager.getLastSelectedKey()).toBe("some-key");

      cooldownManager.clear();

      expect(cooldownManager.getLastSelectedKey()).toBe("some-key"); // clear() doesn't affect this
    });
  });
});
