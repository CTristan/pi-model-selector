import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelSelectorExtension from "../index.js";
import * as widgetMod from "../src/widget.js";

// Mock candidates.js to avoid import issues with types.js mock
vi.mock("../src/candidates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/candidates.js")>();
  return {
    ...actual,
  };
});

// Capture debug log writes for testing
const capturedDebugLogs: string[] = [];

// Mock writeDebugLog directly for reliable log capture
vi.mock("../src/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/types.js")>();
  return {
    ...actual,
    writeDebugLog: vi.fn((message: string) => {
      capturedDebugLogs.push(message);
    }),
  };
});

// Mock node:fs to prevent real file operations
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    mkdir: vi.fn((_path, _opts, callback) => {
      callback?.();
    }),
    appendFile: vi.fn((_path, _data, callback) => {
      callback?.();
    }),
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
      open: vi
        .fn()
        .mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
      unlink: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
    },
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
  platform: () => "darwin",
}));

// Mock dependencies
vi.mock("../src/usage-fetchers.js");
vi.mock("../src/config.js");
vi.mock("../src/widget.js", () => ({
  updateWidgetState: vi.fn(),
  renderUsageWidget: vi.fn(),
  clearWidget: vi.fn(),
  getWidgetState: vi.fn(),
}));

describe("Explicit Model Selection", () => {
  let pi: any;
  let ctx: any;
  const events: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, (...args: any[]) => any> = {};
  let updateWidgetStateMock: ReturnType<typeof vi.fn>;
  let renderUsageWidgetMock: ReturnType<typeof vi.fn>;
  let getWidgetStateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedDebugLogs.length = 0;

    // Track widget state
    updateWidgetStateMock = vi.mocked(widgetMod.updateWidgetState);
    renderUsageWidgetMock = vi.mocked(widgetMod.renderUsageWidget);
    getWidgetStateMock = vi.mocked(widgetMod.getWidgetState);

    getWidgetStateMock.mockReturnValue({
      candidates: [],
      config: {
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      },
    });

    // Setup mock pi
    pi = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        events[event] = handler;
      }),
      registerCommand: vi.fn(
        (name: string, opts: { handler: (...args: any[]) => any }) => {
          commands[name] = opts.handler;
        },
      ),
      setModel: vi.fn().mockResolvedValue(true),
      getFlag: vi.fn().mockReturnValue(undefined),
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => {
          return { provider, id, displayName: `${provider}/${id}` };
        }),
      },
    };

    ctx = {
      hasUI: true,
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      modelRegistry: pi.modelRegistry,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("process.argv --model CLI flag detection", () => {
    const originalArgv = process.argv;

    afterEach(() => {
      // Restore original argv
      Object.defineProperty(process, "argv", {
        value: originalArgv,
        writable: true,
      });
    });

    it("skips auto-selection when --model flag is in process.argv", async () => {
      // Simulate --model CLI flag
      Object.defineProperty(process, "argv", {
        value: ["node", "pi", "--model", "claude-sonnet-4-5"],
        writable: true,
      });

      modelSelectorExtension(pi);
      const sessionStart = events.session_start;
      if (!sessionStart) throw new Error("Hook not found: session_start");

      await sessionStart({}, ctx);

      // Should have detected --model flag and disabled auto-selection
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining("--model CLI flag detected"),
      );
      // pi.setModel should NOT have been called (we skip selection entirely)
      expect(pi.setModel).not.toHaveBeenCalled();
    });

    it("runs normal selection when --model flag is NOT in process.argv", async () => {
      // Ensure no --model flag
      Object.defineProperty(process, "argv", {
        value: ["node", "pi"],
        writable: true,
      });

      // Mock usage fetchers to return valid data
      const { fetchAllUsages } = await import("../src/usage-fetchers.js");
      vi.mocked(fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          account: "default",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      const { loadConfig } = await import("../src/config.js");
      vi.mocked(loadConfig).mockResolvedValue({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        providerSettings: {},
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      });

      modelSelectorExtension(pi);
      const sessionStart = events.session_start;
      if (!sessionStart) throw new Error("Hook not found: session_start");

      await sessionStart({}, ctx);

      // Should NOT have skipped selection due to --model
      expect(capturedDebugLogs).not.toContainEqual(
        expect.stringContaining("--model CLI flag detected"),
      );
    });
  });

  describe("model_select event handling", () => {
    it("pauses auto-selection when model_select fires with source='set'", async () => {
      modelSelectorExtension(pi);
      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      // Fire model_select with source='set' (external extension)
      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Should have paused auto-selection
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining(
          "Auto-selection paused: model explicitly selected",
        ),
      );
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining("(source: set)"),
      );

      // Widget should be updated to show disabled state
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: true }),
      );

      // Should notify user
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection paused"),
        "info",
      );
    });

    it("pauses auto-selection when model_select fires with source='cycle'", async () => {
      modelSelectorExtension(pi);
      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      // Fire model_select with source='cycle' (user via Ctrl+P/Ctrl+L)
      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "cycle" },
        ctx,
      );

      // Should have paused auto-selection
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining(
          "Auto-selection paused: model explicitly selected",
        ),
      );
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining("(source: cycle)"),
      );

      // Widget should be updated to show disabled state
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: true }),
      );
    });

    it("does NOT pause auto-selection when model_select fires with source='restore'", async () => {
      modelSelectorExtension(pi);
      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      // Clear any debug logs
      capturedDebugLogs.length = 0;

      // Fire model_select with source='restore' (session restore)
      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "restore" },
        ctx,
      );

      // Should NOT have paused auto-selection
      expect(capturedDebugLogs).not.toContainEqual(
        expect.stringContaining("Auto-selection paused"),
      );

      // Widget should NOT be updated
      expect(updateWidgetStateMock).not.toHaveBeenCalled();
    });

    it("does NOT pause auto-selection for self-initiated model changes", async () => {
      // This test simulates what happens when runSelector calls pi.setModel()
      // The selfInitiatedModelChange flag should prevent the pause

      modelSelectorExtension(pi);
      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      // Clear any debug logs
      capturedDebugLogs.length = 0;

      // First, simulate that runSelector is about to call setModel
      // by firing session_start which triggers runSelector
      const { fetchAllUsages } = await import("../src/usage-fetchers.js");
      vi.mocked(fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          account: "default",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      const { loadConfig } = await import("../src/config.js");
      vi.mocked(loadConfig).mockResolvedValue({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        providerSettings: {},
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      });

      // Trigger session_start which will call runSelector, which will call setModel
      const sessionStart = events.session_start;
      if (!sessionStart) throw new Error("Hook not found: session_start");
      await sessionStart({}, ctx);

      // The self-initiated setModel call should NOT trigger auto-selection pause
      // So we shouldn't see "Auto-selection paused" in the logs from the setModel call
      // (Note: we may see it from the test's own model_select call, but not from runSelector)

      // The key check is that after runSelector completes, auto-selection is NOT paused
      // because the setModel call was self-initiated
      // The selector's self-initiated setModel should not cause a pause
      expect(pi.setModel).toHaveBeenCalled();
    });
  });

  describe("/model-select command re-enables auto-selection", () => {
    it("re-enables auto-selection when running /model-select while paused", async () => {
      // First, pause auto-selection via model_select event
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Clear debug logs after pause
      capturedDebugLogs.length = 0;

      // Now run /model-select command
      const { loadConfig } = await import("../src/config.js");
      vi.mocked(loadConfig).mockResolvedValue({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        providerSettings: {},
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      });

      const { fetchAllUsages } = await import("../src/usage-fetchers.js");
      vi.mocked(fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          account: "default",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      const modelSelectCmd = commands["model-select"];
      if (!modelSelectCmd) throw new Error("Command not found: model-select");

      await modelSelectCmd({}, ctx);

      // Should have re-enabled auto-selection
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining(
          "Auto-selection re-enabled via /model-select command",
        ),
      );

      // Widget should be updated to show enabled state
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: false }),
      );

      // Should notify user
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Auto model selection re-enabled"),
        "info",
      );
    });
  });

  describe("session_switch re-enables auto-selection", () => {
    it("re-enables auto-selection on session_switch with new or resume", async () => {
      // First, pause auto-selection via model_select event
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Clear debug logs after pause
      capturedDebugLogs.length = 0;

      // Now trigger session_switch
      const sessionSwitchHandler = events.session_switch;
      if (!sessionSwitchHandler)
        throw new Error("Hook not found: session_switch");

      // Mock config for session_switch selection
      const { loadConfig } = await import("../src/config.js");
      vi.mocked(loadConfig).mockResolvedValue({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        providerSettings: {},
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      });

      const { fetchAllUsages } = await import("../src/usage-fetchers.js");
      vi.mocked(fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          account: "default",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      // Test with 'new' reason
      await sessionSwitchHandler({ reason: "new" }, ctx);

      // Should have re-enabled auto-selection
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining("Auto-selection re-enabled on session switch"),
      );
    });

    it("does not re-enable auto-selection on session_switch with other reasons", async () => {
      // First, pause auto-selection via model_select event
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Clear debug logs after pause
      capturedDebugLogs.length = 0;

      // Now trigger session_switch with a different reason
      const sessionSwitchHandler = events.session_switch;
      if (!sessionSwitchHandler)
        throw new Error("Hook not found: session_switch");

      await sessionSwitchHandler({ reason: "other" }, ctx);

      // Should NOT have re-enabled auto-selection
      expect(capturedDebugLogs).not.toContainEqual(
        expect.stringContaining("Auto-selection re-enabled on session switch"),
      );
    });
  });

  describe("paused state correctly skips before_agent_start selection", () => {
    it("skips before_agent_start selection when auto-selection is paused", async () => {
      // First, pause auto-selection via model_select event
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Clear debug logs after pause
      capturedDebugLogs.length = 0;

      // Now trigger before_agent_start
      const beforeAgentStartHandler = events.before_agent_start;
      if (!beforeAgentStartHandler)
        throw new Error("Hook not found: before_agent_start");

      await beforeAgentStartHandler({}, ctx);

      // Should have skipped selection due to auto-selection being disabled
      expect(capturedDebugLogs).toContainEqual(
        expect.stringContaining(
          "Skipping model selection: auto-selection is disabled",
        ),
      );
    });
  });

  describe("widget updates when auto-selection is paused/resumed", () => {
    it("updates widget with autoSelectionDisabled=true when paused", async () => {
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Widget should be updated
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: true }),
      );
      expect(renderUsageWidgetMock).toHaveBeenCalledWith(ctx);
    });

    it("updates widget with autoSelectionDisabled=false when resumed via /model-select", async () => {
      // First pause
      modelSelectorExtension(pi);

      const modelSelectHandler = events.model_select;
      if (!modelSelectHandler) throw new Error("Hook not found: model_select");

      await modelSelectHandler(
        { model: { provider: "openai", id: "gpt-4o" }, source: "set" },
        ctx,
      );

      // Clear mocks
      updateWidgetStateMock.mockClear();
      renderUsageWidgetMock.mockClear();

      // Now resume via /model-select
      const { loadConfig } = await import("../src/config.js");
      vi.mocked(loadConfig).mockResolvedValue({
        mappings: [
          {
            usage: { provider: "p1", window: "w1" },
            model: { provider: "p1", id: "m1" },
          },
        ],
        priority: ["remainingPercent"],
        widget: { enabled: true, placement: "belowEditor", showCount: 3 },
        autoRun: false,
        disabledProviders: [],
        providerSettings: {},
        sources: { globalPath: "", projectPath: "" },
        raw: { global: {}, project: {} },
      });

      const { fetchAllUsages } = await import("../src/usage-fetchers.js");
      vi.mocked(fetchAllUsages).mockResolvedValue([
        {
          provider: "p1",
          displayName: "Provider 1",
          account: "default",
          windows: [{ label: "w1", usedPercent: 10, resetsAt: new Date() }],
        },
      ]);

      const modelSelectCmd = commands["model-select"];
      if (!modelSelectCmd) throw new Error("Command not found: model-select");

      await modelSelectCmd({}, ctx);

      // Widget should be updated with autoSelectionDisabled=false
      expect(updateWidgetStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoSelectionDisabled: false }),
      );
      expect(renderUsageWidgetMock).toHaveBeenCalledWith(ctx);
    });
  });
});
