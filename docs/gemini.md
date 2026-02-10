# Google Gemini Usage

## Overview

The Gemini provider fetches usage information for Google Gemini models via the Google Cloud Service Usage API.

## Authentication

Credentials can be provided via:

1. **`auth.json`**: `google-gemini-cli` entry containing `access`, `projectId`, and optionally `refresh` and `clientId`.
2. **`~/.gemini/oauth_creds.json`**: A local file containing OAuth2 credentials.

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

- **Token Refresh**: If an `access_token` is expired, the extension attempts to refresh it using the `refresh_token` and `clientId`.
- **Minimum Remaining**: For each model family (Pro, Flash, etc.), the extension takes the most pessimistic value (lowest `remainingFraction`) to represent the usage of that family.
- **Utilization**: Calculated as `(1 - remainingFraction) * 100`.
