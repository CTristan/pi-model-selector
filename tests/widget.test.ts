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
      const renderFn = setWidgetMock.mock.calls[0][1];
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
      const renderFn = setWidgetMock.mock.calls[0][1];
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
      const renderFn = setWidgetMock.mock.calls[0][1];
      const widget = renderFn(null, theme);
      expect(widget.render(5)).toHaveLength(3);
      expect(widget.invalidate()).toBeUndefined();
    });
  });
});
