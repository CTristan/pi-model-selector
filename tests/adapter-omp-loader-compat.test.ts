import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("adapter OMP loader compatibility", () => {
  it("uses literal legacy Pi imports so OMP can rewrite them before mirroring", async () => {
    const source = await readFile(
      new URL("../src/adapter.ts", import.meta.url),
      "utf-8",
    );

    const executableSource = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    expect(executableSource).toMatch(
      /await\s+import\(\s*"@mariozechner\/pi-coding-agent"\s*\)/,
    );
    expect(executableSource).toMatch(
      /await\s+import\(\s*"@mariozechner\/pi-tui"\s*\)/,
    );
    expect(executableSource).not.toContain("@oh-my-pi/pi-coding-agent");
    expect(executableSource).not.toContain("@oh-my-pi/pi-tui");
  });
});
