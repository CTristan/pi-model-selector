# GitHub Copilot Usage

## Overview

The Copilot provider fetches usage information for GitHub Copilot. It supports multiple accounts and automatically handles token exchange for different authentication methods.

## Authentication

The extension attempts to discover tokens from multiple sources:

1. **Pi Model Registry**: `github-copilot` or `github` entries.
2. **`auth.json`**: `github-copilot.access`.
3. **GitHub CLI**: Executes `gh auth token` to retrieve a token.

If a GitHub token is found, the extension will attempt to exchange it for a Copilot-specific session token using the `copilot_internal/v2/token` endpoint. The provider attempts both `token <gh_token>` and `Bearer <gh_token>` authorization schemes during exchange for broader compatibility.

## API Endpoints

- **Token Exchange**: `https://api.github.com/copilot_internal/v2/token`. Supports both `token <gh_token>` and `Bearer <gh_token>` authentication schemes for broader compatibility.
- **User Usage**: `https://api.github.com/copilot_internal/user`

## Usage Windows

- **Premium**: Represents "premium_interactions". Shows remaining count vs. total entitlement (e.g., `150/2000`).
- **Chat**: Represents chat interaction limits.
- **Access**: A fallback window showing active status if no specific quota data is available.

## Logic Details

- **Multiple Accounts**: The extension can fetch and display usage for multiple GitHub accounts if multiple tokens are found.
- **Error Suppression**: To reduce noise, if multiple tokens are found and at least one succeeds, 401 Unauthorized errors from other (potentially expired) tokens are suppressed.
- **Caching (ETags)**: Uses standard HTTP ETags to support `304 Not Modified` responses, reducing API load and improving performance.
- **Plan Information**: Extracts the Copilot plan (e.g., `business`, `individual`) from the API response.
