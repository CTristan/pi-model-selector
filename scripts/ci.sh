#!/bin/bash
set -e

echo "Running CI gate..."

# Use npm ci in CI environments for faster, more reliable installs
if [ "$CI" = "true" ]; then
  echo "CI environment detected. Running npm ci..."
  npm ci
else
  echo "Local environment detected. Running npm install..."
  npm install
fi

echo "Running type check..."
npm run type-check

echo "CI gate passed!"
