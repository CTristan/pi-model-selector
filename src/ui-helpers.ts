import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
} from "@mariozechner/pi-coding-agent";

import {
  Container,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";

import type { PriorityRule } from "./types.js";

const CATCH_ALL_PATTERNS = ["*", ".*", "^.*$", "^.*", ".*$", ".+", "^.+$"];

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

  if (isVitest || !ctx.ui.custom) {
    return ctx.ui.select(title, options);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));

    const items = options.map((o) => ({ value: o, label: o }));
    const selectList = new SelectList(
      items,
      Math.min(items.length, 15),
      getSelectListTheme(),
    );
    selectList.onSelect = (item: SelectItem) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);

    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${rawKeyHint("↑↓", "navigate")}  ${keyHint("selectConfirm", "select")}  ${keyHint("selectCancel", "cancel")}`,
        1,
        0,
      ),
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
