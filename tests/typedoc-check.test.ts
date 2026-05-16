import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../scripts/typedoc-check.cjs",
);

function writeTempCoverageFile(
  content: Record<string, unknown> | string,
  dir: string,
): string {
  const filePath = path.join(dir, "coverage.json");
  fs.writeFileSync(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
  return filePath;
}

function runScript(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("typedoc-check.cjs", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits with code 1 when the coverage file does not exist", () => {
    const result = runScript(["/nonexistent/path/coverage.json", "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Coverage file not found");
  });

  it("exits with code 1 when threshold is not finite", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: 100, actual: 10, expected: 10 },
      tmpDir,
    );
    const result = runScript([file, "not-a-number"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid threshold");
  });

  it("exits with code 1 when coverage JSON is malformed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile("not json", tmpDir);
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Malformed coverage JSON");
  });

  it("exits with code 1 when percent is not a finite number", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: "not-a-number", actual: 0, expected: 10 },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid TypeDoc coverage percent");
  });

  it("exits with code 1 when coverage is below threshold", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: 75, actual: 75, expected: 100 },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("below the required");
    expect(result.stderr).toContain("75%");
    expect(result.stderr).toContain("80%");
  });

  it("exits with code 1 and lists missing items when notDocumented is an array", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      {
        percent: 60,
        actual: 6,
        expected: 10,
        notDocumented: ["MyClass.foo", "MyClass.bar"],
      },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MyClass.foo");
    expect(result.stderr).toContain("MyClass.bar");
  });

  it("exits with code 0 when coverage meets the threshold exactly", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: 80, actual: 80, expected: 100 },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("80%");
    expect(result.stdout).toContain("80/100");
  });

  it("exits with code 0 when coverage exceeds the threshold", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: 95, actual: 95, expected: 100 },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(0);
  });

  it("handles null percent as invalid", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: null, actual: 0, expected: 10 },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid TypeDoc coverage percent");
  });

  it("does not mention Missing documentation when notDocumented is not an array", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typedoc-check-test-"));
    const file = writeTempCoverageFile(
      { percent: 50, actual: 5, expected: 10, notDocumented: "not an array" },
      tmpDir,
    );
    const result = runScript([file, "80"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Missing documentation:");
  });
});
