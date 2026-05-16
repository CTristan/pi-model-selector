import { describe, expect, it } from "vitest";
import { convertOmpUsageReports } from "../src/usage-fetchers.js";

// Minimal OMP UsageReport shape (matches OmpUsageReport interface in usage-fetchers.ts)
interface OmpUsageReport {
  provider: string;
  fetchedAt: number;
  limits: OmpUsageLimit[];
  metadata?: Record<string, unknown>;
}

interface OmpUsageLimit {
  id: string;
  label: string;
  scope?: {
    provider?: string;
    accountId?: string;
    tier?: string;
    windowId?: string;
    modelId?: string;
    shared?: boolean;
  };
  window?: {
    id?: string;
    label?: string;
    durationMs?: number;
    resetsAt?: number;
  };
  amount: {
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit?: string;
  };
  notes?: string[];
}

describe("convertOmpUsageReports", () => {
  it("converts a basic Anthropic report", () => {
    const now = Date.now();
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: now,
        limits: [
          {
            id: "anthropic:5h",
            label: "Claude 5 Hour",
            scope: { provider: "anthropic", windowId: "5h", shared: true },
            window: {
              id: "5h",
              label: "5 Hour",
              durationMs: 5 * 60 * 60 * 1000,
              resetsAt: now + 3 * 60 * 60 * 1000, // 3h from now
            },
            amount: {
              used: 40,
              limit: 100,
              remaining: 60,
              usedFraction: 0.4,
              remainingFraction: 0.6,
              unit: "percent",
            },
          },
          {
            id: "anthropic:7d:sonnet",
            label: "Claude 7 Day (Sonnet)",
            scope: {
              provider: "anthropic",
              windowId: "7d",
              tier: "sonnet",
            },
            window: {
              id: "7d",
              label: "7 Day",
              durationMs: 7 * 24 * 60 * 60 * 1000,
              resetsAt: now + 5 * 24 * 60 * 60 * 1000, // 5d from now
            },
            amount: {
              used: 75,
              limit: 100,
              remaining: 25,
              usedFraction: 0.75,
              remainingFraction: 0.25,
              unit: "percent",
            },
          },
        ],
        metadata: {
          email: "user@example.com",
          accountId: "acc-123",
        },
      },
    ];

    const snapshots = convertOmpUsageReports(reports);

    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0]!;
    expect(snap.provider).toBe("anthropic");
    expect(snap.displayName).toBe("Claude");
    expect(snap.account).toBe("user@example.com");
    expect(snap.windows).toHaveLength(2);

    expect(snap.windows[0]!.label).toBe("Claude 5 Hour");
    expect(snap.windows[0]!.usedPercent).toBe(40);
    expect(snap.windows[0]!.resetsAt).toBeInstanceOf(Date);
    expect(snap.windows[0]!.resetDescription).toBeTruthy();

    expect(snap.windows[1]!.label).toBe("Claude 7 Day (Sonnet)");
    expect(snap.windows[1]!.usedPercent).toBe(75);
  });

  it("normalizes OMP provider names to extension names", () => {
    const now = Date.now();
    const reports: OmpUsageReport[] = [
      {
        provider: "github-copilot",
        fetchedAt: now,
        limits: [
          {
            id: "copilot:chat",
            label: "Copilot Chat",
            amount: { usedFraction: 0.3, unit: "percent" },
          },
        ],
      },
      {
        provider: "openai-codex",
        fetchedAt: now,
        limits: [
          {
            id: "openai-codex:1w",
            label: "Codex 1w",
            amount: { usedFraction: 0.5, unit: "percent" },
          },
        ],
      },
      {
        provider: "google-gemini-cli",
        fetchedAt: now,
        limits: [
          {
            id: "gemini:flash",
            label: "Gemini Flash",
            amount: { usedFraction: 0.2, unit: "percent" },
          },
        ],
      },
      {
        provider: "google-antigravity",
        fetchedAt: now,
        limits: [
          {
            id: "ag:claude",
            label: "Antigravity Claude",
            amount: { usedFraction: 0.1, unit: "percent" },
          },
        ],
      },
      {
        provider: "minimax-code",
        fetchedAt: now,
        limits: [
          {
            id: "minimax:default",
            label: "Minimax",
            amount: { usedFraction: 0.15, unit: "percent" },
          },
        ],
      },
      {
        provider: "zai",
        fetchedAt: now,
        limits: [
          {
            id: "zai:requests",
            label: "z.ai Requests",
            amount: { usedFraction: 0.6, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);

    const providers = snapshots.map((s) => s.provider);
    expect(providers).toContain("copilot");
    expect(providers).toContain("codex");
    expect(providers).toContain("gemini");
    expect(providers).toContain("antigravity");
    expect(providers).toContain("minimax");
    expect(providers).toContain("zai");

    // Display names should match extension conventions
    expect(snapshots.find((s) => s.provider === "copilot")!.displayName).toBe(
      "Copilot",
    );
    expect(snapshots.find((s) => s.provider === "codex")!.displayName).toBe(
      "Codex",
    );
    expect(snapshots.find((s) => s.provider === "gemini")!.displayName).toBe(
      "Gemini",
    );
  });

  it("extracts account from scope.accountId when metadata lacks email", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:5h",
            label: "5h",
            scope: { accountId: "org-456" },
            amount: { usedFraction: 0.5, unit: "percent" },
          },
        ],
        metadata: { accountId: "org-456" },
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots[0]!.account).toBe("org-456");
  });

  it("groups multiple reports for the same provider+account", () => {
    const now = Date.now();
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: now,
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            amount: { usedFraction: 0.3, unit: "percent" },
          },
        ],
        metadata: { email: "user@example.com" },
      },
      {
        provider: "anthropic",
        fetchedAt: now,
        limits: [
          {
            id: "anthropic:7d",
            label: "7 Day",
            amount: { usedFraction: 0.6, unit: "percent" },
          },
        ],
        metadata: { email: "user@example.com" },
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    // Same provider + account should merge into one snapshot
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.windows).toHaveLength(2);
  });

  it("separates different accounts for the same provider", () => {
    const now = Date.now();
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: now,
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            amount: { usedFraction: 0.3, unit: "percent" },
          },
        ],
        metadata: { email: "work@corp.com" },
      },
      {
        provider: "anthropic",
        fetchedAt: now,
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            amount: { usedFraction: 0.8, unit: "percent" },
          },
        ],
        metadata: { email: "personal@gmail.com" },
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.account).sort()).toEqual([
      "personal@gmail.com",
      "work@corp.com",
    ]);
  });

  it("separates limits by scope account within one report", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:work",
            label: "Work",
            scope: { accountId: "work@corp.com" },
            amount: { usedFraction: 0.3, unit: "percent" },
          },
          {
            id: "anthropic:personal",
            label: "Personal",
            scope: { accountId: "personal@gmail.com" },
            amount: { usedFraction: 0.8, unit: "percent" },
          },
        ],
        metadata: { email: "metadata@example.com" },
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.account).sort()).toEqual([
      "personal@gmail.com",
      "work@corp.com",
    ]);
  });

  it("skips limits with no usable usage data", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:unknown",
            label: "Unknown",
            amount: { unit: "unknown" }, // No usedFraction, no used
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.windows).toHaveLength(0);
  });

  it("converts resetsAt epoch ms to Date and generates resetDescription", () => {
    const futureMs = Date.now() + 2 * 60 * 60 * 1000; // 2h from now
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            window: { id: "5h", label: "5 Hour", resetsAt: futureMs },
            amount: { usedFraction: 0.5, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    const win = snapshots[0]!.windows[0]!;
    expect(win.resetsAt).toBeInstanceOf(Date);
    expect(win.resetsAt!.getTime()).toBe(futureMs);
    expect(win.resetDescription).toMatch(/^(2h|1h 59m)$/);
  });

  it("handles limits without window (no reset time)", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "openai-codex",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "openai-codex:1w",
            label: "Codex Weekly",
            // No window property
            amount: { usedFraction: 0.4, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots[0]!.windows[0]!.resetsAt).toBeUndefined();
    expect(snapshots[0]!.windows[0]!.resetDescription).toBeUndefined();
  });

  it("derives usedPercent from used over limit when usedFraction is absent", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            amount: { used: 3, limit: 10, unit: "requests" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots[0]!.windows[0]!.usedPercent).toBe(30);
  });

  it("prefers usedFraction over used for usedPercent", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:5h",
            label: "5 Hour",
            amount: {
              used: 50,
              usedFraction: 0.8,
              unit: "percent",
            },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    // usedFraction * 100 = 80, preferred over used = 50
    expect(snapshots[0]!.windows[0]!.usedPercent).toBe(80);
  });

  it("clamps usedPercent to 0-100 range", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "anthropic",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "anthropic:overflow",
            label: "Overflow",
            amount: { usedFraction: 1.5, unit: "percent" },
          },
          {
            id: "anthropic:negative",
            label: "Negative",
            amount: { usedFraction: -0.3, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots[0]!.windows[0]!.usedPercent).toBe(100);
    expect(snapshots[0]!.windows[1]!.usedPercent).toBe(0);
  });

  it("returns empty array for empty reports", () => {
    expect(convertOmpUsageReports([])).toEqual([]);
  });

  it("handles unknown OMP providers by using provider name as-is", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "some-new-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "new:limit",
            label: "New Limit",
            amount: { usedFraction: 0.5, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.provider).toBe("some-new-provider");
    expect(snapshots[0]!.displayName).toBe("some-new-provider");
  });

  it("handles kimi-code provider mapping", () => {
    const reports: OmpUsageReport[] = [
      {
        provider: "kimi-code",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "kimi:default",
            label: "Kimi",
            amount: { usedFraction: 0.2, unit: "percent" },
          },
        ],
      },
    ];

    const snapshots = convertOmpUsageReports(reports);
    expect(snapshots[0]!.provider).toBe("kimi");
  });
});
