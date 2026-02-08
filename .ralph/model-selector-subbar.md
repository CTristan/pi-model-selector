# Integrate Sub-Bar Widget into pi-model-selector

Refactor the extension and add a visual usage widget showing top 3 ranked model candidates.

## Goals
- Split index.ts (1814 lines) into modular files under src/
- Add a sub-bar widget displaying top 3 ranked candidates with usage percentages
- Make the widget optional via config (can be disabled)
- Integrate widget toggle into the config wizard (/model-select-config)
- Update AGENTS.md with 2000-line file refactor rule

## Checklist
- [x] Create src/ directory structure
- [x] Extract types to src/types.ts
- [x] Extract usage fetching functions to src/usage-fetchers.ts
- [x] Extract config loading/saving to src/config.ts
- [x] Extract candidate ranking logic to src/candidates.ts
- [x] Create src/widget.ts with sub-bar rendering for top 3 candidates
- [x] Add widget config options (enabled, placement) to config schema
- [x] Update config wizard to include widget toggle option
- [x] Update index.ts to wire everything together
- [x] Update AGENTS.md with 2000-line refactor rule
- [x] Verify extension loads without errors

## Verification
- TypeScript compilation: `npx tsc --noEmit` - PASSED (no errors)
- File line counts all under 2000:
  - index.ts: 465 lines
  - src/candidates.ts: 184 lines
  - src/config.ts: 279 lines
  - src/types.ts: 99 lines
  - src/usage-fetchers.ts: 1006 lines
  - src/widget.ts: 177 lines
  - AGENTS.md: 79 lines

## Notes
- Current index.ts: 1814 lines
- Widget uses ctx.ui.setWidget() API
- Show: provider, window label, usage %, reset time for top 3 candidates
