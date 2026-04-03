import { describe, expect, it } from "vitest";

import {
  getRecommendedModelProvidersForUsageProvider,
  sortModelsForUsageProvider,
} from "../src/model-provider-affinity.js";

describe("model provider affinity", () => {
  it.each([
    {
      usageProvider: "codex",
      expected: ["codex", "openai-codex"],
    },
    {
      usageProvider: "copilot",
      expected: ["copilot", "github-copilot"],
    },
    {
      usageProvider: "gemini",
      expected: ["gemini", "google"],
    },
    {
      usageProvider: "zai",
      expected: ["zai", "openai"],
    },
  ])("returns recommended model providers for $usageProvider buckets", ({
    usageProvider,
    expected,
  }) => {
    expect(getRecommendedModelProvidersForUsageProvider(usageProvider)).toEqual(
      expected,
    );
  });

  it("prioritizes recommended providers but keeps all models available", () => {
    const sorted = sortModelsForUsageProvider(
      [
        { provider: "openai", id: "gpt-4.1" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai-codex", id: "gpt-4o" },
      ],
      "codex",
    );

    expect(sorted).toEqual([
      { provider: "openai-codex", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-4.1" },
    ]);
  });

  it("prefers exact provider matches before aliases", () => {
    const sorted = sortModelsForUsageProvider(
      [
        { provider: "openai-codex", id: "gpt-4o" },
        { provider: "codex", id: "legacy-codex" },
        { provider: "openai", id: "gpt-4.1" },
      ],
      "codex",
    );

    expect(sorted).toEqual([
      { provider: "codex", id: "legacy-codex" },
      { provider: "openai-codex", id: "gpt-4o" },
      { provider: "openai", id: "gpt-4.1" },
    ]);
  });

  it("falls back to alphabetical ordering for unknown providers", () => {
    const sorted = sortModelsForUsageProvider(
      [
        { provider: "zeta", id: "model-b" },
        { provider: "alpha", id: "model-c" },
        { provider: "alpha", id: "model-a" },
      ],
      "unknown-provider",
    );

    expect(sorted).toEqual([
      { provider: "alpha", id: "model-a" },
      { provider: "alpha", id: "model-c" },
      { provider: "zeta", id: "model-b" },
    ]);
  });
});
