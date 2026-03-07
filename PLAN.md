# Plan: Add Minimax Provider Support

## Context

Minimax has been added to `pi` as a provider and confirmed working with Minimax models. We need to add Minimax as a usage-tracking provider in `pi-model-selector` so the extension can fetch quota data from the Minimax Coding Plan API and include it in model selection decisions.

Minimax's Coding Plan provides a rolling 5-hour usage window with prompt limits per model (e.g., 1500 prompts for Max tier). The API returns per-model usage counts.

### API Details (confirmed via live testing)

- **Endpoint**: `GET https://platform.minimax.io/v1/api/openplatform/coding_plan/remains?GroupId={GROUP_ID}`
- **Auth**: `Authorization: Bearer {API_KEY}` (coding plan API key, prefix `sk-cp-`)
- **Response**:
```json
{
  "model_remains": [
    {
      "start_time": 1772841600000,
      "end_time": 1772859600000,
      "remains_time": 5840040,
      "current_interval_total_count": 1500,
      "current_interval_usage_count": 1486,
      "model_name": "MiniMax-M2"
    },
    { "model_name": "MiniMax-M2.1", ... },
    { "model_name": "MiniMax-M2.5", ... }
  ],
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

### Auth in piAuth
- Key: `piAuth['minimax']` with `type: "api_key"` and `key` field
- GroupId: Not in piAuth — needs env var `MINIMAX_GROUP_ID` or config field `providerSettings.minimax.groupId`

## Goals

- Fetch Minimax Coding Plan usage and expose per-model windows (e.g., "MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5")
- Disabled by default (added to `DEFAULT_DISABLED_PROVIDERS`)
- GroupId configurable via `MINIMAX_GROUP_ID` env var or `providerSettings.minimax.groupId` in model-selector config
- Follow all existing patterns (fetcher, credential check, registration, docs, tests)

## Tasks

- [ ] **1. Add `"minimax"` to provider lists** (`src/types.ts`)
  - Add `"minimax"` to `ALL_PROVIDERS` array
  - Add `"minimax"` to `DEFAULT_DISABLED_PROVIDERS` array

- [ ] **2. Create fetcher** (`src/fetchers/minimax.ts`)
  - `resolveMinimaxApiKey(piAuth)`: Check `MINIMAX_API_KEY` env var, then `piAuth['minimax'].access` / `.key`
  - `resolveMinimaxGroupId(configGroupId?)`: Check `MINIMAX_GROUP_ID` env var first, then fall back to `configGroupId` parameter
  - `fetchMinimaxUsage(piAuth, groupId?)`: Main fetcher function
    - Return error snapshot if no API key or no GroupId
    - Call `GET URLS.MINIMAX_CODING_PLAN` with Bearer auth
    - Validate `base_resp.status_code === 0`
    - Map each `model_remains` entry to a `RateWindow`:
      - `label`: model name (e.g., "MiniMax-M2")
      - `usedPercent`: `(usage_count / total_count) * 100`
      - `resetsAt`: `new Date(end_time)`
      - `resetDescription`: use `formatReset(new Date(end_time))`
    - Return `UsageSnapshot` with `provider: "minimax"`, `displayName: "Minimax"`
  - Reuse: `fetchWithTimeout`, `formatReset` from `src/fetchers/common.ts`

- [ ] **3. Add URL constant** (`src/fetchers/common.ts`)
  - Add `MINIMAX_CODING_PLAN: "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains"` to `URLS`
  - Add `minimax: "Minimax"` to `PROVIDER_DISPLAY_NAMES`

- [ ] **4. Register fetcher** (`src/usage-fetchers.ts`)
  - Import `fetchMinimaxUsage`
  - Add to `fetchers` array: `{ provider: "minimax", fetch: () => fetchMinimaxUsage(piAuth, providerSettings?.minimax?.groupId) }`
  - Re-export at bottom

- [ ] **5. Add credential check** (`src/credential-check.ts`)
  - Add `minimax: "Minimax"` to `PROVIDER_LABELS`
  - Add credential check: dynamic import of `resolveMinimaxApiKey` from fetcher, similar to zai pattern

- [ ] **6. Add `providerSettings` to config** (`src/types.ts` + `src/config.ts` + `src/usage-fetchers.ts`)
  - **`src/types.ts`**: Add `ProviderSettings` interface and add to `LoadedConfig`:
    ```typescript
    export interface MinimaxSettings { groupId?: string; }
    export interface ProviderSettings { minimax?: MinimaxSettings; }
    // In LoadedConfig:
    providerSettings: ProviderSettings;
    ```
  - **`src/config.ts`**: Parse `providerSettings` from config shape (both global and project, project overrides global). Validate and extract `minimax.groupId` as string.
  - **`src/usage-fetchers.ts`**: Add `providerSettings` parameter to `fetchAllUsages()` signature, pass `providerSettings.minimax?.groupId` to `fetchMinimaxUsage()`.
  - **Config example** (`config/model-selector.example.json`): Add example `providerSettings` section.
  - This pattern is extensible — future providers can add their own settings interfaces to `ProviderSettings`.
  - Example config:
    ```json
    {
      "providerSettings": {
        "minimax": { "groupId": "2030094413891379456" }
      }
    }
    ```

- [ ] **7. Create documentation** (`docs/minimax.md`)
  - Overview, authentication (env var + piAuth), GroupId configuration, API endpoint, usage windows, logic details

- [ ] **8. Add tests** (`tests/minimax.test.ts`)
  - Mock `fetchWithTimeout` (or global `fetch`)
  - Test: successful response with multiple models → correct windows
  - Test: no API key → error snapshot
  - Test: no GroupId → error snapshot
  - Test: HTTP error → error snapshot
  - Test: API error (`status_code !== 0`) → error snapshot
  - Test: `usedPercent` calculation accuracy
  - Test: reset time calculation from `end_time`

- [ ] **9. Update `AGENTS.md`**
  - Add `minimax.ts` to the fetchers list in Key Files section

- [ ] **10. Update `fetchAllUsages` callers** (`src/selector.ts`, `src/wizard.ts`, `index.ts`)
  - Pass `providerSettings` from `LoadedConfig` to `fetchAllUsages()` at each call site

## Verification

1. `npm run test` — all existing + new tests pass within 1 second
2. `npx tsc --noEmit` — no type errors
3. `npx biome check` — no lint errors
4. Manual: enable minimax provider, configure GroupId, run `/model-select` and verify Minimax windows appear in widget

## Risks & Considerations

- **GroupId requirement**: Unlike other providers, Minimax needs an extra GroupId parameter. If not configured, fetcher returns a clear error message guiding the user.
- **Coding Plan key vs regular API key**: The coding plan endpoint only works with `sk-cp-` prefixed keys. If a user has a regular Minimax API key, the endpoint will likely return an error — the error snapshot will surface this.
- **Rolling window**: The `end_time` in the response represents the window end, and `remains_time` is ms until reset. We use `end_time` for `resetsAt` since it's an absolute timestamp.
- **Shared quota across models**: All models in the response currently share the same usage counts (confirmed in live test). Users can use `combine` mappings if they want to treat them as one, or map individual model windows to specific pi models.
