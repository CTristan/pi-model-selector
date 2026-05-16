import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/adapter.js", () => ({
  EXTENSION_DIR: ".omp",
  isOmp: true,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockRejectedValue(new Error("missing auth.json")),
    },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp/user" && echo injected && "'),
  };
});

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const util = await import("node:util");
  const sqliteRows = JSON.stringify([
    { provider: "zai", data: JSON.stringify({ key: "secret" }) },
  ]);
  const execFileMock = vi.fn(
    (
      _file: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, sqliteRows, "");
    },
  );

  Object.defineProperty(execFileMock, util.promisify.custom, {
    value: (file: string, args: string[]) =>
      new Promise((resolve, reject) => {
        execFileMock(file, args, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });

  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("loadPiAuth SQLite fallback", () => {
  it("queries sqlite with execFile arguments instead of shell interpolation", async () => {
    vi.resetModules();
    const { loadPiAuth } = await import("../src/fetchers/common.js");
    const auth = await loadPiAuth();

    expect(execFile).toHaveBeenCalled();
    expect(auth).toEqual({ zai: { key: "secret" } });
    expect(fs.promises.readFile).toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      "sqlite3",
      [
        "-json",
        '/tmp/user" && echo injected && "/.omp/agent/agent.db',
        "SELECT provider, data FROM auth_credentials",
      ],
      expect.any(Function),
    );
  });
});
