import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as PiTui from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";

import {
  Container,
  DynamicBorder,
  SelectList,
  Spacer,
  Text,
} from "./adapter.js";

import type { PriorityRule } from "./types.js";

const CATCH_ALL_PATTERNS = ["*", ".*", "^.*$", "^.*", ".*$", ".+", "^.+$"];

/** Whether the active context can render custom terminal components. */
export function isTuiContext(ctx: ExtensionContext): boolean {
  const mode = (ctx as ExtensionContext & { mode?: unknown }).mode;
  return mode === undefined ? ctx.hasUI : mode === "tui";
}

/** Returns whether an ignore mapping covers every window for a provider. */
export function isCatchAllIgnoreMapping(usage: {
  window?: string | null;
  windowPattern?: string | null;
}): boolean {
  const hasWindow =
    usage.window !== undefined && usage.window !== null && usage.window !== "";
  const hasWindowPattern =
    usage.windowPattern !== undefined &&
    usage.windowPattern !== null &&
    usage.windowPattern !== "";

  if (!hasWindow && !hasWindowPattern) {
    return true;
  }

  if (usage.windowPattern) {
    if (CATCH_ALL_PATTERNS.includes(usage.windowPattern)) {
      return true;
    }
  }

  return false;
}

/** Returns whether provider/account usage is suppressed by catch-all ignore mapping. */
export function isProviderIgnored(
  provider: string,
  account: string | undefined,
  mappings: {
    usage: {
      provider: string;
      account?: string;
      window?: string | null;
      windowPattern?: string | null;
    };
    ignore?: boolean;
  }[],
): boolean {
  return mappings.some(
    (m) =>
      m.usage.provider === provider &&
      (m.usage.account === undefined || m.usage.account === account) &&
      m.ignore === true &&
      isCatchAllIgnoreMapping(m.usage),
  );
}

/** Shows a selectable list using Pi UI, falling back to standard select when needed. */
export async function selectWrapped(
  ctx: ExtensionContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  if (!ctx.hasUI) return options[0];

  // In tests, fall back to standard select for easier mocking
  const isVitest =
    (import.meta as unknown as { env?: { VITEST?: boolean } }).env?.VITEST ||
    (typeof process !== "undefined" && !!process.env.VITEST);

  if (isVitest || !isTuiContext(ctx) || !ctx.ui.custom) {
    return ctx.ui.select(title, options);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));

    const items = options.map((o) => ({ value: o, label: o }));
    // Build the select list theme from the callback's theme parameter instead of
    // calling getSelectListTheme(), which captures the module-level theme singleton
    // that may not be initialized in the extension's module context (e.g. when the
    // host runtime mirrors the extension into a temp directory for compat).
    const nav = "nav" in theme ? theme.nav : undefined;
    const selectListTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("muted", text),
      noMatch: (text: string) => theme.fg("muted", text),
      // OMP's SelectList requires symbols.cursor; Pi tolerates the fallback.
      // Use a defensive check so both runtimes work.
      symbols: {
        cursor:
          nav && typeof nav === "object" && "cursor" in nav
            ? (nav as { cursor: string }).cursor
            : ">",
      },
    };
    const selectList = new SelectList(
      items,
      Math.min(items.length, 15),
      selectListTheme as unknown as PiTui.SelectListTheme,
    );
    selectList.onSelect = (item: SelectItem) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);

    container.addChild(new Spacer(1));
    container.addChild(
      new Text("↑↓ to navigate  Enter to select  Esc to cancel", 1, 0),
    );
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** Preset priority-rule orderings offered by the configuration wizard. */
export const priorityOptions: Array<{ label: string; value: PriorityRule[] }> =
  [
    {
      label: "fullAvailability → remainingPercent → earliestReset",
      value: ["fullAvailability", "remainingPercent", "earliestReset"],
    },
    {
      label: "fullAvailability → earliestReset → remainingPercent",
      value: ["fullAvailability", "earliestReset", "remainingPercent"],
    },
    {
      label: "remainingPercent → fullAvailability → earliestReset",
      value: ["remainingPercent", "fullAvailability", "earliestReset"],
    },
    {
      label: "remainingPercent → earliestReset → fullAvailability",
      value: ["remainingPercent", "earliestReset", "fullAvailability"],
    },
    {
      label: "earliestReset → fullAvailability → remainingPercent",
      value: ["earliestReset", "fullAvailability", "remainingPercent"],
    },
    {
      label: "earliestReset → remainingPercent → fullAvailability",
      value: ["earliestReset", "remainingPercent", "fullAvailability"],
    },
  ];
