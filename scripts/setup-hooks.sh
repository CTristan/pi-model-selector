#!/bin/bash
set -e

HOOK_PATH=".git/hooks/pre-commit"

echo "Setting up pre-commit hook..."

# Ensure the .git directory exists
if [ ! -d ".git" ]; then
  echo "No .git directory found, skipping hook installation."
  exit 0
fi

# Create the pre-commit hook
if [ -f "$HOOK_PATH" ] && [ -s "$HOOK_PATH" ]; then
  echo "An existing pre-commit hook was found at $HOOK_PATH."
  echo "Please integrate the CI gate manually into your existing hook."
  echo "Aborting hook installation to avoid overwriting the existing hook."
  exit 0
fi

cat << 'EOF' > "$HOOK_PATH"
#!/bin/bash

echo "Running pre-commit CI gate..."

# Execute the CI script
./scripts/ci.sh

# Capture the exit code
RESULT=$?

if [ $RESULT -ne 0 ]; then
  echo "CI gate failed. Commit aborted."
  exit 1
fi

exit 0
EOF

# Make it executable
chmod +x "$HOOK_PATH"

# Ensure Git is configured to use the hooks directory without overriding an existing custom setting
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  current_hooks_path="$(git config --get core.hooksPath || true)"
  if [ -z "$current_hooks_path" ]; then
    git config core.hooksPath .git/hooks
  fi
fi

echo "Pre-commit hook installed successfully at $HOOK_PATH"
