# Kiro Usage

## Overview

The Kiro provider retrieves usage information by interacting with the `kiro-cli`. Unlike most other providers, it parses command-line output rather than making direct HTTP requests.

## Authentication

Depends on the user being logged into the `kiro-cli`. It checks for the binary and verifies login status via `kiro-cli whoami`.

## Command

- **Usage Command**: `kiro-cli chat --no-interactive /usage`

## Usage Windows

Windows are dynamically parsed from the CLI output. Common labels include:

- **Credits**
- **Quota**
- **Bonus**: Special handling for bonus credits, including expiration info.

## Logic Details

- **CLI Parsing**: Uses regex to extract percentages (e.g., `80%`) or ratios (e.g., `15/20`) from the text output.
- **Reset Heuristics**: Since the CLI often provides dates without years (e.g., `12/31`), the provider implements heuristics to determine if the date refers to the current or next year based on the current date.
- **Ignore List**: Automatically filters out non-model usage metrics like `system health`, `cpu`, or `memory`.
