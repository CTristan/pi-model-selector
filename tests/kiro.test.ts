/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from "vitest";
import { fetchKiroUsage } from "../src/fetchers/kiro.js";
import { execAsync } from "../src/fetchers/common.js";

vi.mock("../src/fetchers/common.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/fetchers/common.js")
  >("../src/fetchers/common.js");
  return {
    ...actual,
    execAsync: vi.fn(),
  };
});

describe("Kiro Quota Detection", () => {
  it("should detect both percentage and ratio quotas and return multiple windows", async () => {
    vi.mocked(execAsync).mockImplementation(((cmd: string) => {
      if (cmd.includes("which") || cmd.includes("where"))
        return Promise.resolve({ stdout: "/bin/kiro-cli", stderr: "" });
      if (cmd.includes("whoami"))
        return Promise.resolve({ stdout: "user", stderr: "" });
      if (cmd.includes("/usage")) {
        return Promise.resolve({
          stdout: `
| KIRO PRO |
System Health: 100%
Model A Quota: 50/100
Model B Usage: 75%
resets on 10/11
Bonus credits: 2/10
resets on 12/11
`,
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
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
    vi.mocked(execAsync).mockImplementation(((cmd: string) => {
      if (cmd.includes("which") || cmd.includes("where"))
        return Promise.resolve({ stdout: "/bin/kiro-cli", stderr: "" });
      if (cmd.includes("whoami"))
        return Promise.resolve({ stdout: "user", stderr: "" });
      if (cmd.includes("/usage")) {
        return Promise.resolve({
          stdout: `
Model 1 Quota: 90%
resets on 02/10
Model 2 Quota: 10%
resets on 05/10
`,
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
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
    vi.mocked(execAsync).mockImplementation(((cmd: string) => {
      if (cmd.includes("which") || cmd.includes("where"))
        return Promise.resolve({ stdout: "/bin/kiro-cli", stderr: "" });
      if (cmd.includes("whoami"))
        return Promise.resolve({ stdout: "user", stderr: "" });
      if (cmd.includes("/usage")) {
        return Promise.resolve({
          stdout: `
Bonus credits: 2/10
expires in 3 days
`,
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    }) as any);

    const result = await fetchKiroUsage();
    const bonusWindows = result.windows.filter((w) => /bonus/i.test(w.label));

    expect(bonusWindows).toHaveLength(1);
    expect(bonusWindows[0].resetDescription).toBe("3d left");
  });
});
