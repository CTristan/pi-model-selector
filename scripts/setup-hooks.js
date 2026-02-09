import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const HOOK_PATH = path.join(".git", "hooks", "pre-commit");

console.log("Setting up pre-commit hook...");

// Ensure the .git directory exists
if (!fs.existsSync(".git")) {
  console.log("No .git directory found, skipping hook installation.");
  process.exit(0);
}

// Create the pre-commit hook
if (fs.existsSync(HOOK_PATH) && fs.statSync(HOOK_PATH).size > 0) {
  console.log(`An existing pre-commit hook was found at ${HOOK_PATH}.`);
  console.log("Please integrate the CI gate manually into your existing hook.");
  console.log(
    "Aborting hook installation to avoid overwriting the existing hook.",
  );
  process.exit(0);
}

// Ensure directory exists (though .git/hooks usually exists)
const hookDir = path.dirname(HOOK_PATH);
if (!fs.existsSync(hookDir)) {
  fs.mkdirSync(hookDir, { recursive: true });
}

const hookContent = `#!/bin/bash

echo "Running pre-commit CI gate..."

# Execute the CI script in check-only mode
# Use direct path or relative path, assuming run from root
./scripts/ci.sh --check

# Capture the exit code
RESULT=$?

if [ $RESULT -ne 0 ]; then
  echo "CI gate failed. Commit aborted."
  exit 1
fi

exit 0
`;

fs.writeFileSync(HOOK_PATH, hookContent);

// Make it executable
try {
  fs.chmodSync(HOOK_PATH, "755");
} catch {
  // Ignored on Windows usually, but good to try
}

// Ensure Git is configured to use the hooks directory
try {
  const isInsideWorkTree = execSync("git rev-parse --is-inside-work-tree", {
    encoding: "utf8",
  }).trim();
  if (isInsideWorkTree === "true") {
    let currentHooksPath = "";
    try {
      currentHooksPath = execSync("git config --get core.hooksPath", {
        encoding: "utf8",
      }).trim();
    } catch {
      // Ignore if not set
    }

    if (!currentHooksPath) {
      execSync("git config core.hooksPath .git/hooks");
    }
  }
} catch (err) {
  console.warn("Failed to configure git hooks path:", err.message);
}

console.log(`Pre-commit hook installed successfully at ${HOOK_PATH}`);
