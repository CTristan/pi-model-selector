# Anthropic (Claude) Usage

## Overview

The Anthropic provider fetches usage information for Claude models. It primarily relies on OAuth-based authentication and tracks both short-term and long-term usage windows.

## Authentication

The extension discovers credentials from multiple sources and retries on auth failures:

1. **Pi model registry (`authStorage`)**: Tries `anthropic` API key/data when available.
2. **`auth.json`**: Looks for `piAuth.anthropic.access`, `piAuth.anthropic.accessToken`, or `piAuth.anthropic.token`.
3. **macOS Keychain**: Attempts to find `Claude Code-credentials`.
   - Supports the Claude JSON payload format (`claudeAiOauth.accessToken` with `user:profile` scope).
   - Also supports plain token values for environments that store only the raw token.

If one credential returns `401/403`, the extension automatically tries the next discovered credential source before failing.

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

- **Global Utilization**: The extension calculates a "global utilization" by taking the maximum of the `five_hour`, `seven_day`, `seven_day_sonnet`, and `seven_day_opus` utilization.
- **Raw Windows**: The `5h` and `Week` windows always reflect their true raw utilization and reset times to provide accurate information to the user.
- **Pessimistic Windows**: For model-specific windows (`Sonnet`, `Opus`) and the `Shared` fallback window, the extension uses a pessimistic approach. It sets the utilization to the maximum of the specific window's value and the global utilization. This ensures that whichever limit is stricter (short-term or long-term) is reflected in the window the selector likely uses.
- **Resets**: It tracks the `resets_at` timestamp to determine when the quota will refresh. For pessimistic windows, the reset time is also set to the maximum (latest) between the specific window and the limiting global window.
- **Stale Token Handling**: When multiple Anthropic credentials are present, expired credentials are deprioritized (when an expiry hint is available) and `401/403` responses trigger automatic fallback to the next source.
