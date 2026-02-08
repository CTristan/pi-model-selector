# AGENTS.md

> **Note**: This is a living document and should be updated whenever appropriate to reflect changes in the project structure, configuration, or logic.

## Project Overview
`pi-model-selector` is a Pi extension designed to optimize AI model usage by automatically selecting the best available model based on real-time quota tracking. It helps users manage rate limits across multiple providers (Anthropic, GitHub Copilot, Google Gemini, OpenAI, etc.) by switching to models with the most capacity or earliest reset times.

## Key Files
- **`index.ts`**: The core logic of the extension. It handles:
    - **Usage Fetching**: Queries provider APIs (Claude, Copilot, Gemini, etc.) to retrieve current quota status.
    - **Data Normalization**: Converts raw API responses into a standardized `UsageSnapshot` format containing `RateWindow` objects (e.g., "5h quota", "Daily limit").
    - **Model Selection**: Implements the logic to compare usage windows against user-defined priorities and select the optimal candidate.
    - **Command Registration**: Registers `/model-select` (manual trigger) and `/model-select-config` (interactive setup) within Pi.
- **`config/model-selector.json`**: Contains default configuration, including:
    - **`priority`**: An ordered list of rules for selecting the best model (e.g., prefer full availability over partial).
    - **`mappings`**: Definitions linking specific usage windows (e.g., "Claude 5h") to specific Pi model IDs.
- **`package.json`**: Defines the project metadata, entry point (`index.ts`), and dependencies.

## Data Flow
1.  **Trigger**: The extension runs on session start or when the `/model-select` command is invoked.
2.  **Configuration Load**: It reads `config/model-selector.json` and overrides from user/project config files.
3.  **Quota Retrieval**:
    - Credentials are sourced from Pi's internal auth storage or local provider configuration files.
    - API requests are made to provider endpoints to get current usage.
4.  **Candidate Evaluation**:
    - Usage data is processed into a list of candidates.
    - Candidates are filtered (removing ignored buckets) and sorted based on the `priority` rules.
5.  **Action**:
    - The best candidate is matched against the `mappings`.
    - If a valid target model is found, `pi.setModel()` is called to switch the active model.
    - User notifications are sent via `pi.notify()` or the console.

## Configuration Schema
The configuration file (`model-selector.json`) uses the following structure:

```json
{
  "priority": ["fullAvailability", "remainingPercent", "earliestReset"],
  "mappings": [
    {
      "usage": { "provider": "anthropic", "window": "Sonnet" },
      "model": { "provider": "anthropic", "id": "claude-3-5-sonnet" }
    },
    {
      "usage": { "provider": "gemini", "window": "Flash" },
      "ignore": true
    }
  ]
}
```

- **`priority`**: Determines how candidates are ranked.
- **`mappings`**: Connects a usage source (`provider` + `window`) to a destination model or marks it as ignored.

## Development Notes
- **Language**: TypeScript
- **Environment**: Node.js (executed within the Pi extension host).
- **Dependencies**: Requires `@mariozechner/pi-coding-agent` for extension API types and context.
