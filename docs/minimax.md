# Minimax

The `minimax` provider supports fetching usage data from the Minimax Coding Plan API.

## Authentication

Pi resolves the Minimax API key from its provider auth state, which includes `auth.json` and `MINIMAX_API_KEY`. The extension uses that resolved key for the quota request, so you do not need to copy credentials into model-selector configuration.

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

- Minimax usage is discovered automatically when Pi has a configured Minimax provider.
- The `end_time` in the API response represents the end of the current usage interval, which is used to calculate the `resetsAt` time.
