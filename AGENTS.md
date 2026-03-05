# AGENTS.md

> **This is a living document.** If you encounter something that cost you significant time and a note here would have prevented it, update this file. Keep changes concise — prefer editing existing sections over adding new ones.

## Project Overview

`pi-model-selector` is a Pi extension that automatically selects the best available AI model based on real-time quota tracking across multiple providers (Anthropic, GitHub Copilot, Google Gemini, OpenAI, etc.).

## Data Flow

1. Trigger: session start, `/model-select`, or `before_agent_start` (request preflight).
2. Load and merge global (`~/.pi/model-selector.json`) + project (`.pi/model-selector.json`) configs.
3. Fetch usage from all configured providers in parallel.
4. Build candidates → apply combinations → filter ignored/cooldowned/reserved/exhausted → sort by priority.
5. Filter candidates whose context windows can't accommodate the current conversation.
6. Update the visual widget with top N candidates.
7. If `compactOnSwitch` is enabled and a model switch is detected, compact conversation with old model first.
8. Select best candidate, look up mapping, call `pi.setModel()`. Acquire cross-instance lock during request preflight.
9. If all candidates are exhausted/locked/filtered, fall back to configured fallback model (if any).

## Non-Obvious Behavioral Rules

These are easy to get wrong because they aren't obvious from reading a single module:

- **Cooldowns persist to disk** (`~/.pi/model-selector-cooldowns.json`) and survive across Pi invocations. This is critical for print-mode automation.
- **Fallback is cooldown-exempt**: `/model-skip` never cooldowns the fallback model.
- **Fallback is widget-excluded**: It has no quota data and is never displayed in the widget.
- **Fallback lock behavior is configurable**: `fallback.lock` (default `true`) controls whether the fallback participates in cross-instance locking. Set to `false` for models supporting unlimited concurrency.
- **Locks use cooperative file-based mutexes** (`~/.pi/model-selector-model-locks.json`) with heartbeat refresh and stale recovery. Locks are released on `agent_end` and `session_shutdown`.
- **Provider docs must track fetcher changes**: Whenever provider logic in `src/fetchers/` is updated, the corresponding file in `docs/` must be reviewed and updated.

## Configuration

- **Schema**: See `README.md` for user-facing docs and `src/types.ts` for type definitions. The example config is at `config/model-selector.example.json`.
- **Global config**: `~/.pi/model-selector.json` (not tracked by Git).
- **Project config**: `.pi/model-selector.json` (optional overrides).

## Development Guidelines

### File Size Limit

**Any file reaching 2000 lines or more MUST be refactored IMMEDIATELY, even in the middle of another task.** Aim to keep most files under roughly 500 lines where practical.

### Code Organization

- Provider-specific logic → `src/fetchers/*.ts`
- Usage orchestration → `src/usage-fetchers.ts`
- Ranking/comparison → `src/candidates.ts`
- UI/widget → `src/widget.ts`
- Config I/O → `src/config.ts`
- Cross-instance locks → `src/model-locks.ts`
- Types and shared constants → `src/types.ts`

### Testing

- Run with `npm run test`. All tests must complete within **one second**.
- Test filenames must clearly indicate what they test (e.g., `candidates.test.ts`). **Do not use generic names** like `reproduce.test.ts` or `pr9-fixes.test.ts`.
- **Never exclude source files from coverage thresholds** in `vitest.config.ts`. If a file is hard to test, refactor it for testability.
- Prefer small, pure functions over large functions mixing logic with side effects.

### Language & Environment

- **Language**: TypeScript. **Environment**: Node.js (Pi extension host).
- Shell scripts (`.sh`) are used for CI/CD and Git hooks. **Do not convert them to Node.js or batch files.**

### Tooling: TypeScript/Biome Compatibility

`noPropertyAccessFromIndexSignature` is intentionally disabled in `tsconfig.json` because it conflicts with Biome's `useLiteralKeys` rule. Don't re-enable it.
