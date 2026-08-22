# pi-model-selector

A Pi extension that automatically selects the best AI model based on remaining usage quotas across various providers. It helps you get the most out of your available tokens by switching to models with the most capacity or earliest reset times.

## Features

- **Smart Model Selection**: Automatically switches to the model with the most available quota or earliest reset time.
- **Provider-aware usage adapters**: Tracks quota windows for Anthropic (Claude), GitHub Copilot, Google Gemini, OpenAI (Codex), Antigravity, Kiro, z.ai, and MiniMax.
- **Pi-native model catalogue**: Uses Pi's authenticated and session-scoped model list, so built-in providers such as OpenCode Go appear as mapping targets without extension changes.
- **Configurable Priorities**: Define your own rules for selection (e.g., prioritize full availability over remaining percentage).
- **Flexible Mappings**: Map specific usage windows (e.g., "5h quota", "Weekly limit") to specific models.
- **Interactive Configuration**: Built-in wizard to easily set up mappings and priorities.

## Installation

To install this extension, use the `pi` CLI:

```bash
pi install npm:@hemocode/pi-model-selector
```

Or install from GitHub directly:

```bash
pi install https://github.com/CTristan/pi-model-selector
```

Or if you have the source code locally:

```bash
pi package install .
```

Restart Pi after installation to load the extension.

## Runtime compatibility

This extension supports current Pi 0.84.1 (Node.js 22.19+) and OMP 17.2.12 (its supported Bun runtime). OMP aliases literal `@earendil-works/pi-*` imports to its canonical in-process compatibility modules. Legacy `@mariozechner/*` Pi releases are not supported. See [docs/omp-compatibility.md](docs/omp-compatibility.md) before changing SDK imports or runtime integration code.


## Usage

The extension runs automatically when you start a new session. You can also use the following commands within Pi:

- `/model-select`: Manually trigger the model selection process to switch to the best available model immediately.
- `/model-select-config`: Open the interactive configuration wizard. This allows you to:
  - Map usage "buckets" (e.g., Claude 5h limit) to specific Pi models.
  - Ignore specific buckets you don't want to use.
  - Set the priority order for selection.
  - Run a config cleanup pass (remove unused `examples`, fix global debug log path, remove invalid/duplicate mapping entries, and prune mappings that target unavailable Pi provider/model IDs).

## Configuration

Configuration is merged from two sources:

1.  **Global Config**: `~/.pi/model-selector.json` under Pi or `~/.omp/model-selector.json` under OMP. Use this for personal model mappings and preferences.
2.  **Project Config**: `.pi/model-selector.json` under Pi or `.omp/model-selector.json` under OMP. Use this for project-specific overrides. Current Pi ignores project-local configuration when the project is not trusted.

A template for the global configuration can be found in `config/model-selector.example.json`.

### Provider discovery and authentication

Pi owns the model catalogue and authentication state. The extension reads the current session's scoped models and authenticated model snapshot, so you do not need to enable providers or duplicate credential checks here.

Pi does not expose a generic quota API. Provider-aware adapters still query each provider's supported usage source, using Pi's resolved auth when the request credential also works for that usage endpoint. CodexBar's provider documentation remains the reference for source selection, fallback order, and parser behavior. `disabledProviders` remains an optional explicit opt-out for older configurations, not a required setup step.

### Priority Rules

You can prioritize candidates based on:

- `fullAvailability`: Prefer models with 100% quota remaining.
- `remainingPercent`: Prefer models with the highest percentage of quota remaining.
- `earliestReset`: Prefer models that reset the soonest.

### Mappings

Map a provider's usage window to a specific Pi model ID.

> **Note**: The `model.provider` and `model.id` must match the names used in the Pi model registry (e.g., `github-copilot`, `anthropic`, `google`).

#### Reserve Threshold

You can optionally set a `reserve` percentage on model mappings to preserve a minimum amount of usage capacity. Candidates at or below their reserve threshold are excluded from model selection (treated the same as exhausted buckets). This is useful for keeping some quota available for other tools or manual use.

Example `model-selector.json`:

```json
{
  "priority": ["fullAvailability", "remainingPercent", "earliestReset"],
  "mappings": [
    {
      "usage": { "provider": "anthropic", "window": "Sonnet" },
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" }
    },
    {
      "usage": { "provider": "copilot", "window": "Chat" },
      "model": { "provider": "github-copilot", "id": "gpt-4.1" },
      "reserve": 20
    },
    {
      "usage": { "provider": "gemini", "window": "Flash" },
      "ignore": true
    }
  ]
}
```

In this example, the Copilot Chat mapping has a reserve of 20%. This means the model selector will only use that model when more than 20% quota remains, preserving at least 20% for other purposes.
