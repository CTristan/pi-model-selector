# Codex Usage

## Overview

The Codex provider fetches usage information for OpenAI-based models managed via the Codex interface. It is designed to handle multiple accounts simultaneously.

## Authentication

Discovers credentials from:

1. **`auth.json`**: Entries starting with `openai-codex`.
2. **Pi Model Registry**: `openai-codex` entry.
3. **`~/.codex/` Directory**: Looks for `auth*.json` files.

## API Endpoint

- **Usage**: `https://chatgpt.com/backend-api/wham/usage`
- **Headers**: `Authorization: Bearer <token>`, `ChatGPT-Account-Id: <accountId>` (if available).

## Usage Windows

Windows are dynamically labeled based on their duration:

- **Duration Labels**: e.g., `3h` (3 hours), `1d` (1 day), `1w` (1 week).
- **Primary & Secondary**: Fetches both `primary_window` and `secondary_window` from the API.

## Logic Details

- **Multiple Accounts**: Aggregates usage from all discovered credentials, deduplicating by account ID or source.
- **Plan & Credits**: Displays the plan type (e.g., `plus`) and remaining credit balance (e.g., `$15.50`) if available.
- **Pessimistic Overlap**: If multiple windows have the same label, the one with the highest usage is selected.
