import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before importing the module under test
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      access: vi.fn(),
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue("/mock/home"),
  };
});

// Mock child_process to control sqlite3 output
vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execMock = vi.fn((_cmd: string, options: unknown, cb: unknown) => {
    const callback = typeof options === "function" ? options : cb;
    if (typeof callback === "function") {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
    }
    return {} as ReturnType<typeof import("node:child_process").exec>;
  });

  const execFileMock = vi.fn((...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as (
      err: null,
      stdout: string,
      stderr: string,
    ) => void;
    if (callback) {
      callback(null, "", "");
    }
    return {} as ReturnType<typeof import("node:child_process").execFile>;
  });

  Object.defineProperty(execMock, util.promisify.custom, {
    value: (cmd: string, options: unknown) => {
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

  Object.defineProperty(execFileMock, util.promisify.custom, {
    value: (file: string, args: unknown, options: unknown) => {
      return new Promise((resolve, reject) => {
        execFileMock(
          file,
          args,
          options,
          (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          },
        );
      });
    },
  });

  return { exec: execMock, execFile: execFileMock };
});

describe("loadPiAuth OMP SQLite fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.promises.readFile).mockRejectedValue(
      new Error("ENOENT: no such file"),
    );
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns parsed JSON when auth.json file exists (Pi path)", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".pi",
      isOmp: false,
    }));

    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({ anthropic: { access: "token-123" } }),
    );

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();
    expect(result).toEqual({ anthropic: { access: "token-123" } });
  });

  it("returns empty object when auth.json missing and not OMP", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".pi",
      isOmp: false,
    }));

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();
    expect(result).toEqual({});
  });

  it("tries SQLite when auth.json is missing and isOmp=true, returns parsed rows", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".omp",
      isOmp: true,
    }));

    const child_process = await import("node:child_process");
    vi.mocked(child_process.execFile).mockImplementation(
      (_file: string, args: unknown, opts: unknown, cb: unknown) => {
        const callback =
          typeof opts === "function"
            ? opts
            : typeof args === "function"
              ? args
              : cb;
        if (typeof callback === "function") {
          (callback as (err: null, stdout: string, stderr: string) => void)(
            null,
            JSON.stringify([
              {
                provider: "anthropic",
                data: JSON.stringify({ access: "tok-anthropic" }),
              },
              { provider: "zai", data: JSON.stringify({ key: "zai-key-123" }) },
            ]),
            "",
          );
        }
        return {} as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();
    expect(result).toEqual({
      anthropic: { access: "tok-anthropic" },
      zai: { key: "zai-key-123" },
    });
  });

  it("skips malformed JSON rows in SQLite results", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".omp",
      isOmp: true,
    }));

    const child_process = await import("node:child_process");
    vi.mocked(child_process.execFile).mockImplementation(
      (_file: string, args: unknown, opts: unknown, cb: unknown) => {
        const callback =
          typeof opts === "function"
            ? opts
            : typeof args === "function"
              ? args
              : cb;
        if (typeof callback === "function") {
          (callback as (err: null, stdout: string, stderr: string) => void)(
            null,
            JSON.stringify([
              {
                provider: "valid",
                data: JSON.stringify({ access: "good-token" }),
              },
              { provider: "malformed", data: "{{not json}}" },
            ]),
            "",
          );
        }
        return {} as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();
    expect(result).toEqual({ valid: { access: "good-token" } });
    expect(result.malformed).toBeUndefined();
  });

  it("returns empty object when sqlite3 CLI fails and isOmp=true", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".omp",
      isOmp: true,
    }));

    const child_process = await import("node:child_process");
    vi.mocked(child_process.execFile).mockImplementation(
      (_file: string, args: unknown, opts: unknown, cb: unknown) => {
        const callback =
          typeof opts === "function"
            ? opts
            : typeof args === "function"
              ? args
              : cb;
        if (typeof callback === "function") {
          (callback as (err: Error, stdout: string, stderr: string) => void)(
            new Error("sqlite3: command not found"),
            "",
            "",
          );
        }
        return {} as ReturnType<typeof import("node:child_process").execFile>;
      },
    );

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();
    expect(result).toEqual({});
  });

  it("uses EXTENSION_DIR path for the auth.json file", async () => {
    vi.doMock("../src/adapter.js", () => ({
      EXTENSION_DIR: ".omp",
      isOmp: true,
    }));

    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
      JSON.stringify({ "omp-provider": { access: "omp-token" } }),
    );

    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const result = await loadPiAuth();

    // Should have found the auth via the file path
    expect(result).toEqual({ "omp-provider": { access: "omp-token" } });
    const readFileCalls = vi.mocked(fs.promises.readFile).mock.calls;
    const calledPath = String(readFileCalls[0]?.[0] ?? "");
    expect(calledPath).toContain(".omp");
    expect(calledPath).toContain("auth.json");
  });
});
