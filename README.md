# pi-model-selector

A Pi extension that automatically selects the best AI model based on remaining usage quotas across various providers. It helps you get the most out of your available tokens by switching to models with the most capacity or earliest reset times.

## Features

- **Smart Model Selection**: Automatically switches to the model with the most available quota or earliest reset time.
- **Multi-Provider Support**: Tracks usage for:
  - Anthropic (Claude)
  - GitHub Copilot
  - Google Gemini
  - OpenAI (Codex)
  - Antigravity
  - Kiro
  - z.ai
- **Configurable Priorities**: Define your own rules for selection (e.g., prioritize full availability over remaining percentage).
- **Flexible Mappings**: Map specific usage windows (e.g., "5h quota", "Weekly limit") to specific models.
- **Interactive Configuration**: Built-in wizard to easily set up mappings and priorities.

## Installation

To install this extension, use the `pi` CLI:

```bash
pi package install https://github.com/CTristan/pi-model-selector
```

Or if you have the source code locally:

```bash
pi package install .
```

Restart Pi after installation to load the extension.

## Usage

The extension runs automatically when you start a new session. You can also use the following commands within Pi:

- `/model-select`: Manually trigger the model selection process to switch to the best available model immediately.
- `/model-select-config`: Open the interactive configuration wizard. This allows you to:
  - Map usage "buckets" (e.g., Claude 5h limit) to specific Pi models.
  - Ignore specific buckets you don't want to use.
  - Set the priority order for selection.

## Configuration

Configuration is loaded from `config/model-selector.json` (bundled defaults) and `.pi/model-selector.json` (project-specific overrides).

### Priority Rules

You can prioritize candidates based on:

- `fullAvailability`: Prefer models with 100% quota remaining.
- `remainingPercent`: Prefer models with the highest percentage of quota remaining.
- `earliestReset`: Prefer models that reset the soonest.

### Mappings

Map a provider's usage window to a specific Pi model ID.

Example `model-selector.json`:

```json
{
  "priority": ["fullAvailability", "remainingPercent", "earliestReset"],
  "mappings": [
    {
      "usage": { "provider": "anthropic", "window": "Sonnet" },
      "model": { "provider": "anthropic", "id": "claude-3-5-sonnet" }
    },
    {
      "usage": { "provider": "copilot", "window": "Chat" },
      "model": { "provider": "github-copilot", "id": "gpt-4o" }
    },
    {
      "usage": { "provider": "gemini", "window": "Flash" },
      "ignore": true
    }
  ]
}
```
