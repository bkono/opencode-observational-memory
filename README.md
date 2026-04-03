# OpenCode Observational Memory Plugin

OpenCode plugin implementing [Mastra-inspired observational memory](https://mastra.ai/docs/memory/observational-memory). Who doesn't love limitless context windows?

Observational memory compresses raw conversation history into dense observations using an observer/reflector pattern, so your agent maintains continuity across compaction boundaries and long-running sessions with zero vector DBs or knowledge graphs required.

## Quick Start

### Install

```bash
npm install @solvedbydev/opencode-observational-memory
```

### Add to OpenCode

In your project's `opencode.json`:

```json
{
  "plugin": ["@solvedbydev/opencode-observational-memory"]
}
```

### Set an API Key

The plugin calls an OpenAI-compatible LLM to extract and consolidate observations. Provide a key via environment variable:

```bash
export OM_API_KEY="your-api-key"
# or fall back to:
export OPENAI_API_KEY="your-api-key"
```

That's it. The plugin runs automatically with no code changes required.

### Limit to Specific Agents

By default, observational memory applies to all agents. To restrict it to specific agents by name:

```json
// .opencode/om-config.json
{
  "agents": ["sketch", "plan", "coordinate"]
}
```

Or via environment variable:

```bash
export OM_AGENTS="sketch,plan,coordinate"
```

Non-listed agents (workers, reviewers, etc.) run with zero OM overhead — no observer LLM calls, no system prompt injection, no message pruning.

## How It Works

The plugin hooks into OpenCode's event and chat lifecycle to maintain a persistent memory layer:

1. **Observe** - When unobserved message tokens exceed a threshold (default: 30k), an observer agent extracts key facts, decisions, and context from new messages.
2. **Reflect** - When accumulated observation tokens exceed a second threshold (default: 40k), a reflector agent consolidates and compresses observations, removing redundancy while preserving meaning.
3. **Inject** - Observations are injected into the system prompt and message context on every turn, giving the LLM continuity even after compaction discards raw history.

```
session.idle / messages.transform
  |
  +-- unobserved tokens >= threshold?
  |     yes -> Observer extracts observations
  |             |
  |             +-- observation tokens >= threshold?
  |                   yes -> Reflector consolidates
  |
  +-- observations injected into system prompt & messages
```

### Observer / Reflector Pattern

Two specialized LLM agents coordinate memory:

- **Observer**: Reads new message history plus existing observations. Extracts discrete facts, decisions, preferences, and working context. Also tracks `currentTask` and `suggestedResponse` for session continuity.
- **Reflector**: Takes the full observation log when it grows too large. Compresses it by removing duplication, merging related items, and prioritizing recent/actionable information.

Both agents use configurable models (default: `google/gemini-2.5-flash`) and support custom instructions for domain-specific extraction.

## Configuration

Configuration merges from multiple sources (highest precedence first):

1. **Environment variables** -- `OM_AGENTS`, `OM_API_KEY`, `OM_OBSERVATION_MODEL`, `OM_OBSERVATION_MESSAGE_TOKENS`, `OM_REFLECTION_MODEL`, `OM_REFLECTION_OBSERVATION_TOKENS`, `OM_API_BASE_URL`
2. **Project config** - `<worktree>/.opencode/om-config.json`
3. **Global config** - `~/.config/opencode/om-config.json`
4. **Built-in defaults**

### Example Config

```json
{
  "agents": ["sketch", "plan", "coordinate"],
  "observation": {
    "messageTokens": 30000,
    "model": "google/gemini-2.5-flash",
    "customInstruction": "Focus on architectural decisions and rejected alternatives."
  },
  "reflection": {
    "observationTokens": 40000,
    "model": "google/gemini-2.5-flash",
    "customInstruction": ""
  },
  "api": {
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKey": "sk-..."
  },
  "storage": {
    "stateDir": ".opencode/om-state"
  }
}
```

### Config Reference

| Key | Default | Env Override | Description |
|-----|---------|-------------|-------------|
| `agents` | `"all"` | `OM_AGENTS` | Agent names to apply OM to, or `"all"`. Env accepts comma-separated names. |
| `observation.messageTokens` | `70000` | `OM_OBSERVATION_MESSAGE_TOKENS` | Token threshold to trigger observation |
| `observation.model` | `google/gemini-2.5-flash` | `OM_OBSERVATION_MODEL` | Model for the observer agent |
| `observation.customInstruction` | -- | -- | Additional instruction injected into observer prompt |
| `reflection.observationTokens` | `50000` | `OM_REFLECTION_OBSERVATION_TOKENS` | Token threshold to trigger reflection |
| `reflection.model` | `google/gemini-2.5-flash` | `OM_REFLECTION_MODEL` | Model for the reflector agent |
| `reflection.customInstruction` | -- | -- | Additional instruction injected into reflector prompt |
| `api.baseURL` | -- | `OM_API_BASE_URL` | OpenAI-compatible base URL |
| `api.apiKey` | -- | `OM_API_KEY` > `OPENAI_API_KEY` | API key for LLM calls |
| `storage.stateDir` | `<worktree>/.opencode/om-state` | -- | Directory for session state JSON files |

### Debug Mode

Set `OM_DEBUG=1` to enable verbose logging to stderr for observation cycles, token counts, and state persistence.

## Tools

The plugin registers two tools available to the LLM during sessions:

### `om_status`

Returns current session memory metrics: observation token counts, thresholds, cursor mode, unobserved message count, cycle history, current task, and suggested response.

### `om_observations`

Writes the stored observation block for the session to a temp file and returns the path. The dump includes `<observations>`, `<current-task>`, and `<suggested-response>` sections.

## Why Observational Memory?

Even models with large context windows degrade as the window fills. More raw history means more noise, worse adherence to instructions, and wasted tokens on content the agent no longer needs. Mastra calls these **context rot** and **context waste** and [their observational memory system](https://mastra.ai/docs/memory/observational-memory) addresses both.

The idea mirrors how human memory works: you don't remember every word of every conversation. You observe what happened, then your brain reflects by reorganizing, combining, and condensing into long-term memory. OM works the same way, compressing raw context into dense observations (typically 5-40x compression) that keep the agent on task over arbitrarily long sessions.

The result is a context window with three tiers:

1. **Recent messages** - exact conversation history for the current task
2. **Observations** - a dense log of what the observer has extracted
3. **Reflections** - condensed observations when the log itself grows too large

For deeper background, see [Mastra's observational memory docs](https://mastra.ai/docs/memory/observational-memory) and their [announcement post](https://mastra.ai/blog/observational-memory) covering the design rationale and LongMemEval benchmark results.

This plugin adapts the pattern for OpenCode's plugin hook system:

- Runs as an OpenCode plugin (event hooks + chat transforms) rather than framework middleware
- Text-based append-log with token-aware compaction, no vector DB or external storage needed
- Tracks `currentTask` and `suggestedResponse` for richer session continuity across compaction
- Supports independent custom instructions for observer and reflector agents

## Plugin Lifecycle

The plugin registers handlers at these OpenCode extension points:

| Hook                                   | Trigger              | Action                                                               |
| -------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `session.created`                      | New session          | Initialize/load session state from disk                              |
| `chat.message`                         | Message received     | Track current agent name per session for agent filtering             |
| `session.idle`                         | No active processing | Run observation cycle if thresholds met (enabled agents only)        |
| `experimental.chat.messages.transform` | Before LLM call      | Prune messages to unobserved window; run observation cycle           |
| `experimental.chat.system.transform`   | Before LLM call      | Inject observations + continuation reminder into system prompt       |
| `experimental.session.compacting`      | Context compaction   | Force observation cycle; inject observations into compaction context |

## Building from Source

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # type-check without emitting
npm run clean       # rm -rf dist
```

### Source Layout

```
src/
  index.ts     Plugin entry point, event/hook handlers, tools
  agents.ts    Observer and reflector LLM agent logic
  config.ts    Configuration loading and merging
  prompts.ts   Prompt templates for observer/reflector
  state.ts     Session state persistence (JSON files)
  tokens.ts    Token counting (js-tiktoken, o200k_base)
  types.ts     TypeScript interfaces
```

### Dependencies

**Runtime**: `js-tiktoken` (token counting), `openai` (OpenAI-compatible API client)

**Dev**: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `typescript`

## License

MIT
