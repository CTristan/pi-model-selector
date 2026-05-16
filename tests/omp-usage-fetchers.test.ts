import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs and node:os so that common.ts doesn't fail on missing auth files
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      access: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
      readdir: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue("/mock/home"),
    platform: vi.fn().mockReturnValue("linux"),
  };
});

vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execMock = vi.fn(
    (_cmd: string, _options: unknown, cb: unknown) => {
      const callback = typeof _options === "function" ? _options : cb;
      if (typeof callback === "function") {
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          "",
          "",
        );
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    },
  );

  Object.defineProperty(execMock, util.promisify.custom, {
    value: (cmd: string, opts: unknown) => {
      return new Promise((resolve, reject) => {
        execMock(
          cmd,
          opts,
          (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          },
        );
      });
    },
  });

  return { exec: execMock };
});

// Helper to build a minimal OMP usage report
function makeOmpReport(
  provider: string,
  usedFraction: number,
  email?: string,
) {
  return {
    provider,
    fetchedAt: Date.now(),
    limits: [
      {
        id: `${provider}:test`,
        label: "Test Window",
        amount: { usedFraction, unit: "percent" },
      },
    ],
    metadata: email ? { email } : undefined,
  };
}

describe("fetchAllUsages — OMP path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("calls authStorage.fetchUsageReports and converts results when isOmp=true", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue([
      makeOmpReport("anthropic", 0.5, "user@example.com"),
      makeOmpReport("github-copilot", 0.3),
    ]);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };

    const result = await fetchAllUsages(modelRegistry);

    expect(fetchUsageReports).toHaveBeenCalledTimes(1);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Provider names should be normalized
    const providers = result.map((s) => s.provider);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("copilot");
  });

  it("filters disabled providers from OMP results", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue([
      makeOmpReport("anthropic", 0.5),
      makeOmpReport("github-copilot", 0.3),
      makeOmpReport("zai", 0.6),
    ]);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };

    const result = await fetchAllUsages(modelRegistry, ["copilot", "zai"]);

    const providers = result.map((s) => s.provider);
    expect(providers).toContain("anthropic");
    expect(providers).not.toContain("copilot");
    expect(providers).not.toContain("zai");
  });

  it("handles fetchUsageReports returning null by using fallback fetchers", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue(null);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };

    // Should not throw even if OMP returns null
    const result = await fetchAllUsages(modelRegistry);
    // kiro fallback will be attempted; result is an array
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles fetchUsageReports returning empty array", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue([]);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };

    const result = await fetchAllUsages(modelRegistry);
    expect(Array.isArray(result)).toBe(true);
    // kiro fallback may be in result
  });

  it("handles fetchUsageReports throwing by using fallback fetchers", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi
      .fn()
      .mockRejectedValue(new Error("usage API unavailable"));

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };

    const result = await fetchAllUsages(modelRegistry);
    expect(Array.isArray(result)).toBe(true);
  });

  it("falls back to Pi fetchers when isOmp=true but authStorage lacks fetchUsageReports", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    // authStorage exists but no fetchUsageReports
    const modelRegistry = { authStorage: {} };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "",
      }),
    );

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const result = await fetchAllUsages(modelRegistry);

    // Should have fallen back to the Pi fetchers path and returned snapshots
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("falls back to Pi fetchers when isOmp=true but no authStorage at all", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const modelRegistry = {}; // No authStorage

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "",
      }),
    );

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const result = await fetchAllUsages(modelRegistry);
    expect(Array.isArray(result)).toBe(true);

    vi.unstubAllGlobals();
  });

  it("uses Pi fetchers when isOmp=false (legacy path)", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: false,
      EXTENSION_DIR: ".pi",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue([]);
    const modelRegistry = { authStorage: { fetchUsageReports } };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "",
      }),
    );

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const result = await fetchAllUsages(modelRegistry);

    // Legacy path should NOT call fetchUsageReports
    expect(fetchUsageReports).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("fetchAllUsages — OMP kiro fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("adds kiro via fallback fetcher when OMP doesn't cover it", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    // OMP covers anthropic but not kiro
    const fetchUsageReports = vi.fn().mockResolvedValue([
      makeOmpReport("anthropic", 0.5),
    ]);

    const child_process = await import("node:child_process");
    vi.mocked(child_process.exec).mockImplementation(
      (cmd: string, _opts: unknown, cb: unknown) => {
        const callback = typeof _opts === "function" ? _opts : cb;
        if (typeof callback === "function") {
          const fn = callback as (
            err: null,
            stdout: string,
            stderr: string,
          ) => void;
          if (cmd.includes("which") || cmd.includes("kiro")) {
            fn(null, "/usr/bin/kiro", "");
          } else {
            fn(null, "", "");
          }
        }
        return {} as ReturnType<typeof import("node:child_process").exec>;
      },
    );

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };
    const result = await fetchAllUsages(modelRegistry);

    const providers = result.map((s) => s.provider);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("kiro");
  });

  it("skips kiro fallback when kiro is in disabled providers", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    const fetchUsageReports = vi.fn().mockResolvedValue([
      makeOmpReport("anthropic", 0.5),
    ]);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };
    const result = await fetchAllUsages(modelRegistry, ["kiro"]);

    const providers = result.map((s) => s.provider);
    expect(providers).not.toContain("kiro");
  });

  it("skips kiro fallback when OMP already covered kiro", async () => {
    vi.doMock("../src/adapter.js", () => ({
      isOmp: true,
      EXTENSION_DIR: ".omp",
    }));

    // OMP covers kiro (provider name is already "kiro" in snapshot)
    const fetchUsageReports = vi.fn().mockResolvedValue([
      makeOmpReport("kiro", 0.4),
    ]);

    const { fetchAllUsages } = await import("../src/usage-fetchers.js");
    const modelRegistry = { authStorage: { fetchUsageReports } };
    const result = await fetchAllUsages(modelRegistry);

    // kiro appears once (from OMP), not twice
    const kiroSnapshots = result.filter((s) => s.provider === "kiro");
    expect(kiroSnapshots).toHaveLength(1);
  });
});