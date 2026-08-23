import { describe, expect, it } from "vitest";
import type { MappingEntry } from "../src/types.js";
import {
  getUsageProviderAdapter,
  getUsageProviderAdapters,
  getUsageProviderAdaptersForMappings,
  isUnavailableUsageSnapshot,
} from "../src/usage-provider-adapters.js";

describe("usage provider adapters", () => {
  it("keeps quota source IDs separate from Pi provider IDs", () => {
    const copilot = getUsageProviderAdapter("copilot");

    expect(copilot).toBeDefined();
    expect(copilot?.usageProvider).toBe("copilot");
    expect(copilot?.piProviderIds).toEqual(["github-copilot"]);
    expect(copilot?.authMode).toBe("legacy");
  });

  it("lists every supported quota source without requiring a toggle", () => {
    expect(
      getUsageProviderAdapters().map((adapter) => adapter.usageProvider),
    ).toEqual([
      "anthropic",
      "copilot",
      "gemini",
      "codex",
      "antigravity",
      "kiro",
      "zai",
      "minimax",
      "opencode-go",
    ]);
  });

  it("binds OpenCode Go quota to Pi's opencode-go provider auth", () => {
    const opencodeGo = getUsageProviderAdapter("opencode-go");

    expect(opencodeGo).toBeDefined();
    expect(opencodeGo?.piProviderIds).toEqual(["opencode-go"]);
    expect(opencodeGo?.authMode).toBe("pi");
  });

  it("returns only adapters referenced by model mappings", () => {
    const mappings: MappingEntry[] = [
      {
        usage: { provider: "anthropic", window: "Sonnet" },
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      },
      {
        usage: { provider: "codex", window: "1w" },
        ignore: true,
      },
    ];

    expect(
      getUsageProviderAdaptersForMappings(mappings).map(
        (adapter) => adapter.usageProvider,
      ),
    ).toEqual(["anthropic", "codex"]);
  });

  it("classifies expected missing-credential snapshots as unavailable", () => {
    expect(
      isUnavailableUsageSnapshot({
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: "No credentials",
      }),
    ).toBe(true);
    expect(
      isUnavailableUsageSnapshot({
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: "HTTP 500",
      }),
    ).toBe(false);
  });
});
