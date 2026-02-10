# Google Gemini Usage

## Overview

The Gemini provider fetches usage information for Google Gemini models via the Google Cloud Service Usage API.

## Authentication

Credentials can be provided via multiple sources:

1. **Pi model registry (`authStorage`)**:
   - `google-gemini` API key/data
   - `google-gemini-cli` API key/data
2. **`auth.json`**:
   - `google-gemini-cli`
   - `google-gemini`
3. **`~/.gemini/oauth_creds.json`**: A local file containing OAuth2 credentials.

The extension merges discovered project IDs and credential fragments (access token, refresh token, client metadata) across sources and tries candidates per project until one succeeds.

## API Endpoint

- **Usage**: `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
- **Method**: `POST`
- **Body**: `{ "project": "PROJECT_ID" }`

## Usage Windows

Windows are dynamically determined based on the `modelId` returned by the API:

- **Pro**: Groups models with "pro" in their ID (e.g., `gemini-1.5-pro`).
- **Flash**: Groups models with "flash" in their ID (e.g., `gemini-1.5-flash`).
- **Other**: Default group for other model IDs.

## Logic Details

- **Token Refresh**:
  - If an access token is missing/expired, the extension proactively attempts refresh before quota fetch.
  - If a quota request returns `401/403`, it attempts refresh again and retries.
  - Refresh requests use `refresh_token`, optional `clientId`, and optional `clientSecret` when available.
- **Credential Failover**: For each project, multiple discovered credentials are tried sequentially; duplicate failed tokens are skipped.
- **Minimum Remaining**: For each model family (Pro, Flash, etc.), the extension takes the most pessimistic value (lowest `remainingFraction`) to represent the usage of that family.
- **Utilization**: Calculated as `(1 - remainingFraction) * 100`.
