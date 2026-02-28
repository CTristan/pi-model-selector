# AGENTS.md

> **Note**: This is a living document and should be updated whenever appropriate to reflect changes in the project structure, configuration, or logic.

## Project Overview

`pi-model-selector` is a Pi extension designed to optimize AI model usage by automatically selecting the best available model based on real-time quota tracking. It helps users manage rate limits across multiple providers (Anthropic, GitHub Copilot, Google Gemini, OpenAI, etc.) by switching to models with the most capacity or earliest reset times. It also displays a visual widget showing the top-ranked model candidates.

## Key Files

### Entry Point

- **`index.ts`**: Main extension entry point. Wires together all modules, registers commands (`/model-select`, `/model-select-config`, `/model-skip`, `/model-auto-toggle`), and handles session events. Delegates to specialized modules for cooldown management, model selection, and UI wizards.

### Source Modules (`src/`)

- **`src/types.ts`**: Core TypeScript interfaces and types (`UsageSnapshot`, `RateWindow`, `UsageCandidate`, `MappingEntry`, `LoadedConfig`, `WidgetConfig`). Also exports utility functions like `notify()` and default constants.
- **`src/usage-fetchers.ts`**: Usage aggregation entry point. Exports `fetchAllUsages()` and re-exports fetcher utilities for compatibility.
- **`src/fetchers/*.ts`**: Provider-specific usage fetchers and shared fetch utilities (`anthropic.ts`, `copilot.ts`, `gemini.ts`, `antigravity.ts`, `codex.ts`, `kiro.ts`, `zai.ts`, `common.ts`).
- **`src/config.ts`**: Configuration loading, parsing, validation, saving, and cleanup. Handles merging global and project configs. Cleanup also prunes mappings that reference unavailable Pi provider/model IDs when a model resolver is provided. Exports `loadConfig()`, `saveConfigFile()`, `cleanupConfigRaw()`, `upsertMapping()`, `updateWidgetConfig()`.
- **`src/candidates.ts`**: Candidate building and ranking logic. Exports `buildCandidates()`, `combineCandidates()`, `sortCandidates()`, `findModelMapping()`, `findIgnoreMapping()`, `selectionReason()`.
- **`src/cooldown.ts`**: Cooldown state management. Handles loading/saving cooldown state to disk, checking if candidates are on cooldown, and managing provider-wide cooldowns for rate limiting (429 errors).
- **`src/selector.ts`**: Model selection logic. Contains the `runSelector` function that handles candidate evaluation, model lock acquisition, fallback model handling, and model selection notifications.
- **`src/wizard.ts`**: Configuration wizard. Interactive UI for setting up mappings, providers, priority, fallback model, widget settings, auto-run, debug logging, and config cleanup.
- **`src/credential-check.ts`**: Provider credential detection. Checks if credentials are available for each provider via environment variables, authStorage, or piAuth.
- **`src/ui-helpers.ts`**: UI helper functions. Includes `selectWrapped` for custom select lists, helper functions for ignore mapping detection, and priority options.
- **`src/model-locks.ts`**: Cross-instance model lock coordinator. Manages cooperative per-model mutexes in `~/.pi/model-selector-model-locks.json` with heartbeat refresh, stale lock cleanup, and atomic file-based updates.
- **`src/widget.ts`**: Visual sub-bar widget rendering. Displays top N ranked candidates with progress bars. Exports `updateWidgetState()`, `renderUsageWidget()`, `clearWidget()`.

### Documentation

- **`docs/*.md`**: Provider-specific documentation detailing authentication methods, API endpoints, usage windows, and logic details.
- **Provider Updates**: Whenever provider logic in `src/fetchers/` is updated, the corresponding file in `docs/` must be reviewed and updated to remain accurate.

### Configuration

- **`~/.pi/model-selector.json`**: Global user configuration. Contains provider-specific mappings and preferences. This file is not tracked by Git.
- **`config/model-selector.example.json`**: Template for global configuration.
- **`.pi/model-selector.json`**: Project-specific overrides (optional).

### CI/CD

- **`scripts/ci.sh`**: CI gate script for local and automated checks (type checking, unit tests). Requires a bash-compatible environment (Linux, macOS, WSL, or Git Bash on Windows).
- **`scripts/setup-hooks.sh`**: Shell script to install and configure the Git pre-commit hook. Requires a bash-compatible environment.
- **`.github/workflows/ci.yml`**: GitHub Actions workflow for running the CI gate on push/PR.
- **`.git/hooks/pre-commit`**: Local Git hook that runs `ci.sh` before every commit.

