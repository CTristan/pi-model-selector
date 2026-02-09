# AGENTS.md

> **Note**: This is a living document and should be updated whenever appropriate to reflect changes in the project structure, configuration, or logic.

## Project Overview
`pi-model-selector` is a Pi extension designed to optimize AI model usage by automatically selecting the best available model based on real-time quota tracking. It helps users manage rate limits across multiple providers (Anthropic, GitHub Copilot, Google Gemini, OpenAI, etc.) by switching to models with the most capacity or earliest reset times. It also displays a visual widget showing the top-ranked model candidates.

## Key Files

### Entry Point
- **`index.ts`**: Main extension entry point. Wires together all modules, registers commands (`/model-select`, `/model-select-config`, `/model-skip`), and handles session events. Implements the model cooldown persistence logic.

### Source Modules (`src/`)
- **`src/types.ts`**: Core TypeScript interfaces and types (`UsageSnapshot`, `RateWindow`, `UsageCandidate`, `MappingEntry`, `LoadedConfig`, `WidgetConfig`). Also exports utility functions like `notify()` and default constants.
- **`src/usage-fetchers.ts`**: Provider-specific usage fetching logic for Claude, Copilot, Gemini, Antigravity, Codex, Kiro, and z.ai. Exports `fetchAllUsages()` as the main aggregator.
- **`src/config.ts`**: Configuration loading, parsing, validation, and saving. Handles merging global and project configs. Exports `loadConfig()`, `saveConfigFile()`, `upsertMapping()`, `updateWidgetConfig()`.
- **`src/candidates.ts`**: Candidate building and ranking logic. Exports `buildCandidates()`, `sortCandidates()`, `findModelMapping()`, `findIgnoreMapping()`, `selectionReason()`.
- **`src/widget.ts`**: Visual sub-bar widget rendering. Displays top N ranked candidates with progress bars. Exports `updateWidgetState()`, `renderUsageWidget()`, `clearWidget()`.

### Configuration
- **`config/model-selector.json`**: Default configuration including:
    - **`priority`**: Ordered list of ranking rules.
    - **`widget`**: Widget display settings (enabled, placement, showCount).
    - **`mappings`**: Links usage windows to model IDs or marks them as ignored.

### CI/CD
- **`scripts/ci.sh`**: CI gate script for local and automated checks (type checking, unit tests).
- **`scripts/setup-hooks.sh`**: Script to install and configure the Git pre-commit hook.
- **`.github/workflows/ci.yml`**: GitHub Actions workflow for running the CI gate on push/PR.
- **`.git/hooks/pre-commit`**: Local Git hook that runs `ci.sh` before every commit.

### Testing
- **`tests/*.test.ts`**: Unit tests using Vitest. Run with `npm run test`.
- **`npm run test`**: Generate test coverage report.
- **Performance Requirement**: All unit tests must complete within **one second**. Tests exceeding this limit must be updated, refactored, or removed.

## Data Flow
1. **Trigger**: Extension runs on session start or `/model-select` command.
2. **Configuration Load**: Reads and merges global + project configs.
3. **Quota Retrieval**: Fetches usage from all configured providers in parallel.
4. **Candidate Evaluation**: Builds candidates, filters ignored, sorts by priority.
5. **Widget Update**: Updates the visual widget with top N candidates.
6. **Model Selection**: Selects best candidate, looks up mapping, calls `pi.setModel()`.

## Cooldown Mechanism
To handle transient "No capacity" (503) errors that aren't reflected in quota usage:
1. **`/model-skip` Command**: Manually triggers a 1-hour cooldown for the most recently selected usage bucket.
2. **Persistence**: Cooldown state and the last selected model key are persisted to `~/.pi/model-selector-cooldowns.json`. This ensures cooldowns survive across Pi invocations (critical for print-mode automation).
3. **Filtering**: `runSelector` filters out any candidates currently on cooldown before ranking.

## Configuration Schema

```json
{
  "priority": ["fullAvailability", "remainingPercent", "earliestReset"],
  "widget": {
    "enabled": true,
    "placement": "belowEditor",
    "showCount": 3
  },
  "mappings": [
    {
      "usage": { "provider": "anthropic", "window": "Sonnet" },
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" }
    },
    {
      "usage": { "provider": "gemini", "window": "Flash" },
      "ignore": true
    }
  ]
}
```

### Configuration Options
- **`priority`**: Array of rules determining candidate ranking order.
- **`widget.enabled`**: Boolean to enable/disable the usage widget.
- **`widget.placement`**: `"aboveEditor"` or `"belowEditor"`.
- **`widget.showCount`**: Number of top candidates to display (default: 3).
- **`mappings`**: Array linking usage sources to models or marking as ignored.

## Development Guidelines

### File Size Limit
**Any file reaching 2000 lines or more must be refactored.** Split large files into focused modules with clear responsibilities. Current architecture maintains files under 500 lines each.

### Code Organization
- Keep provider-specific logic in `usage-fetchers.ts`
- Keep ranking/comparison logic in `candidates.ts`
- Keep UI/widget code in `widget.ts`
- Keep config I/O in `config.ts`
- Keep types and shared constants in `types.ts`

### Language & Environment
- **Language**: TypeScript
- **Environment**: Node.js (executed within Pi extension host)
- **Dependencies**: `@mariozechner/pi-coding-agent` for extension API types
