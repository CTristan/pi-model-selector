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
- [MiniMax](minimax.md)
- [OpenCode Go](opencode-go.md)


## Runtime Compatibility

- [OMP compatibility](omp-compatibility.md)

## Common Concepts

### Usage Windows

Each provider reports usage in one or more "windows". A window typically consists of:

- **Label**: A human-readable name for the quota (e.g., "5h", "Tokens", "Monthly").
- **Used Percent**: A value from 0 to 100 representing how much of the quota has been consumed.
- **Reset Time**: When the quota will reset or refresh.

### Authentication

Pi owns the model catalogue and authentication state. The wizard and selector read the current session's scoped models, then Pi's authenticated model snapshot, so you do not need to copy credentials or enable providers in this extension. Use `/login` or the provider's environment variable through Pi.

Pi does not expose a generic quota API, so the extension keeps provider-aware usage adapters for quota endpoints, local probes, and CLI sources. Some usage sources do not share the same credential as the Pi model provider, so those adapters retain their provider-specific fallback rules. `disabledProviders` remains an optional explicit opt-out for older configurations.

> **Note**: When configuring mappings, the `model.provider` and `model.id` must exactly match a selectable model in the Pi registry (e.g., `openai`, `google`, `anthropic`, `github-copilot`, or `opencode-go`). Use the `/models` command in Pi to see available providers and their IDs. OpenCode Go models appear when Pi has an OpenCode Go key, and the extension tracks OpenCode Go quota when that key can reach the usage endpoint.

### Ranking & Selection

The extension uses the data from these providers to rank available models. It prioritizes models with higher remaining capacity and earlier reset times, according to the `priority` rules defined in the configuration.
