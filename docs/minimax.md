# Minimax

The `minimax` provider supports fetching usage data from the Minimax Coding Plan API.

## Authentication

Authentication can be configured in two ways:

1. **Environment Variable**: `MINIMAX_API_KEY` (must be a Coding Plan key, prefixed with `sk-cp-`)
2. **piAuth**: In `~/.pi/agent/auth.json` under the `minimax` key, using the `key` or `access` field.

```json
{
  "minimax": {
    "type": "api_key",
    "key": "sk-cp-..."
  }
}
```

## GroupId Configuration

The Minimax Coding Plan API requires a `GroupId` parameter. This can be configured in two ways:

1. **Environment Variable**: `MINIMAX_GROUP_ID`
2. **Provider Settings**: In your `~/.pi/model-selector.json` config file:

```json
{
  "providerSettings": {
    "minimax": {
      "groupId": "1234567890123456789"
    }
  }
}
```

## API Endpoint

The extension fetches quota information from:
`GET https://platform.minimax.io/v1/api/openplatform/coding_plan/remains?GroupId={GROUP_ID}`

## Usage Windows

Minimax's Coding Plan provides a rolling 5-hour usage window with prompt limits per model (e.g., "MiniMax-M2", "MiniMax-M2.1"). The extension creates a candidate for each `model_name` returned by the API.

## Notes

- Disabled by default. You must remove it from `disabledProviders` in your config or enable it via the `/model-select-config` wizard.
- The `end_time` in the API response represents the end of the current usage interval, which is used to calculate the `resetsAt` time.
