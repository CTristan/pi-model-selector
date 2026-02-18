import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModelLockCoordinator,
  modelLockKey,
} from "../src/model-locks.js";

function createTempStatePath(): { dir: string; statePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-locks-test-"));
  return { dir, statePath: path.join(dir, "locks.json") };
}

afterEach(() => {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith("model-locks-test-")) continue;
    const dir = path.join(os.tmpdir(), entry);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("model locks", () => {
  it("builds a stable model lock key", () => {
    expect(modelLockKey("anthropic", "claude-sonnet")).toBe(
      "anthropic/claude-sonnet",
    );
  });

  it("acquires and releases a lock", async () => {
    const { statePath } = createTempStatePath();
    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "inst-1",
      pid: 1001,
    });

    const first = await coordinator.acquire("anthropic/sonnet", {
      timeoutMs: 0,
    });
    expect(first.acquired).toBe(true);

    const released = await coordinator.release("anthropic/sonnet");
    expect(released).toBe(true);

    const second = await coordinator.acquire("anthropic/sonnet", {
      timeoutMs: 0,
    });
    expect(second.acquired).toBe(true);
  });

  it("enforces exclusivity across instances", async () => {
    const { statePath } = createTempStatePath();
    const owner = createModelLockCoordinator({
      statePath,
      instanceId: "owner",
      pid: 2001,
    });
    const contender = createModelLockCoordinator({
      statePath,
      instanceId: "contender",
      pid: 2002,
    });

    expect(
      (await owner.acquire("openai/gpt-4o", { timeoutMs: 0 })).acquired,
    ).toBe(true);

    const blocked = await contender.acquire("openai/gpt-4o", { timeoutMs: 0 });
    expect(blocked.acquired).toBe(false);
    expect(blocked.heldBy?.instanceId).toBe("owner");

    await owner.release("openai/gpt-4o");
    expect(
      (await contender.acquire("openai/gpt-4o", { timeoutMs: 0 })).acquired,
    ).toBe(true);
  });

  it("waits/polls until a lock is released", async () => {
    const { statePath } = createTempStatePath();
    const owner = createModelLockCoordinator({
      statePath,
      instanceId: "owner",
      pid: 3001,
    });
    const waiter = createModelLockCoordinator({
      statePath,
      instanceId: "waiter",
      pid: 3002,
    });

    await owner.acquire("google/gemini", { timeoutMs: 0 });

    setTimeout(() => {
      void owner.release("google/gemini");
    }, 30);

    const started = Date.now();
    const acquired = await waiter.acquire("google/gemini", {
      timeoutMs: 500,
      pollMs: 10,
    });

    expect(acquired.acquired).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("refreshes/releaseAll only for owned locks", async () => {
    const { statePath } = createTempStatePath();
    const owner = createModelLockCoordinator({
      statePath,
      instanceId: "owner",
      pid: 4001,
    });
    const other = createModelLockCoordinator({
      statePath,
      instanceId: "other",
      pid: 4002,
    });

    await owner.acquire("anthropic/sonnet", { timeoutMs: 0 });
    await owner.acquire("anthropic/opus", { timeoutMs: 0 });

    expect(await owner.refresh("anthropic/sonnet")).toBe(true);
    expect(await other.refresh("anthropic/sonnet")).toBe(false);

    expect(await owner.releaseAll()).toBe(2);
    expect(
      (await other.acquire("anthropic/sonnet", { timeoutMs: 0 })).acquired,
    ).toBe(true);
    expect(await other.release("anthropic/opus")).toBe(false);
  });

  it("reclaims stale locks when owner pid is dead", async () => {
    const { statePath } = createTempStatePath();
    const now = Date.now();

    await fs.promises.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          locks: {
            "anthropic/sonnet": {
              instanceId: "dead-instance",
              pid: 555_555,
              acquiredAt: now - 30_000,
              heartbeatAt: now - 30_000,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "live-instance",
      pid: 5001,
      leaseMs: 1_000,
      hardStaleMs: 60_000,
      isPidAlive: (pid) => pid !== 555_555,
    });

    const acquired = await coordinator.acquire("anthropic/sonnet", {
      timeoutMs: 0,
    });
    expect(acquired.acquired).toBe(true);
  });

  it("reclaims hard-stale locks even if pid appears alive", async () => {
    const { statePath } = createTempStatePath();
    const now = Date.now();

    await fs.promises.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          locks: {
            "openai/gpt-4o": {
              instanceId: "very-old",
              pid: 1234,
              acquiredAt: now - 20 * 60_000,
              heartbeatAt: now - 20 * 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "new-owner",
      pid: 5002,
      leaseMs: 1_000,
      hardStaleMs: 5_000,
      isPidAlive: () => true,
    });

    expect(
      (await coordinator.acquire("openai/gpt-4o", { timeoutMs: 0 })).acquired,
    ).toBe(true);
  });

  it("cleans up stale state lock files", async () => {
    const { statePath } = createTempStatePath();
    const staleLockPath = `${statePath}.lock`;

    await fs.promises.writeFile(staleLockPath, "", "utf-8");
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(staleLockPath, stale, stale);

    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "inst-9",
      pid: 9001,
      stateLockStaleMs: 100,
      stateLockPollMs: 5,
    });

    expect(
      (await coordinator.acquire("google/gemini", { timeoutMs: 0 })).acquired,
    ).toBe(true);
  });

  it("times out waiting for the state lock", async () => {
    const { statePath } = createTempStatePath();
    const lockPath = `${statePath}.lock`;
    await fs.promises.writeFile(lockPath, "", "utf-8");

    let now = 0;
    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "inst-timeout",
      pid: 9100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      stateLockTimeoutMs: 50,
      stateLockPollMs: 10,
      stateLockStaleMs: 100_000,
    });

    await expect(
      coordinator.acquire("anthropic/sonnet", { timeoutMs: 0 }),
    ).rejects.toThrow("Timed out waiting for model-selector state lock");
  });

  it("handles malformed state files gracefully", async () => {
    const { statePath } = createTempStatePath();
    await fs.promises.writeFile(statePath, "{not-json", "utf-8");

    const coordinator = createModelLockCoordinator({
      statePath,
      instanceId: "inst-bad-state",
      pid: 9200,
    });

    expect(
      (await coordinator.acquire("anthropic/sonnet", { timeoutMs: 0 }))
        .acquired,
    ).toBe(true);
  });
});
