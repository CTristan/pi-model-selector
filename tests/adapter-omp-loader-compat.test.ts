import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function readRuntimeSources(): Promise<
  Array<{ path: string; source: string }>
> {
  const files = ["index.ts"];

  async function collectSourceFiles(dir: string): Promise<void> {
    const entries = await readdir(join(repoRoot, dir), { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectSourceFiles(path);
      } else if (entry.isFile() && path.endsWith(".ts")) {
        files.push(path);
      }
    }
  }

  await collectSourceFiles("src");

  return await Promise.all(
    files.map(async (path) => ({
      path,
      source: await readFile(join(repoRoot, path), "utf-8"),
    })),
  );
}
describe("adapter OMP loader compatibility", () => {
  it("uses literal current Pi imports that OMP rewrites to host modules", async () => {
    const source = await readFile(
      new URL("../src/adapter.ts", import.meta.url),
      "utf-8",
    );

    const executableSource = stripComments(source);

    expect(executableSource).toMatch(
      /await\s+import\(\s*"@earendil-works\/pi-coding-agent"\s*\)/,
    );
    expect(executableSource).toMatch(
      /await\s+import\(\s*"@earendil-works\/pi-tui"\s*\)/,
    );
    expect(executableSource).not.toContain("@oh-my-pi/pi-coding-agent");
    expect(executableSource).not.toContain("@oh-my-pi/pi-tui");
    expect(executableSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(executableSource).not.toContain("@mariozechner/pi-tui");
    // Module evaluation must detect OMP without dereferencing its settings
    // proxy, which throws until the compatibility settings graph is initialized.
    expect(executableSource).toContain('"settings" in agent');
    expect(executableSource).not.toMatch(/=\s*agent\.settings\b/);
  });

  it("does not use relative dynamic imports in runtime sources", async () => {
    const dynamicRelativeImport = /\bimport\s*\(\s*["']\.{1,2}\//;
    const offenders = (await readRuntimeSources())
      .filter(({ source }) => dynamicRelativeImport.test(stripComments(source)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
