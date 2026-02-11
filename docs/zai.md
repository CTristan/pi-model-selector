# z.ai Usage

## Overview

The Zai provider (z.ai) fetches usage and token limits via a dedicated monitor API.

## Authentication

Discovers API keys from:

1. **Environment Variable**: `Z_AI_API_KEY`.
2. **`auth.json`**: `z-ai` or `zai` entry (`access` or `key` field).

## API Endpoint

- **Usage**: `https://api.z.ai/api/monitor/usage/quota/limit`

## Usage Windows

- **Tokens**: Labeled based on the window duration, e.g., `Tokens (24h)`, `Tokens (1h)`.
- **Monthly**: Corresponds to `TIME_LIMIT` type in the API.

## Logic Details

- **Window Units**: The API provides units for limits (1=day, 3=hour, 5=minute), which are converted into human-readable labels like `1d`, `3h`, or `5m`.
- **Status Checking**: Validates the `success` boolean and `200` status code in the JSON response before processing data.
- **Plan Info**: Displays the plan name returned by the API.
