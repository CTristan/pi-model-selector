import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig, MappingEntry } from "../src/types.js";
import {
  DEFAULT_PRIORITY,
  mappingKey,
  notify,
  setGlobalConfig,
  writeDebugLog,
} from "../src/types.js";

vi.mock("node:fs", () => ({
  mkdir: vi.fn(),
  appendFile: vi.fn(),
}));

describe("Types / Utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset global config state if possible, or just re-set it in tests
  });

  it("should generate correct mapping keys", () => {
    const entry: MappingEntry = {
      usage: {
        provider: "p1",
        account: "a1",
        window: "w1",
        windowPattern: "wp1",
      },
    };
    expect(mappingKey(entry)).toBe("p1|a1|w1|wp1");
  });

  it("should handle missing fields in mapping key", () => {
    const entry: MappingEntry = { usage: { provider: "p1" } };
    expect(mappingKey(entry)).toBe("p1|||");
  });

  it("should have default priority", () => {
    expect(DEFAULT_PRIORITY).toEqual([
      "fullAvailability",
      "earliestReset",
      "remainingPercent",
    ]);
  });

  it("should handle debug log queueing and directory creation", () => {
    const config = {
      debugLog: { enabled: true, path: "/mock/dir/test.log" },
    } as unknown as LoadedConfig;
    setGlobalConfig(config);

    writeDebugLog("Test message");
    // mkdir called with /mock/dir
    const mkdirCalls = vi.mocked(fs.mkdir).mock.calls;
    const lastMkdirCall = mkdirCalls[mkdirCalls.length - 1];
    expect(lastMkdirCall[0]).toBe("/mock/dir");

    // Trigger the callback
    const mkdirCb = lastMkdirCall[lastMkdirCall.length - 1] as (
      ...args: unknown[]
    ) => unknown;
    (mkdirCb as any)(null);

    expect(fs.appendFile).toHaveBeenCalled();
    const appendCalls = vi.mocked(fs.appendFile).mock.calls;
    const lastAppendCall = appendCalls[appendCalls.length - 1];
    const appendCb = lastAppendCall[lastAppendCall.length - 1] as (
      ...args: unknown[]
    ) => unknown;

    // Trigger error in appendFile
    (appendCb as any)(new Error("append fail"));
    expect(config.debugLog?.enabled).toBe(false);
  });

  it("should handle debug log errors", () => {
    const config = {
      debugLog: { enabled: true, path: "/mock/error.log" },
    } as unknown as LoadedConfig;
    setGlobalConfig(config);

    writeDebugLog("Error test");
    const mkdirCalls = vi.mocked(fs.mkdir).mock.calls;
    const lastMkdirCall = mkdirCalls[mkdirCalls.length - 1];
    const mkdirCb = lastMkdirCall[lastMkdirCall.length - 1] as (
      ...args: unknown[]
    ) => unknown;

    (mkdirCb as any)(new Error("mkdir fail"));
    expect(config.debugLog?.enabled).toBe(false);
  });

  it("should notify with UI", () => {
    const mockCtx = {
      hasUI: true,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    notify(mockCtx, "error", "msg");
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "[model-selector] msg",
      "error",
    );
  });

  it("should notify via console without UI", () => {
    const mockCtx = { hasUI: false } as unknown as ExtensionContext;
    const warnSpy = vi.spyOn(console, "warn");
    const errorSpy = vi.spyOn(console, "error");
    const logSpy = vi.spyOn(console, "log");

    notify(mockCtx, "warning", "warn msg");
    expect(warnSpy).toHaveBeenCalledWith("[model-selector] warn msg");

    notify(mockCtx, "error", "err msg");
    expect(errorSpy).toHaveBeenCalledWith("[model-selector] err msg");

    notify(mockCtx, "info", "info msg");
    expect(logSpy).toHaveBeenCalledWith("[model-selector] info msg");
  });
});
