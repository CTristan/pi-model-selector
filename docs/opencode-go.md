# OpenCode Go Usage

## Overview

The OpenCode Go provider fetches subscription quota from OpenCode's zen usage endpoint. Because the API key is the same one Pi stores for the `opencode-go` model provider, this adapter needs no credentials of its own.

## Authentication

Discovers the API key from:

1. **Pi provider auth**: The resolved `opencode-go` entry from Pi's model registry.
2. **OMP auth storage**: `authStorage.getApiKey("opencode-go")` (OMP stores keys in SQLite, not `auth.json`).
3. **Environment Variable**: `OPENCODE_API_KEY`.
4. **`auth.json`**: `opencode-go` entry (`key`, `access`, or `apiKey` field).

The quota request sends the key as a `Bearer` token.

## API Endpoint

- **Usage**: `GET https://opencode.ai/zen/go/v1/usage`

The endpoint is undocumented, so the response schema is treated as subject to change. We parse defensively for that reason: a malformed payload or a response with no usable windows produces an error snapshot instead of an empty success.

## Usage Windows

- **5-hour**: The `rolling` window.
- **Weekly**: The `weekly` window.
- **Monthly**: The `monthly` window.

Each window carries a `status`. Windows with status `ok` report live quota and windows with status `rate-limited` report an exhausted one at 100 percent, so both are included because exhausted windows are exactly what the selector routes around. Windows with any other status are skipped, because guessing at unknown statuses risks hiding a window you mapped.

## Logic Details

- **Percent Clamping**: `percent` values are clamped to 0-100, and non-numeric values drop the window.
- **Reset Time**: `resetsAt` strings are parsed into reset descriptions (e.g., `2h 15m`).
- **Plan Info**: The snapshot reports the plan name `Go`.
