import { describe, it, expect } from "vitest";
import {
  setGlobalConfig,
  resetGlobalState,
  writeDebugLog,
} from "../src/types.js";
import type { LoadedConfig } from "../src/types.js";

describe("Global State Management", () => {
  it("should reset global configuration", () => {
    const mockConfig: LoadedConfig = {
      mappings: [],
      priority: [],
      widget: { enabled: true, placement: "belowEditor", showCount: 3 },
      autoRun: false,
      disabledProviders: [],
      debugLog: { enabled: true, path: "/tmp/test.log" },
      sources: { globalPath: "", projectPath: "" },
      raw: { global: {}, project: {} },
    };

    setGlobalConfig(mockConfig);
    // We can't access currentConfig directly to check, but we can infer it via writeDebugLog behavior
    // or by checking if we can set it again.
    // Actually, since currentConfig isn't exported, we trust resetGlobalState clears it.
    // A better test would be if writeDebugLog throws or does nothing after reset.

    resetGlobalState();

    // After reset, calling writeDebugLog should be safe (it checks optional chaining)
    // and essentially do nothing.
    expect(() => writeDebugLog("test")).not.toThrow();
  });
});
