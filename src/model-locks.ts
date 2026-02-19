import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelLockEntry {
  instanceId: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

interface ModelLockState {
  version: 1;
  locks: Record<string, ModelLockEntry>;
}

export interface AcquireModelLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface AcquireModelLockResult {
  acquired: boolean;
  waitedMs: number;
  heldBy?: ModelLockEntry;
}

export interface ModelLockCoordinatorOptions {
  statePath?: string;
  instanceId?: string;
  pid?: number;
  leaseMs?: number;
  hardStaleMs?: number;
  stateLockTimeoutMs?: number;
  stateLockPollMs?: number;
  stateLockStaleMs?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const MODEL_LOCK_STATE_PATH = path.join(
  os.homedir(),
  ".pi",
  "model-selector-model-locks.json",
);

const DEFAULT_LEASE_MS = 15_000,
  DEFAULT_HARD_STALE_MS = 5 * 60_000,
  DEFAULT_STATE_LOCK_TIMEOUT_MS = 5_000,
  DEFAULT_STATE_LOCK_POLL_MS = 25,
  DEFAULT_STATE_LOCK_STALE_MS = 10_000,
  DEFAULT_ACQUIRE_POLL_MS = 1_250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultNow(): number {
  return Date.now();
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

function sanitizeState(raw: unknown): ModelLockState {
  if (!raw || typeof raw !== "object") {
    return { version: 1, locks: {} };
  }

  const parsed = raw as {
      version?: unknown;
      locks?: unknown;
    },
    sourceLocks =
      parsed.version === 1 && parsed.locks && typeof parsed.locks === "object"
        ? (parsed.locks as Record<string, unknown>)
        : {},
    locks: Record<string, ModelLockEntry> = {};

  for (const [key, value] of Object.entries(sourceLocks)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<ModelLockEntry>;
    if (
      typeof entry.instanceId !== "string" ||
      typeof entry.pid !== "number" ||
      typeof entry.acquiredAt !== "number" ||
      typeof entry.heartbeatAt !== "number"
    ) {
      continue;
    }
    locks[key] = {
      instanceId: entry.instanceId,
      pid: entry.pid,
      acquiredAt: entry.acquiredAt,
      heartbeatAt: entry.heartbeatAt,
    };
  }

  return { version: 1, locks };
}

export function modelLockKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export class ModelLockCoordinator {
  private readonly statePath: string;
  private readonly stateLockPath: string;
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly leaseMs: number;
  private readonly hardStaleMs: number;
  private readonly stateLockTimeoutMs: number;
  private readonly stateLockPollMs: number;
  private readonly stateLockStaleMs: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ModelLockCoordinatorOptions = {}) {
    this.statePath = options.statePath ?? MODEL_LOCK_STATE_PATH;
    this.stateLockPath = `${this.statePath}.lock`;
    this.instanceId =
      options.instanceId ??
      `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    this.pid = options.pid ?? process.pid;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.hardStaleMs = options.hardStaleMs ?? DEFAULT_HARD_STALE_MS;
    this.stateLockTimeoutMs =
      options.stateLockTimeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS;
    this.stateLockPollMs =
      options.stateLockPollMs ?? DEFAULT_STATE_LOCK_POLL_MS;
    this.stateLockStaleMs =
      options.stateLockStaleMs ?? DEFAULT_STATE_LOCK_STALE_MS;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? defaultNow;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async acquire(
    key: string,
    options: AcquireModelLockOptions = {},
  ): Promise<AcquireModelLockResult> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0),
      pollMs = Math.max(10, options.pollMs ?? DEFAULT_ACQUIRE_POLL_MS),
      startedAt = this.now();

    let heldBy: ModelLockEntry | undefined;

    while (true) {
      const attempt = await this.withStateMutation((state) => {
        const existing = state.locks[key];

        if (!existing || existing.instanceId === this.instanceId) {
          const now = this.now();
          state.locks[key] = {
            instanceId: this.instanceId,
            pid: this.pid,
            acquiredAt: existing?.acquiredAt ?? now,
            heartbeatAt: now,
          };
          return { acquired: true } as const;
        }

        return { acquired: false, heldBy: existing } as const;
      });

      if (attempt.acquired) {
        return {
          acquired: true,
          waitedMs: this.now() - startedAt,
        };
      }

      heldBy = attempt.heldBy;

      if (timeoutMs === 0 || this.now() - startedAt >= timeoutMs) {
        return {
          acquired: false,
          waitedMs: this.now() - startedAt,
          heldBy,
        };
      }

      const remainingMs = timeoutMs - (this.now() - startedAt);
      await this.sleep(Math.min(pollMs, Math.max(10, remainingMs)));
    }
  }

  async refresh(key: string): Promise<boolean> {
    return this.withStateMutation((state) => {
      const existing = state.locks[key];
      if (!existing || existing.instanceId !== this.instanceId) {
        return false;
      }
      existing.heartbeatAt = this.now();
      state.locks[key] = existing;
      return true;
    });
  }

  async release(key: string): Promise<boolean> {
    return this.withStateMutation((state) => {
      const existing = state.locks[key];
      if (!existing || existing.instanceId !== this.instanceId) {
        return false;
      }
      delete state.locks[key];
      return true;
    });
  }

  async releaseAll(): Promise<number> {
    return this.withStateMutation((state) => {
      let released = 0;
      for (const [key, entry] of Object.entries(state.locks)) {
        if (entry.instanceId === this.instanceId) {
          delete state.locks[key];
          released += 1;
        }
      }
      return released;
    });
  }

  private async withStateMutation<T>(
    mutate: (state: ModelLockState) => T,
  ): Promise<T> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    const fileHandle = await this.acquireStateLock();

    try {
      const state = await this.readState();
      const before = JSON.stringify(state);
      this.pruneStaleLocks(state);
      const result = mutate(state);
      const after = JSON.stringify(state);
      // Only write if state actually changed to avoid unnecessary disk churn
      if (before !== after) {
        await this.writeState(state);
      }
      return result;
    } finally {
      await this.releaseStateLock(fileHandle);
    }
  }

  private async readState(): Promise<ModelLockState> {
    try {
      const raw = await fs.promises.readFile(this.statePath, "utf-8");
      return sanitizeState(JSON.parse(raw));
    } catch {
      return { version: 1, locks: {} };
    }
  }

  private async writeState(state: ModelLockState): Promise<void> {
    const tempPath = `${this.statePath}.tmp.${Math.random().toString(36).slice(2)}`;
    try {
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify(state, null, 2),
        "utf-8",
      );
      await fs.promises.rename(tempPath, this.statePath);
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // best-effort cleanup; ignore unlink errors
      }
      throw error;
    }
  }

  private pruneStaleLocks(state: ModelLockState): void {
    const now = this.now();

    for (const [key, entry] of Object.entries(state.locks)) {
      if (entry.instanceId === this.instanceId) continue;

      const heartbeatAge = now - entry.heartbeatAt;

      // Reclaim immediately if the owning process is gone, even when the
      // heartbeat is still fresh. This avoids short-lived invocations (e.g.
      // wrapper scripts spawning `pi` repeatedly) blocking follow-up runs for
      // an entire lease interval.
      if (!this.isPidAlive(entry.pid)) {
        delete state.locks[key];
        continue;
      }

      // Keep live owners through the normal lease window.
      if (heartbeatAge <= this.leaseMs) continue;

      // If a live owner stops heartbeating for too long, force cleanup.
      if (heartbeatAge > this.hardStaleMs) {
        delete state.locks[key];
      }
    }
  }

  private async acquireStateLock(): Promise<FileHandle> {
    const startedAt = this.now();

    while (true) {
      try {
        return await fs.promises.open(this.stateLockPath, "wx");
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;

        if (code !== "EEXIST") {
          throw error;
        }

        if (this.now() - startedAt > this.stateLockTimeoutMs) {
          throw new Error(
            `Timed out waiting for model-selector state lock: ${this.stateLockPath}`,
          );
        }

        await this.cleanupStaleStateLock();
        await this.sleep(this.stateLockPollMs);
      }
    }
  }

  private async cleanupStaleStateLock(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.stateLockPath);
      if (this.now() - stat.mtimeMs > this.stateLockStaleMs) {
        await fs.promises.unlink(this.stateLockPath);
      }
    } catch {
      // lock already gone or unreadable; ignore
    }
  }

  private async releaseStateLock(fileHandle: FileHandle): Promise<void> {
    await fileHandle.close();
    try {
      await fs.promises.unlink(this.stateLockPath);
    } catch {
      // Ignore if already removed
    }
  }
}

export function createModelLockCoordinator(
  options: ModelLockCoordinatorOptions = {},
): ModelLockCoordinator {
  return new ModelLockCoordinator(options);
}
