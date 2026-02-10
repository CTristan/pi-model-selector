# Provider Documentation

This directory contains detailed information about each usage provider supported by the `pi-model-selector` extension.

## Supported Providers

- [Anthropic (Claude)](anthropic.md)
- [GitHub Copilot](copilot.md)
- [Google Gemini](gemini.md)
- [Antigravity](antigravity.md)
- [Codex](codex.md)
- [Kiro](kiro.md)
- [z.ai](zai.md)

## Common Concepts

### Usage Windows

Each provider reports usage in one or more "windows". A window typically consists of:

- **Label**: A human-readable name for the quota (e.g., "5h", "Tokens", "Monthly").
- **Used Percent**: A value from 0 to 100 representing how much of the quota has been consumed.
- **Reset Time**: When the quota will reset or refresh.

### Authentication

Most providers look for credentials in `~/.pi/agent/auth.json`, which is the standard location for Pi authentication data. Some providers also support environment variables, system keychains, or specific CLI tools.

> **Note**: When configuring mappings, the `model.provider` must exactly match the provider name as registered in the Pi model registry (e.g., `openai`, `google`, `anthropic`, `github-copilot`). Use the `/models` command in Pi to see available providers and their IDs.

### Ranking & Selection

The extension uses the data from these providers to rank available models. It prioritizes models with higher remaining capacity and earlier reset times, according to the `priority` rules defined in the configuration.
