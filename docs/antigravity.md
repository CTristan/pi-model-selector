# Antigravity Usage

## Overview

The Antigravity provider fetches usage information for internal Google Antigravity models. It shares some infrastructure with the Gemini provider but targets different models and endpoints.

## Authentication

Discovered in the following order:

1. **Pi Model Registry**: `google-antigravity` entry.
2. **Environment Variables**: `ANTIGRAVITY_API_KEY` and `ANTIGRAVITY_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`).
3. **`auth.json`**: `google-antigravity`, `antigravity`, or `anti-gravity` entries.

## API Endpoint

- **Usage**: `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
- **Method**: `POST`
- **Body**: `{ "project": "PROJECT_ID" }`

## Usage Windows

The provider groups specific internal models into windows:

- **Claude**: Includes `claude-sonnet-4-5`, `claude-sonnet-4-5-thinking`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`.
- **G3 Pro**: Includes `gemini-3-pro-high`, `gemini-3-pro-low`, and `gemini-3-pro-preview`.
- **G3 Flash**: Includes `gemini-3-flash`.

## Logic Details

- **Pessimistic Quota**: Similar to Gemini, it selects the "worst" quota (least remaining) among all models in a specific group.
- **Token Refresh**: Supports refreshing Google OAuth tokens if a `refreshToken` is available.
- **Fallbacks**: If the primary credential fails (e.g., from the registry), it attempts to fall back to credentials found in `auth.json`.