### Testing

- **`tests/*.test.ts`**: Unit tests using Vitest. Run with `npm run test`.
- **Naming Convention**: Test filenames must clearly indicate what they are testing (e.g., `candidates.test.ts`, `config-loading.test.ts`). **Do not use generic, ambiguous, or ephemeral names like `reproduce.test.ts`, `reproduce_issue.test.ts`, or `pr9-fixes.test.ts`.**
- **`npm run test`**: Generate test coverage report.
- **Performance Requirement**: All unit tests must complete within **one second**. Tests exceeding this limit must be updated, refactored, or removed.

## Data Flow

1. **Trigger**: Extension runs on session start, `/model-select`, or `before_agent_start` (request preflight).
2. **Configuration Load**: Reads and merges global + project configs.
3. **Quota Retrieval**: Fetches usage from all configured providers in parallel.
4. **Candidate Evaluation**: Builds candidates, applies combinations, filters ignored/cooldowned/reserved (at or below reserve threshold or 0% remaining), sorts by priority.
5. **Widget Update**: Updates the visual widget with top N candidates. Candidates below their reserve threshold are visually indicated with a reserve marker.
6. **Model Selection**: Selects best candidate, looks up mapping, calls `pi.setModel()`.
7. **Lock Coordination**: For request preflight, acquires a per-model cross-instance lock (fall through ranked candidates; wait/poll only when all mapped models are busy).
8. **Fallback**: If all quota-tracked models are exhausted, below reserve, or locked, attempts to use the configured fallback model (if any).

## Cooldown Mechanism

To handle transient "No capacity" (503) errors that aren't reflected in quota usage:

1. **`/model-skip` Command**: Manually triggers a 1-hour cooldown for the most recently selected usage bucket.
2. **Persistence**: Cooldown state and the last selected model key are persisted to `~/.pi/model-selector-cooldowns.json`. This ensures cooldowns survive across Pi invocations (critical for print-mode automation).
3. **Filtering**: `runSelector` filters out any candidates currently on cooldown before ranking.

## Cross-Instance Model Lock Mechanism

To ensure one Pi instance uses a given mapped model at a time:

1. **Lock File**: Cooperative lock state is stored in `~/.pi/model-selector-model-locks.json`.
2. **Acquire on Request**: During `before_agent_start`, selector attempts locks in ranked order and picks the first unlocked mapped model.
3. **Wait/Poll Fallback**: If all mapped models are locked, selector waits and polls until one is released (or timeout).
4. **Hold + Heartbeat**: Active lock is refreshed periodically while the agent runs.
5. **Release**: Lock is released on `agent_end` and `session_shutdown`.
6. **Stale Recovery**: Locks from dead or stale owners are cleaned up automatically.
7. **Busy Lock Logging**: When a model lock is already held by another instance, details are logged to the debug log (if enabled) to help diagnose lock contention. The log includes the model key, holding instance ID and PID, lock age, and heartbeat age.

## Fallback Model Mechanism

To prevent the extension from failing entirely when all quota-tracked models are depleted or busy:

1. **Configuration**: The optional `fallback` configuration specifies a last-resort model (e.g., a pay-per-use API key or self-hosted model).
2. **Exhausted Path**: When all non-ignored candidates have 0% remaining, the fallback is used instead of failing.
3. **Lock Path**: When all mapped models are locked during lock acquisition, the fallback is tried as the lowest-priority candidate (if `fallback.lock` is `true`).
4. **Lock Acquisition**: The fallback participates in lock coordination when `fallback.lock` is `true` (default). When `fallback.lock` is `false`, the fallback is used without acquiring a lock.
5. **Cooldown Exemption**: The fallback is exempt from the cooldown mechanism; `/model-skip` does not affect it.
6. **Widget Exclusion**: The fallback is not displayed in the usage widget since it has no quota data.
7. **Notification**: When the fallback is selected, the notification clearly indicates it's a last-resort fallback.

## Configuration Schema

```json
{
  "priority": ["fullAvailability", "remainingPercent", "earliestReset"],
  "fallback": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "lock": true
  },
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
      "usage": { "provider": "copilot", "window": "Chat" },
      "model": { "provider": "github-copilot", "id": "gpt-4o" },
      "reserve": 20
    },
    {
      "usage": { "provider": "gemini", "window": "Flash" },
      "ignore": true
    },
    {
      "usage": { "provider": "codex", "windowPattern": "(5h|1w)" },
      "combine": "Codex Combined"
    },
    {
      "usage": { "provider": "codex", "window": "Codex Combined" },
      "model": { "provider": "openai-codex", "id": "gpt-4o" }
    }
  ]
}
```

