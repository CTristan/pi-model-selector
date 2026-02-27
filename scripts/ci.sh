#!/bin/bash
set -e

echo "Running CI gate..."

# Check if we should only run checks or auto-fix
CHECK_ONLY=false
if [ "$1" = "--check" ] || [ "$CI" = "true" ]; then
  CHECK_ONLY=true
fi

# Use npm ci in CI environments for faster, more reliable installs
if [ "$CI" = "true" ]; then
  echo "CI environment detected. Running npm ci..."
  npm ci
elif [ ! -d "node_modules" ]; then
  echo "Local environment: node_modules not found. Running npm install..."
  npm install
else
  echo "Local environment: node_modules already exists. Skipping install."
fi

echo "Running type check..."
npm run type-check

if [ "$CHECK_ONLY" = "true" ]; then
  echo "Running linting and formatting (check only)..."
  npm run check
else
  echo "Running linting and formatting (auto-fixing)..."
  npm run fix
fi

echo "Running unit tests..."
# Timeout protects against import hangs (vitest testTimeout only applies to test execution)
# Tests normally complete in ~2-3 seconds; 60s allows generous headroom
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
else
  TIMEOUT_CMD=""
fi

if [ -n "$TIMEOUT_CMD" ]; then
  "$TIMEOUT_CMD" 60s npm run test
else
  npm run test
fi

echo "CI gate passed!"
