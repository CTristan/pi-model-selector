#!/bin/bash
set -e

echo "Running CI gate..."

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

echo "CI gate passed!"
