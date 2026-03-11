# Instructions

This file provides guidance when working with code in this repository.

## Project

Pi extension that automatically selects the best AI model based on remaining usage quotas across providers (Anthropic, Copilot, Gemini, Codex/OpenAI, Antigravity, Kiro, z.ai, Minimax). It tracks per-provider usage windows, applies cooldowns for rate-limited or skipped models, and coordinates across Pi instances via file-based model locks.

## Commands

- `npm test` — run all tests with coverage (vitest, 80% threshold on src/)
- `npm run test:watch` — vitest in watch mode
- `npx vitest run tests/some-file.test.ts` — run a single test file
- `npm run type-check` — TypeScript compilation check (`tsc`)
- `npm run check` — Biome lint
- `npm run fix` — Biome auto-fix formatting and lint
- `npm run ci` — full CI pipeline

## Architecture

**Entry point:** `index.ts` — registers the extension with Pi's `ExtensionAPI`, hooks lifecycle events (`session_start`, `before_agent_start`, `agent_end`, `session_switch`, `session_shutdown`), and registers slash commands (`/model-select`, `/model-select-config`, `/model-skip`, `/model-unskip`, `/model-auto-toggle`).

**Core selection flow** (`src/selector.ts` → `runSelector()`):
1. Load config → fetch all provider usages in parallel (30s timeout each)
2. Detect 429s → apply provider-wide cooldowns
3. Build candidates from usage snapshots → combine windows → filter by cooldowns/reserves → sort by priority rules
4. Acquire model lock if needed → set model via Pi API → update widget

**Key modules:**
- `src/candidates.ts` — build, combine, sort, and rank usage candidates
- `src/config.ts` — load/merge global (`~/.pi/model-selector.json`) + project (`.pi/model-selector.json`) configs
- `src/cooldown.ts` — `CooldownManager` class tracking skip and 429 cooldowns, persisted to `~/.pi/model-selector-cooldowns.json`
- `src/model-locks.ts` — `ModelLockCoordinator` for file-based cross-instance locking with heartbeats and lease TTLs
- `src/usage-fetchers.ts` — orchestrates parallel fetching from all providers
- `src/fetchers/` — one file per provider (anthropic, copilot, gemini, codex, antigravity, kiro, zai, minimax) plus `common.ts` for shared auth utilities
- `src/widget.ts` — renders usage progress bars in Pi UI
- `src/wizard.ts` — interactive config wizard for `/model-select-config`
- `src/types.ts` — core types (`UsageSnapshot`, `UsageCandidate`, `MappingEntry`, `LoadedConfig`, `ProviderName`)

## Code Style

- TypeScript strict mode, ES2022 target, NodeNext module resolution
- Biome: 2-space indent, double quotes, always semicolons
- Tests in `tests/` directory; `any` and non-null assertions allowed in test files
- Peer dependency on `@mariozechner/pi-coding-agent` (Pi SDK)
- Uses `luxon` for date/time handling
