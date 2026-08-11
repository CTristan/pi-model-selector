# z.ai Usage

## Overview

The Zai provider (z.ai) fetches usage and token limits via a dedicated monitor API.

## Authentication

Discovers API keys from:

1. **Environment Variable**: `Z_AI_API_KEY`.
2. **`auth.json`**: `z-ai` or `zai` entry (`access` or `key` field).

The quota request sends the `id.secret` key verbatim in the `Authorization` header. It does not use a `Bearer` prefix.

## API Endpoint

- **Usage**: `https://api.z.ai/api/monitor/usage/quota/limit`

## Usage Windows

- **Credits**: Current coding plans report `CREDIT_LIMIT` buckets, labeled by duration such as `Credits (5h)` and `Credits (1w)`.
- **Tokens**: Legacy `TOKENS_LIMIT` buckets retain labels such as `Tokens (5h)`.
- **Monthly**: Corresponds to `TIME_LIMIT` type in the API.

## Logic Details

- **Window Units**: The API provides units for limits (3=hour, 4=day, 5=month, 6=week), which are converted into stable duration labels.
- **Status Checking**: Validates the `success` boolean and `200` status code in the JSON response before processing data.
- **Plan Info**: Displays the plan name returned by the API.
