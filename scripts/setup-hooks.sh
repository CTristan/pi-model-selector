#!/bin/bash

# Get git directory
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "Not a git repository, skipping hook installation."
  exit 0
fi

HOOK_PATH="$GIT_DIR/hooks/pre-commit"

echo "Setting up pre-commit hook at $HOOK_PATH..."

# Check for existing hook
if [ -f "$HOOK_PATH" ] && [ -s "$HOOK_PATH" ]; then
  if ! grep -q "pi-model-selector pre-commit" "$HOOK_PATH"; then
    echo "An existing pre-commit hook was found at $HOOK_PATH."
    echo "Please integrate the CI gate manually into your existing hook."
    exit 0
  fi
fi

# Ensure directory exists
mkdir -p "$(dirname "$HOOK_PATH")"

# Write hook content
cat > "$HOOK_PATH" << 'EOF'
#!/bin/bash

# pi-model-selector pre-commit #

if [ "$CI" = "true" ]; then
  exit 0
fi

echo "Running pre-commit CI gate..."

npm run ci -- --check
if [ $? -ne 0 ]; then
  echo "CI gate failed. Commit aborted."
  exit 1
fi

exit 0
EOF

# Make it executable
chmod +x "$HOOK_PATH"

echo "Pre-commit hook installed successfully at $HOOK_PATH"
