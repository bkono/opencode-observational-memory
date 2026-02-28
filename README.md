# OpenCode Observational Memory Plugin

Mastra-style observational memory for OpenCode sessions.

## What it does

- Tracks unobserved session messages.
- Runs an **observer** model pass when unobserved message tokens cross threshold (default: `30_000`).
- Persists observations per session under `.opencode/om-state`.
- Runs a **reflector** compaction pass when observation-log tokens cross threshold (default: `40_000`).
- Injects stored memory into chat system context via OpenCode hooks.

## Defaults

- Observation threshold: `30_000` message tokens
- Reflection threshold: `40_000` observation tokens
- Observation model: `google/gemini-2.5-flash`
- Reflection model: `google/gemini-2.5-flash`
- Tokenizer: `js-tiktoken` `o200k_base`

## Configuration

The plugin reads config from:

1. Global: `~/.config/opencode/om-config.json`
2. Project: `<worktree>/.opencode/om-config.json`

Project config overrides global config.

### Config shape

```json
{
  "observation": {
    "messageTokens": 30000,
    "model": "google/gemini-2.5-flash",
    "customInstruction": "optional"
  },
  "reflection": {
    "observationTokens": 40000,
    "model": "google/gemini-2.5-flash",
    "customInstruction": "optional"
  },
  "api": {
    "baseURL": "optional",
    "apiKey": "optional"
  },
  "storage": {
    "stateDir": "optional"
  }
}
```

## API key resolution

Priority order:

1. `api.apiKey` in config
2. `OM_API_KEY`
3. `OPENAI_API_KEY`

Optional base URL:

1. `api.baseURL` in config
2. `OM_API_BASE_URL`

## OpenCode hooks used

- `event` (`session.created`, `session.idle`)
- `experimental.chat.messages.transform`
- `experimental.chat.system.transform`
- `experimental.session.compacting`

## Diagnostic tools

- `om_status`
  - Returns session memory status, thresholds, unobserved counts/tokens, and task hints.
- `om_observations`
  - Returns stored observation blocks for the session.

Both tools accept optional `session_id`.

## Build and verify

```bash
npm run typecheck
npm run build
```
