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

- **5-hour Window**: Labeled as `5h`.
- **7-day Window**: Labeled as `Week`.
- **7-day Sonnet Window**: Labeled as `Sonnet`.
- **7-day Opus Window**: Labeled as `Opus`.

## Logic Details

- **Global Utilization**: The extension calculates a "global utilization" by taking the maximum of the `five_hour` and `seven_day` utilization.
- **Pessimistic Windows**: For model-specific windows (Sonnet/Opus), the extension uses a pessimistic approach, setting the utilization to the maximum of the model-specific value and the global utilization.
- **Resets**: It tracks the `resets_at` timestamp to determine when the quota will refresh.
