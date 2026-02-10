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
  echo "Running linting (check only)..."
  npm run lint

  echo "Checking formatting (check only)..."
  npm run format:check
else
  echo "Running linting and auto-fixing..."
  npm run lint:fix

  echo "Formatting files..."
  npm run format:fix
fi

echo "Running unit tests..."
npm run test

echo "CI gate passed!"
