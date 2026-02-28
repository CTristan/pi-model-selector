import * as child_process from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchKiroUsage } from "../src/fetchers/kiro.js";

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execMock = vi.fn(
    (
      _cmd: string,
      options: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (typeof options === "function")
        cb = options as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
      if (cb) cb(null, "{}", "");
    },
  );

  Object.defineProperty(execMock, util.promisify.custom, {
    value: (cmd: string, options: any) => {
      return new Promise((resolve, reject) => {
        execMock(
          cmd,
          options,
          (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          },
        );
      });
    },
  });

  return {
    exec: execMock,
  };
});

describe("Kiro Quota Detection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should detect both percentage and ratio quotas and return multiple windows", async () => {
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      options: any,
      cb: any,
    ) => {
      if (typeof options === "function") cb = options;
      if (cmd.includes("which") || cmd.includes("where"))
        cb(null, "/bin/kiro-cli", "");
      else if (cmd.includes("whoami")) cb(null, "user", "");
      else if (cmd.includes("/usage")) {
        cb(
          null,
          `
| KIRO PRO |
System Health: 100%
Model A Quota: 50/100
Model B Usage: 75%
resets on 10/11
Bonus credits: 2/10
resets on 12/11
`,
          "",
        );
      } else {
        cb(null, "", "");
      }
    }) as any);

    const result = await fetchKiroUsage();

    const labels = result.windows.map((w) => w.label);
    expect(labels).toContain("Model A Quota");
    expect(labels).toContain("Model B Usage");
    expect(
      result.windows.find((w) => w.label === "Model B Usage")?.usedPercent,
    ).toBe(75);
    expect(
      result.windows.find((w) => w.label === "Model A Quota")?.usedPercent,
    ).toBe(50);
  });

  it("should correctly handle multi-quota reset dates", async () => {
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      options: any,
      cb: any,
    ) => {
      if (typeof options === "function") cb = options;
      if (cmd.includes("which") || cmd.includes("where"))
        cb(null, "/bin/kiro-cli", "");
      else if (cmd.includes("whoami")) cb(null, "user", "");
      else if (cmd.includes("/usage")) {
        cb(
          null,
          `
Model 1 Quota: 90%
resets on 02/10
Model 2 Quota: 10%
resets on 05/10
`,
          "",
        );
      } else {
        cb(null, "", "");
      }
    }) as any);

    const result = await fetchKiroUsage();
    const m1 = result.windows.find((w) => w.label === "Model 1 Quota");
    const m2 = result.windows.find((w) => w.label === "Model 2 Quota");

    expect(m1?.resetsAt?.getMonth()).toBe(1); // Feb
    expect(m1?.resetsAt?.getDate()).toBe(10);
    expect(m2?.resetsAt?.getMonth()).toBe(4); // May
    expect(m2?.resetsAt?.getDate()).toBe(10);
  });

  it("should not duplicate bonus windows when bonus credits are already parsed", async () => {
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      options: any,
      cb: any,
    ) => {
      if (typeof options === "function") cb = options;
      if (cmd.includes("which") || cmd.includes("where"))
        cb(null, "/bin/kiro-cli", "");
      else if (cmd.includes("whoami")) cb(null, "user", "");
      else if (cmd.includes("/usage")) {
        cb(
          null,
          `
Bonus credits: 2/10
expires in 3 days
`,
          "",
        );
      } else {
        cb(null, "", "");
      }
    }) as any);

    const result = await fetchKiroUsage();
    const bonusWindows = result.windows.filter((w) => /bonus/i.test(w.label));

    expect(bonusWindows).toHaveLength(1);
    expect(bonusWindows[0]!.resetDescription).toBe("3d left");
  });

  it("should merge reset info from later duplicate with same label", async () => {
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      options: any,
      cb: any,
    ) => {
      if (typeof options === "function") cb = options;
      if (cmd.includes("which") || cmd.includes("where"))
        cb(null, "/bin/kiro-cli", "");
      else if (cmd.includes("whoami")) cb(null, "user", "");
      else if (cmd.includes("/usage")) {
        cb(
          null,
          `
Model A Quota: 50%
Model A Quota: 50%
resets on 02/10
`,
          "",
        );
      } else {
        cb(null, "", "");
      }
    }) as any);

    const result = await fetchKiroUsage();
    const modelA = result.windows.find((w) => w.label === "Model A Quota");

    expect(modelA).toBeDefined();
    expect(modelA?.usedPercent).toBe(50);
    expect(modelA?.resetsAt?.getMonth()).toBe(1); // Feb
    expect(modelA?.resetsAt?.getDate()).toBe(10);
  });

  it("should merge reset info from later duplicate when first has higher usage", async () => {
    vi.mocked(child_process.exec).mockImplementation(((
      cmd: string,
      options: any,
      cb: any,
    ) => {
      if (typeof options === "function") cb = options;
      if (cmd.includes("which") || cmd.includes("where"))
        cb(null, "/bin/kiro-cli", "");
      else if (cmd.includes("whoami")) cb(null, "user", "");
      else if (cmd.includes("/usage")) {
        cb(
          null,
          `
Model B Usage: 75%
Model B Usage: 50%
resets on 03/10
`,
          "",
        );
      } else {
        cb(null, "", "");
      }
    }) as any);

    const result = await fetchKiroUsage();
    const modelB = result.windows.find((w) => w.label === "Model B Usage");

    expect(modelB).toBeDefined();
    // First window with 75% should be kept (higher usage)
    expect(modelB?.usedPercent).toBe(75);
    // But reset info from second window should be merged
    expect(modelB?.resetsAt?.getMonth()).toBe(2); // Mar
    expect(modelB?.resetsAt?.getDate()).toBe(10);
  });
});