### Configuration Options

- **`priority`**: Array of rules determining candidate ranking order.
- **`fallback.provider`**: Pi provider ID for the fallback model (e.g., `"anthropic"`, `"openai"`).
- **`fallback.id`**: Pi model ID for the fallback model (e.g., `"claude-sonnet-4-5"`, `"gpt-4o"`).
- **`fallback.lock`**: Optional boolean (default: `true`). Whether to acquire a cross-instance model lock when using the fallback. Set to `false` for models that support unlimited concurrent connections.
- **`widget.enabled`**: Boolean to enable/disable the usage widget.
- **`widget.placement`**: `"aboveEditor"` or `"belowEditor"`.
- **`widget.showCount`**: Number of top candidates to display (default: 3).
- **`mappings`**: Array linking usage sources to models, marking as ignored, or grouping for combination.
  - **`model`**: Optional object with `provider` and `id` fields. Maps the usage bucket to a specific Pi model.
  - **`ignore`**: Optional boolean. If `true`, excludes the usage bucket from model selection.
  - **`combine`**: Optional string. If specified, candidates matching this mapping are grouped together. A new synthetic candidate is created with this name, using the minimum availability (bottleneck) among all group members.
  - **`reserve`**: Optional number (0-99). Minimum usage percentage to preserve for this mapping. Candidates at or below their reserve threshold are excluded from model selection (same as exhausted candidates). Only valid on mappings with a `model` target. Defaults to 0 (no reserve).

## Development Guidelines

### File Size Limit

**Any file reaching 2000 lines or more MUST be refactored IMMEDIATELY, even in the middle of another task.**

This is a critical requirement to maintain code quality and maintainability. When a file exceeds 2000 lines:

1. **Stop the current task** (unless it's a critical hotfix that cannot be interrupted)
2. **Refactor the file** into smaller, focused modules with clear responsibilities
3. **Ensure all tests still pass** after the refactoring
4. **Resume the original task**

**Aim to keep most files under roughly 500 lines where practical**, and periodically refactor growing files before they reach the 2000-line threshold.

**Example**: The original `index.ts` was 2580 lines and was refactored into:
- `index.ts` - Main entry point and event registration
- `src/cooldown.ts` - Cooldown state management
- `src/credential-check.ts` - Provider credential checking
- `src/selector.ts` - Model selection logic
- `src/ui-helpers.ts` - UI helper functions
- `src/wizard.ts` - Configuration wizard

### Code Organization

- Keep provider-specific logic in `src/fetchers/*.ts`
- Keep usage orchestration in `src/usage-fetchers.ts`
- Keep ranking/comparison logic in `candidates.ts`
- Keep UI/widget code in `widget.ts`
- Keep config I/O in `config.ts`
- Keep cross-instance lock coordination in `model-locks.ts`
- Keep types and shared constants in `types.ts`

### Testing Best Practices

- **Descriptive Names**: Ensure test files are named after the module or feature they test.
- **No Reproduction Files**: Avoid committing files named `reproduce.test.ts`, `pr9-fixes.test.ts`, or similar. If a bug is reproduced via a test, integrate that test into the appropriate existing test suite or create a new descriptively named test file.
- **Never Exclude Files from Coverage Thresholds**: Do not add source files to the coverage `exclude` list in `vitest.config.ts` to work around low coverage. If a file is hard to test, that is a signal it needs to be **refactored for testability**, not excluded. Extract pure logic (decision-making, data transformation, formatting) away from side effects (API calls, file I/O, interactive prompts) so the core behavior can be unit-tested directly.
- **Design for Testability**: Prefer small, pure functions that take inputs and return outputs over large functions that mix logic with side effects. When a module orchestrates async operations, keep the orchestration thin and delegate decisions to testable helpers.

### Language & Environment

- **Language**: TypeScript
- **Environment**: Node.js (executed within Pi extension host)
- **Tooling**: Shell scripts (`.sh`) are used for CI/CD and Git hooks. On Windows, a bash-compatible environment such as Git Bash or WSL is required. **Do not convert shell scripts to Node.js or batch files for Windows compatibility.**
- **Dependencies**: `@mariozechner/pi-coding-agent` for extension API types
