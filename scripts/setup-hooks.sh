#!/bin/bash
set -e

HOOK_PATH=".git/hooks/pre-commit"

echo "Setting up pre-commit hook..."

# Ensure the .git directory exists
if [ ! -d ".git" ]; then
  echo "Error: .git directory not found. Are you in the root of the repository?"
  exit 1
fi

# Create the pre-commit hook
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

# Ensure Git is configured to use the hooks directory
git config core.hooksPath .git/hooks

echo "Pre-commit hook installed successfully at $HOOK_PATH"
