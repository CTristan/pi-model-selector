import * as os from "node:os";
import type { RateWindow, UsageSnapshot } from "../types.js";
import { execAsync, formatReset } from "./common.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

async function whichAsync(cmd: string): Promise<string | null> {
  try {
    const isWindows = os.platform() === "win32";
    const whichCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
    const { stdout } = await execAsync(whichCmd, { encoding: "utf-8" });
    return stdout.trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function parseSingleKiroResetDate(dateStr: string): Date | undefined {
  const parts = dateStr.split("/").map(Number);
  if (parts.length !== 2) return undefined;

  const first = parts[0];
  const second = parts[1];
  const now = new Date();
  const year = now.getFullYear();

  // Heuristic: pick the interpretation that results in the closest future date
  const dateMD = new Date(year, first - 1, second);
  const dateDM = new Date(year, second - 1, first);
  const isValid = (d: Date) => !isNaN(d.getTime());

  let resetsAt: Date | undefined;

  if (first > 12) {
    resetsAt = dateDM; // Must be DD/MM
  } else if (second > 12) {
    resetsAt = dateMD; // Must be MM/DD
  } else if (isValid(dateMD) && isValid(dateDM)) {
    // Ambiguous. Pick the one that is in the future.
    const diffMD = dateMD.getTime() - now.getTime();
    const diffDM = dateDM.getTime() - now.getTime();

    if (diffMD > 0 && diffDM > 0) {
      resetsAt = diffMD < diffDM ? dateMD : dateDM;
    } else if (diffMD > 0) {
      resetsAt = dateMD;
    } else if (diffDM > 0) {
      resetsAt = dateDM;
    } else {
      // Both in past, pick interpretation closer to now (likely current month)
      resetsAt = diffMD > diffDM ? dateMD : dateDM;
    }
  }

  if (resetsAt && isValid(resetsAt)) {
    // If date is too far in the past, assume it's next year.
    // We use a 7-day threshold to avoid jumping years for stale CLI output
    if (resetsAt.getTime() < now.getTime() - 7 * 24 * 60 * 60 * 1000) {
      resetsAt.setFullYear(year + 1);
    }
  }
  return resetsAt;
}

/**
 * Parses Kiro CLI output to extract multiple quota windows.
 */
function parseKiroWindows(output: string): RateWindow[] {
  const windows: RateWindow[] = [];
  const lines = output.split("\n");

  const pctRegex =
    /(.*?)(?:Progress|Usage|Credits|Quota|Remaining):?\s*(?:█+|[#=]+|\s+)?(\d+)%/i;
  const ratioRegex =
    /(.*?)(?:Progress|Usage|Credits|Quota|Remaining):?\s*\(?(\d+\.?\d*)\s*(?:\/|of)\s*(\d+\.?\d*)\)?/i;
  const resetRegex = /resets\s+on\s+\b(\d{1,2}\/\d{1,2})\b/i;

  const ignoreLabels = [
    "system health",
    "disk usage",
    "cpu",
    "memory",
    "bandwidth",
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(pctRegex) || line.match(ratioRegex);
    if (match) {
      const keywordMatch = line.match(
        /(Progress|Usage|Credits|Quota|Remaining)/i,
      );
      const keyword = keywordMatch ? keywordMatch[1] : "";
      let label = match[1]
        .trim()
        .replace(/^\||\|$/g, "")
        .trim();

      if (!label || label === "-") {
        label = keyword || "Credits";
      } else if (
        keyword &&
        !label.toLowerCase().includes(keyword.toLowerCase())
      ) {
        label = `${label} ${keyword}`.trim();
      }

      if (ignoreLabels.some((l) => label.toLowerCase().includes(l))) continue;

      let usedPercent: number;
      const isPct = !!line.match(pctRegex);

      if (isPct) {
        const val = parseInt(match[2], 10);
        const keyword = keywordMatch ? keywordMatch[1].toLowerCase() : "";
        usedPercent =
          keyword === "remaining" || keyword === "credits" ? 100 - val : val;
      } else {
        const val1 = parseFloat(match[2]);
        const total = parseFloat(match[3]);
        const keywordMatch = line.match(
          /(Progress|Usage|Credits|Quota|Remaining)/i,
        );
        const keyword = keywordMatch ? keywordMatch[1].toLowerCase() : "";
        usedPercent =
          total > 0
            ? keyword === "remaining" || keyword === "credits"
              ? ((total - val1) / total) * 100
              : (val1 / total) * 100
            : 0;
      }

      // Check this line and next line for reset date
      let resetsAt: Date | undefined;
      let resetMatch = line.match(resetRegex);
      if (!resetMatch && i + 1 < lines.length) {
        resetMatch = lines[i + 1].match(resetRegex);
      }

      if (resetMatch) {
        resetsAt = parseSingleKiroResetDate(resetMatch[1]);
      }

      windows.push({
        label,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt,
        resetDescription: resetsAt ? formatReset(resetsAt) : undefined,
      });
    }
  }

  // Deduplicate windows by label (take the one with higher usedPercent if same label)
  const deduped: Record<string, RateWindow> = {};
  for (const w of windows) {
    if (!deduped[w.label] || w.usedPercent > deduped[w.label].usedPercent) {
      deduped[w.label] = w;
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
    if (planMatch) {
      planName = planMatch[1].trim();
    }

    const windows = parseKiroWindows(stripped);

    const bonusMatch = stripped.match(
      /(Remaining\s+)?Bonus\s*credits:?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
    );
    if (bonusMatch) {
      const expiryMatch = stripped.match(/expires\s+in\s+(\d+)\s+days?/i),
        existingBonusWindow = windows.find((w) => /\bbonus\b/i.test(w.label));

      const isRemainingBonus = !!bonusMatch[1];
      const bonusVal1 = parseFloat(bonusMatch[2]);
      const bonusTotal = parseFloat(bonusMatch[3]);
      const bonusPercent =
        bonusTotal > 0
          ? Math.min(
              100,
              Math.max(
                0,
                (isRemainingBonus
                  ? (bonusTotal - bonusVal1) / bonusTotal
                  : bonusVal1 / bonusTotal) * 100,
              ),
            )
          : 0;

      if (existingBonusWindow) {
        existingBonusWindow.label = "Bonus";
        existingBonusWindow.usedPercent = bonusPercent;
        if (expiryMatch) {
          existingBonusWindow.resetDescription = `${expiryMatch[1]}d left`;
        }
      } else {
        windows.push({
          label: "Bonus",
          usedPercent: bonusPercent,
          resetDescription: expiryMatch ? `${expiryMatch[1]}d left` : undefined,
        });
      }
    }

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
