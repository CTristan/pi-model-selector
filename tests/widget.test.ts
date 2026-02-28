import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { LoadedConfig, UsageCandidate } from "../src/types.js";
import {
  clearWidget,
  renderUsageWidget,
  updateWidgetState,
} from "../src/widget.js";

describe("Widget", () => {
  const theme = {
    fg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
  } as unknown as Theme;

  it("should handle clearing widget when disabled or empty", async () => {
    const mockCtx = {
      hasUI: true,
      ui: { setWidget: vi.fn() },
    } as unknown as ExtensionContext;

    // Disabled
    updateWidgetState({
      candidates: [],
      config: { widget: { enabled: false } } as unknown as LoadedConfig,
    });
    renderUsageWidget(mockCtx);
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(
      "model-selector",
      undefined,
    );

    // Empty candidates
    updateWidgetState({
      candidates: [],
      config: {
        widget: { enabled: true, showCount: 5 },
      } as unknown as LoadedConfig,
    });
    renderUsageWidget(mockCtx);
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(
      "model-selector",
      undefined,
    );
  });

  it("should clear widget explicitly", async () => {
    const mockCtx = {
      hasUI: true,
      ui: { setWidget: vi.fn() },
    } as unknown as ExtensionContext;
    clearWidget(mockCtx);
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(
      "model-selector",
      undefined,
    );
  });

  it("should handle no UI or no setWidget branch", () => {
    const mockCtxNoUI = { hasUI: false } as unknown as ExtensionContext;
    expect(() => renderUsageWidget(mockCtxNoUI)).not.toThrow();

    const mockCtxNoSet = {
      hasUI: true,
      ui: {},
    } as unknown as ExtensionContext;
    expect(() => renderUsageWidget(mockCtxNoSet)).not.toThrow();
  });

  describe("renderUsageWidget helpers", () => {
    it("should consolidate redundant candidates and buckets", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [
          {
            usage: { provider: "p1" },
            model: { provider: "mp", id: "mi" },
          },
        ],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 0,
          remainingPercent: 100,
        },
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W2",
          usedPercent: 0,
          remainingPercent: 100,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(200);
      expect(output[1]).not.toContain("│");
    });

    it("should handle different remaining percentage colors and icons", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [{ usage: { provider: "ignored" }, ignore: true }],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 90,
          remainingPercent: 10,
        },
        {
          provider: "p2",
          displayName: "D2",
          windowLabel: "W2",
          usedPercent: 60,
          remainingPercent: 40,
        },
        {
          provider: "p3",
          displayName: "D3",
          windowLabel: "W3",
          usedPercent: 10,
          remainingPercent: 90,
        },
        {
          provider: "ignored",
          displayName: "I",
          windowLabel: "W",
          usedPercent: 0,
          remainingPercent: 100,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).toContain("[error]");
      expect(output[1]).toContain("[warning]");
      expect(output[1]).toContain("[success]");
      expect(output[1]).toContain("○"); // Ignored icon
    });

    it("should handle small width render and invalidate", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [],
        widget: { enabled: true, showCount: 1, placement: "aboveEditor" },
      } as unknown as LoadedConfig;
      updateWidgetState({
        candidates: [
          {
            provider: "p",
            displayName: "D",
            windowLabel: "W",
            usedPercent: 0,
            remainingPercent: 100,
          },
        ],
        config,
      });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      expect(widget.render(5)).toHaveLength(3);
      expect(widget.invalidate()).toBeUndefined();
    });

    it("should render auto-selection disabled status in red", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [],
        widget: { enabled: true, showCount: 3, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 0,
          remainingPercent: 100,
        },
        {
          provider: "p2",
          displayName: "D2",
          windowLabel: "W2",
          usedPercent: 20,
          remainingPercent: 80,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config, autoSelectionDisabled: true });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      // Should show AUTO OFF message only, no candidates
      expect(output[1]).toContain("[error]AUTO OFF[/error]");
      expect(output[1]).not.toContain("D1");
      expect(output[1]).not.toContain("D2");
    });

    it("should show AUTO OFF even without candidates", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [],
        widget: { enabled: true, showCount: 3, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      updateWidgetState({
        candidates: [],
        config,
        autoSelectionDisabled: true,
      });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      // Should show AUTO OFF message even without candidates
      expect(output[1]).toContain("[error]AUTO OFF[/error]");
    });

    it("should show candidates when auto-selection is enabled", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [],
        widget: { enabled: true, showCount: 3, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 0,
          remainingPercent: 100,
        },
        {
          provider: "p2",
          displayName: "D2",
          windowLabel: "W2",
          usedPercent: 20,
          remainingPercent: 80,
        },
        {
          provider: "p3",
          displayName: "D3",
          windowLabel: "W3",
          usedPercent: 40,
          remainingPercent: 60,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config, autoSelectionDisabled: false });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      // Should show candidates when auto-selection is enabled
      expect(output[1]).not.toContain("[error]AUTO OFF[/error]");
      expect(output[1]).toContain("D1");
      expect(output[1]).toContain("D2");
      expect(output[1]).toContain("D3");
    });
  });

  describe("Reserve Indicator", () => {
    it("should show reserve indicator for candidate below reserve threshold", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [
          {
            usage: { provider: "p1", window: "W1" },
            model: { provider: "mp", id: "mi" },
            reserve: 20,
          },
        ],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 85,
          remainingPercent: 15,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).toContain("reserve: 20%");
    });

    it("should not show reserve indicator for candidate above reserve threshold", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [
          {
            usage: { provider: "p1", window: "W1" },
            model: { provider: "mp", id: "mi" },
            reserve: 20,
          },
        ],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 50,
          remainingPercent: 50,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).not.toContain("reserve:");
    });

    it("should not show reserve indicator for candidate at 0% (exhausted)", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [
          {
            usage: { provider: "p1", window: "W1" },
            model: { provider: "mp", id: "mi" },
            reserve: 20,
          },
        ],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 100,
          remainingPercent: 0,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).not.toContain("reserve:");
    });

    it("should not show reserve indicator for unmapped candidate", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 85,
          remainingPercent: 15,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).not.toContain("reserve:");
    });

    it("should not show reserve indicator when reserve is 0", () => {
      const setWidgetMock = vi.fn();
      const mockCtx = {
        hasUI: true,
        ui: { setWidget: setWidgetMock },
      } as unknown as ExtensionContext;
      const config = {
        mappings: [
          {
            usage: { provider: "p1", window: "W1" },
            model: { provider: "mp", id: "mi" },
            reserve: 0,
          },
        ],
        widget: { enabled: true, showCount: 5, placement: "belowEditor" },
      } as unknown as LoadedConfig;
      const candidates = [
        {
          provider: "p1",
          displayName: "D1",
          windowLabel: "W1",
          usedPercent: 85,
          remainingPercent: 15,
        },
      ] as unknown as UsageCandidate[];
      updateWidgetState({ candidates, config });
      renderUsageWidget(mockCtx);
      const renderFn = setWidgetMock.mock.calls![0]![1]!;
      const widget = renderFn(null, theme);
      const output = widget.render(500);
      expect(output[1]).not.toContain("reserve:");
    });
  });
});
