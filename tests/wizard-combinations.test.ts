import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as configMod from "../src/config.js";
import type {
  LoadedConfig,
  MappingEntry,
  UsageSnapshot,
} from "../src/types.js";
import * as usageFetchers from "../src/usage-fetchers.js";

// Mocks
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
  platform: () => "darwin",
}));

vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js");

describe("Wizard Combination Flow", () => {
  let commands: Record<string, any> = {};
  let ctx: any;

  // Setup basic usage snapshot
  const usageSnapshots: UsageSnapshot[] = [
    {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "Sonnet", usedPercent: 10, resetsAt: new Date() }],
    },
  ];

  // Setup basic config
  const initialConfig: LoadedConfig = {
    mappings: [],
    priority: ["remainingPercent"],
    widget: { enabled: true, placement: "belowEditor", showCount: 3 },
    autoRun: false,
    disabledProviders: [],
    sources: { globalPath: "global.json", projectPath: "project.json" },
    raw: { global: {}, project: {} },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    commands = {};

    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn((name: string, options: any) => {
        commands[name] = options.handler;
      }),
    };

    ctx = {
      modelRegistry: {
        getAvailable: () =>
          Promise.resolve([
            { provider: "anthropic", id: "claude-3-5-sonnet-latest" },
          ]),
      },
      ui: {
        notify: vi.fn(),
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
      },
      hasUI: true,
      cwd: "/mock/cwd",
    };

    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(usageSnapshots);
    vi.mocked(configMod.loadConfig).mockResolvedValue(initialConfig);
    vi.mocked(configMod.getRawMappings).mockReturnValue([]);
    vi.mocked(configMod.clearBucketMappings).mockReturnValue(0);
    vi.mocked(configMod.saveConfigFile).mockResolvedValue(undefined);

    modelSelectorExtension(pi as unknown as ExtensionAPI);
  });

  it("should create a combination mapping when 'Combine bucket' is selected", async () => {
    // Mock UI interaction sequence
    ctx.ui.select
      .mockResolvedValueOnce("Edit mappings") // Main menu
      .mockResolvedValueOnce(
        "anthropic/Sonnet (90% remaining, Claude) [unmapped]",
      ) // Select candidate
      .mockResolvedValueOnce("Project (project.json)") // Select location
      .mockResolvedValueOnce("Combine bucket") // Select action
      .mockResolvedValueOnce("Done"); // Exit loop (simulated by failure to select next action or specific mock return)

    ctx.ui.input.mockResolvedValueOnce("My Combined Group"); // Enter group name
    ctx.ui.confirm.mockResolvedValue(false); // Do not add another mapping

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    // Verify upsertMapping was called with correct structure
    expect(configMod.upsertMapping).toHaveBeenCalledTimes(1);
    const [raw, mapping] = vi.mocked(configMod.upsertMapping).mock.calls[0];

    expect(raw).toBe(initialConfig.raw.project);
    expect(mapping).toEqual({
      usage: {
        provider: "anthropic",
        window: "Sonnet",
        account: undefined,
        windowPattern: undefined,
      },
      combine: "My Combined Group",
    });

    expect(configMod.clearBucketMappings).toHaveBeenCalledWith(
      initialConfig.raw.project,
      {
        provider: "anthropic",
        account: undefined,
        window: "Sonnet",
      },
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        'Combined anthropic/Sonnet into "My Combined Group".',
      ),
      "info",
    );
  });

  it("should create a combination mapping when 'Combine by pattern' is selected", async () => {
    // Mock UI interaction sequence
    ctx.ui.select
      .mockResolvedValueOnce("Edit mappings") // Main menu
      .mockResolvedValueOnce(
        "anthropic/Sonnet (90% remaining, Claude) [unmapped]",
      ) // Select candidate
      .mockResolvedValueOnce("Project (project.json)") // Select location
      .mockResolvedValueOnce("Combine by pattern") // Select action
      .mockResolvedValueOnce("Done"); // Exit loop

    ctx.ui.input
      .mockResolvedValueOnce("^Sonnet.*") // Regex pattern
      .mockResolvedValueOnce("Pattern Group"); // Group name

    ctx.ui.confirm.mockResolvedValue(false);

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    // Verify upsertMapping was called with correct structure
    expect(configMod.upsertMapping).toHaveBeenCalledTimes(1);
    const [_raw, mapping] = vi.mocked(configMod.upsertMapping).mock.calls[0];

    expect(mapping).toEqual({
      usage: {
        provider: "anthropic",
        window: undefined,
        account: undefined,
        windowPattern: "^Sonnet.*",
      },
      combine: "Pattern Group",
    });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        'Combined anthropic/^Sonnet.* into "Pattern Group".',
      ),
      "info",
    );
  });

  it("should allow choosing an existing combination name", async () => {
    const configWithCombinations: LoadedConfig = {
      ...initialConfig,
      mappings: [{ usage: { provider: "p1" }, combine: "Existing Group" }],
    };
    vi.mocked(configMod.loadConfig).mockResolvedValue(configWithCombinations);

    ctx.ui.select
      .mockResolvedValueOnce("Edit mappings")
      .mockResolvedValueOnce(
        "anthropic/Sonnet (90% remaining, Claude) [unmapped]",
      )
      .mockResolvedValueOnce("Project (project.json)")
      .mockResolvedValueOnce("Combine bucket")
      .mockResolvedValueOnce("Existing Group") // Choose existing
      .mockResolvedValueOnce("Done");

    ctx.ui.confirm.mockResolvedValue(false);

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    const [, mapping] = vi.mocked(configMod.upsertMapping).mock.calls[0];
    expect(mapping.combine).toBe("Existing Group");
  });

  it("should allow entering a new name even if existing ones exist", async () => {
    const configWithCombinations: LoadedConfig = {
      ...initialConfig,
      mappings: [{ usage: { provider: "p1" }, combine: "Existing Group" }],
    };
    vi.mocked(configMod.loadConfig).mockResolvedValue(configWithCombinations);

    ctx.ui.select
      .mockResolvedValueOnce("Edit mappings")
      .mockResolvedValueOnce(
        "anthropic/Sonnet (90% remaining, Claude) [unmapped]",
      )
      .mockResolvedValueOnce("Project (project.json)")
      .mockResolvedValueOnce("Combine bucket")
      .mockResolvedValueOnce("Enter new name...") // Choose to enter new
      .mockResolvedValueOnce("Done");

    ctx.ui.input.mockResolvedValueOnce("Brand New Group");
    ctx.ui.confirm.mockResolvedValue(false);

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    const [, mapping] = vi.mocked(configMod.upsertMapping).mock.calls[0];
    expect(mapping.combine).toBe("Brand New Group");
  });

  it("should show source buckets even if they are combined", async () => {
    // Setup a config where Sonnet is combined
    const configWithCombination: LoadedConfig = {
      ...initialConfig,
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          combine: "My Group",
        },
      ],
    };
    vi.mocked(configMod.loadConfig).mockResolvedValue(configWithCombination);

    // Capture the labels passed to ctx.ui.select for choosing a bucket
    let capturedLabels: string[] = [];
    let menuCallCount = 0;
    ctx.ui.select.mockImplementation(
      (title: string, options: string[]): any => {
        if (title === "Select a usage bucket to map") {
          capturedLabels = options;
          return Promise.resolve(undefined); // Stop the mapping sub-loop
        }
        if (title === "Model selector configuration") {
          if (menuCallCount === 0) {
            menuCallCount++;
            return Promise.resolve("Edit mappings");
          }
          return Promise.resolve(undefined); // Exit the main wizard loop
        }
        return Promise.resolve(undefined);
      },
    );

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    // Should see both the source bucket (Sonnet) and the synthetic bucket (My Group)
    expect(capturedLabels).toContain(
      "anthropic/Sonnet (90% remaining, Claude) [combined: My Group]",
    );
    expect(capturedLabels).toContain(
      "anthropic/My Group (90% remaining, Claude) [unmapped]",
    );
  });

  it("should dissolve a combination group when 'Dissolve combination' is selected", async () => {
    // Setup a config where Sonnet and Haiku are combined into "My Group"
    const configWithCombination: LoadedConfig = {
      ...initialConfig,
      mappings: [
        {
          usage: { provider: "anthropic", window: "Sonnet" },
          combine: "My Group",
        },
        {
          usage: { provider: "anthropic", window: "Haiku" },
          combine: "My Group",
        },
      ],
      raw: {
        ...initialConfig.raw,
        project: {
          mappings: [
            {
              usage: { provider: "anthropic", window: "Sonnet" },
              combine: "My Group",
            },
            {
              usage: { provider: "anthropic", window: "Haiku" },
              combine: "My Group",
            },
          ],
        },
      },
    };
    vi.mocked(configMod.loadConfig).mockResolvedValue(configWithCombination);
    vi.mocked(configMod.getRawMappings).mockReturnValue(
      configWithCombination.raw.project.mappings as MappingEntry[],
    );
    // Also ensure the synthetic candidate has correct properties
    const usageSnapshotsWithHaiku: UsageSnapshot[] = [
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "Sonnet", usedPercent: 10 },
          { label: "Haiku", usedPercent: 10 },
        ],
      },
    ];
    vi.mocked(usageFetchers.fetchAllUsages).mockResolvedValue(
      usageSnapshotsWithHaiku,
    );

    let menuCallCount = 0;
    ctx.ui.select.mockImplementation(
      (title: string, options: string[]): any => {
        if (title === "Model selector configuration") {
          if (menuCallCount === 0) {
            menuCallCount++;
            return Promise.resolve("Edit mappings");
          }
          return Promise.resolve(undefined);
        }
        if (title === "Select a usage bucket to map") {
          const label = options.find(
            (l) => l.includes("My Group") && l.includes("[unmapped]"),
          );
          return Promise.resolve(label);
        }
        if (title === "Modify mapping in") {
          return Promise.resolve("Project (project.json)");
        }
        if (title.startsWith("Select action for")) {
          return Promise.resolve("Dissolve combination");
        }
        return Promise.resolve(undefined);
      },
    );

    ctx.ui.confirm.mockImplementation((title: string) => {
      if (title === "Modify another mapping?") return Promise.resolve(false);
      return Promise.resolve(false);
    });

    const runWizard = commands["model-select-config"];
    await runWizard({}, ctx);

    // Verify "Dissolve combination" was an option
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("Select action for anthropic/My Group"),
      expect.arrayContaining(["Dissolve combination"]),
    );

    // Verify saveConfigFile was called
    expect(configMod.saveConfigFile).toHaveBeenCalled();

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Dissolved combination group "My Group"'),
      "info",
    );
  });
});
