# Anthropic (Claude) Usage

## Overview

The Anthropic provider fetches usage information for Claude models. It primarily relies on OAuth-based authentication and tracks both short-term and long-term usage windows.

## Authentication

The extension discovers credentials in the following order:

1. **`auth.json`**: Looks for `piAuth.anthropic.access`.
2. **macOS Keychain**: Attempts to find "Claude Code-credentials" and extract the `accessToken` (requires `user:profile` scope).

## API Endpoint

- **Usage**: `https://api.anthropic.com/api/oauth/usage`
- **Header**: `anthropic-beta: oauth-2025-04-20`

## Usage Windows

The provider tracks several utilization metrics:

- **5-hour Window**: Labeled as `5h` (raw utilization).
- **7-day Window**: Labeled as `Week` (raw utilization).
- **7-day Sonnet Window**: Labeled as `Sonnet` (pessimistic).
- **7-day Opus Window**: Labeled as `Opus` (pessimistic).
- **Shared Window**: Labeled as `Shared` (pessimistic). Only present if `Sonnet` and `Opus` are missing.

## Logic Details

- **Global Utilization**: The extension calculates a "global utilization" by taking the maximum of the `five_hour` and `seven_day` utilization.
- **Raw Windows**: The `5h` and `Week` windows always reflect their true raw utilization and reset times to provide accurate information to the user.
- **Pessimistic Windows**: For model-specific windows (`Sonnet`, `Opus`) and the `Shared` fallback window, the extension uses a pessimistic approach. It sets the utilization to the maximum of the specific window's value and the global utilization. This ensures that whichever limit is stricter (short-term or long-term) is reflected in the window the selector likely uses.
- **Resets**: It tracks the `resets_at` timestamp to determine when the quota will refresh. For pessimistic windows, the reset time is also set to the maximum (latest) between the specific window and the limiting global window.
