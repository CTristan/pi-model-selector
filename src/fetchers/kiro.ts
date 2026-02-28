import * as os from "node:os";
import type { RateWindow, UsageSnapshot } from "../types.js";
import { execAsync, formatReset } from "./common.js";

function stripAnsi(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Standard ANSI escape sequence regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><~]/g,
    "",
  );
}

async function whichAsync(cmd: string): Promise<string | null> {
  try {
    const isWindows = os.platform() === "win32";
    const whichCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
    const { stdout } = await execAsync(whichCmd, { encoding: "utf-8" });
    const lines = stdout.trim().split(/\r?\n/);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

export function parseSingleKiroResetDate(dateStr: string): Date | undefined {
  const parts = dateStr.split("/").map(Number);
  if (parts.length !== 2) return undefined;

  const first = parts[0];
  const second = parts[1];
  const now = new Date();
  const year = now.getFullYear();

  if (first === undefined || second === undefined) return undefined;

  const dateMD = new Date(year, first - 1, second);
  const dateDM = new Date(year, second - 1, first);
  const isValid = (d: Date) => !Number.isNaN(d.getTime());

  if (!isValid(dateMD) && !isValid(dateDM)) return undefined;

  // Heuristic: pick the interpretation that results in the closest future date.
  // Try current year, next year, and previous year to handle wrap-around.
  const years = [year, year + 1, year - 1];
  const candidates: Date[] = [];

  for (const y of years) {
    const dMD = new Date(y, first - 1, second);
    const dDM = new Date(y, second - 1, first);
    if (!Number.isNaN(dMD.getTime())) candidates.push(dMD);
    if (!Number.isNaN(dDM.getTime())) candidates.push(dDM);
  }

  if (candidates.length === 0) return undefined;

  // We want to prefer dates that are "soon", either in the near future or very recent past.
  const CLOSE_THRESHOLD = 7 * 24 * 60 * 60 * 1000;

  candidates.sort((a, b) => {
    const diffA = a.getTime() - now.getTime();
    const diffB = b.getTime() - now.getTime();

    const isCloseA = Math.abs(diffA) < CLOSE_THRESHOLD;
    const isCloseB = Math.abs(diffB) < CLOSE_THRESHOLD;

    if (isCloseA && !isCloseB) return -1;
    if (!isCloseA && isCloseB) return 1;

    const isFutureA = diffA > 0;
    const isFutureB = diffB > 0;

    if (isFutureA && !isFutureB) return -1;
    if (!isFutureA && isFutureB) return 1;

    return Math.abs(diffA) - Math.abs(diffB);
  });

  const resetsAt = candidates[0];

  if (!resetsAt) return undefined;

  // If we picked a date > 7 days in the past, assume it's actually next year's occurrence
  // (This handles cases where the CLI shows a fixed day of month that just passed)
  if (resetsAt.getTime() < now.getTime() - 7 * 24 * 60 * 60 * 1000) {
    resetsAt.setFullYear(resetsAt.getFullYear() + 1);
  }

  return resetsAt;
}

/**
 * Parses Kiro CLI output to extract multiple quota windows.
 */
export function parseKiroWindows(output: string): RateWindow[] {
  const windows: RateWindow[] = [];
  const lines = output.split("\n");

  // Global regexes to find all occurrences on a line
  const combinedRegex =
    /(?:(.*?))?(?:(Progress|Usage|Credits|Quota|Remaining|Bonus):?\s*(?:█+|[#=]+|\s+)?(\d+)%|(Progress|Usage|Credits|Quota|Remaining|Bonus):?\s*\(?(\d+\.?\d*)\s*(?:\/|of)\s*(\d+\.?\d*)\)?)/gi;
  const resetRegex = /resets\s+on\s+\b(\d{1,2}\/\d{1,2})\b/gi;
  const expiryRegex = /expires\s+in\s+(\d+)\s+days?/gi;

  const ignoreLabels = [
    "system health",
    "disk usage",
    "cpu",
    "memory",
    "bandwidth",
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Reset regex indices for each line to avoid persistence bugs
    combinedRegex.lastIndex = 0;
    resetRegex.lastIndex = 0;
    expiryRegex.lastIndex = 0;

    // Keep track of quotas found on this line with their positions
    const quotasWithIndices: Array<{ w: RateWindow; end: number }> = [];

    let match = combinedRegex.exec(trimmedLine);
    while (match !== null) {
      const fullPrefix = match[1] || "";
      const isPct = match[2] !== undefined;
      const keyword = isPct ? match[2] : match[4];

      const prefixParts = fullPrefix.split("|");
      const lastPrefixPart = prefixParts[prefixParts.length - 1];
      let cleanPrefix = lastPrefixPart?.trim() ?? "";
      // Remove residues from previous quotas on the same line
      cleanPrefix = cleanPrefix
        .replace(/resets\s+on\s+\b\d{1,2}\/\d{1,2}\b\s*/gi, "")
        .replace(/expires\s+in\s+\d+\s+days?\s*/gi, "")
        .replace(/\d+%\s*/g, "")
        .replace(/\d+\.?\d*\s*(?:\/|of)\s*\d+\.?\d*\s*/g, "")
        .replace(/\(?\d+\.?\d*\s*(?:\/|of)\s*\d+\.?\d*\)?\s*/g, "")
        .trim();

      let label = cleanPrefix.replace(/^[:\s-]+|[:\s-]+$/g, "").trim();

      if (!label || label === "-") {
        label = keyword || "Credits";
      } else if (
        keyword &&
        !label.toLowerCase().includes(keyword.toLowerCase())
      ) {
        label = `${label} ${keyword}`.trim();
      }

      if (ignoreLabels.some((l) => label.toLowerCase().includes(l))) {
        match = combinedRegex.exec(trimmedLine);
        continue;
      }

      const keywordLower = (keyword || "").toLowerCase();
      const isRemaining =
        keywordLower === "remaining" ||
        keywordLower === "credits" ||
        keywordLower === "bonus" ||
        label.toLowerCase().includes("bonus");

      let usedPercent = 0;
      if (isPct) {
        const valStr = match[3];
        if (valStr !== undefined) {
          const val = parseInt(valStr, 10);
          usedPercent = isRemaining ? 100 - val : val;
        }
      } else {
        const val1Str = match[5];
        const totalStr = match[6];
        if (val1Str !== undefined && totalStr !== undefined) {
          const val1 = parseFloat(val1Str);
          const total = parseFloat(totalStr);
          usedPercent =
            total > 0
              ? isRemaining
                ? ((total - val1) / total) * 100
                : (val1 / total) * 100
              : 0;
        }
      }

      const window: RateWindow = {
        label,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
      };
      if (
        window.label.toLowerCase().includes("bonus") ||
        (window.label.toLowerCase() === "remaining" &&
          trimmedLine.toLowerCase().includes("bonus"))
      ) {
        if (
          /^(?:remaining\s+)?bonus(?:\s+credits)?$/i.test(window.label) ||
          window.label.toLowerCase() === "remaining"
        ) {
          window.label = "Bonus";
        }
      }
      windows.push(window);
      quotasWithIndices.push({ w: window, end: combinedRegex.lastIndex });
      match = combinedRegex.exec(trimmedLine);
    }

    // Sort quotas on this line by their end position to help with assignments
    quotasWithIndices.sort((a, b) => a.end - b.end);

    // Reset dates: assign to the most recent quota found before the reset string
    let resetMatch = resetRegex.exec(trimmedLine);
    while (resetMatch !== null) {
      const dateStr = resetMatch[1];
      if (dateStr !== undefined) {
        const resetsAt = parseSingleKiroResetDate(dateStr);
        if (resetsAt) {
          const target = [...quotasWithIndices]
            .reverse()
            .find((q) => q.end <= (resetMatch?.index ?? 0));
          if (target) {
            target.w.resetsAt = resetsAt;
            target.w.resetDescription = formatReset(resetsAt);
          } else if (windows.length > 0) {
            // Fallback to the very last window found so far
            const last = windows[windows.length - 1];
            if (last && !last.resetsAt) {
              last.resetsAt = resetsAt;
              last.resetDescription = formatReset(resetsAt);
            }
          }
        }
      }
      resetMatch = resetRegex.exec(trimmedLine);
    }

    // Expiry: assign to the most recent quota found before the expiry string
    let expiryMatch = expiryRegex.exec(trimmedLine);
    while (expiryMatch !== null) {
      const daysStr = expiryMatch[1];
      if (daysStr !== undefined) {
        const target = [...quotasWithIndices]
          .reverse()
          .find((q) => q.end <= (expiryMatch?.index ?? 0));
        if (target) {
          target.w.resetDescription = `${daysStr}d left`;
        } else if (windows.length > 0) {
          const last = windows[windows.length - 1];
          if (last && !last.resetDescription) {
            last.resetDescription = `${daysStr}d left`;
          }
        }
      }
      expiryMatch = expiryRegex.exec(trimmedLine);
    }
  }

  // Deduplicate windows by label (take the one with higher usedPercent if same label)
  const deduped: Record<string, RateWindow> = {};
  for (const w of windows) {
    const existing = deduped[w.label];
    if (
      !existing ||
      w.usedPercent > existing.usedPercent ||
      (w.usedPercent === existing.usedPercent &&
        (w.resetDescription || w.resetsAt))
    ) {
      deduped[w.label] = w;
    } else if (existing && !existing.resetDescription && w.resetDescription) {
      existing.resetDescription = w.resetDescription;
      existing.resetsAt = w.resetsAt ?? undefined;
    }
  }

  return Object.values(deduped);
}

export async function fetchKiroUsage(): Promise<UsageSnapshot> {
  const kiroBinary = await whichAsync("kiro-cli");
  if (!kiroBinary) {
    return {
      provider: "kiro",
      displayName: "Kiro",
      windows: [],
      error: "kiro-cli not found",
      account: "cli",
    };
  }

  try {
    try {
      await execAsync("kiro-cli whoami", { timeout: 5000 });
    } catch {
      return {
        provider: "kiro",
        displayName: "Kiro",
        windows: [],
        error: "Not logged in",
        account: "cli",
      };
    }

    const { stdout: output } = await execAsync(
      "kiro-cli chat --no-interactive /usage",
      {
        timeout: 10000,
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    const stripped = stripAnsi(output);

    let planName = "Kiro";
    const planMatch = stripped.match(/\|\s*(KIRO\s+\w+)/i);
    if (planMatch?.[1]) {
      planName = planMatch[1].trim();
    }

    const windows = parseKiroWindows(stripped);

    return {
      provider: "kiro",
      displayName: "Kiro",
      windows,
      plan: planName,
      account: "cli",
    };
  } catch (error: unknown) {
    return {
      provider: "kiro",
      displayName: "Kiro",
      windows: [],
      error: String(error),
      account: "cli",
    };
  }
}
