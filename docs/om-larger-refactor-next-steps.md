# Observational Memory: Larger Refactor Next Steps

This document captures the **larger architecture refactors** discussed but not implemented, plus the expected benefits over the current state.

## Current Baseline (Already Implemented)

- Bounded message tail in `experimental.chat.messages.transform`.
- Observation duplication guard (append/replace containment checks).
- Mastra-style observer anti-repeat prompting and `<system-reminder>` formatting.
- Cursor hardening with `lastObservedMessageId` + `lastObservedMessageAt` + safe latest-message fallback.
- Cycle telemetry in `om_status` (cursor mode, prune counts/tokens, observe/reflect flags).

This baseline is already solid for long sessions and provides useful operational visibility.

---

## Potential Larger Refactors (Not Yet Implemented)

## 1) Single OM Orchestrator (State-Machine Pipeline)

### What it is
Replace distributed hook-local logic with one explicit OM pipeline:

1. Load state + resolve unobserved window
2. Evaluate thresholds/buffer policy
3. Run observe/reflect transitions
4. Inject memory context
5. Prune active messages
6. Persist final state/metrics

### What we skipped
- A dedicated orchestrator module and phase model
- Deterministic phase ordering guarantees across all hook entrypoints

### Benefit over current state
- Eliminates cross-hook drift and ordering ambiguity
- Easier to reason about lifecycle and failure recovery
- Cleaner future feature additions (budgeting, buffering, multi-thread context)

### Cost / risk
- Medium complexity increase
- Requires careful migration to avoid behavior regressions

---

## 2) Async Buffering Before Threshold (Mastra-style)

### What it is
Observe in background when pending messages reach a configurable fraction of threshold (e.g. 50%), instead of waiting for hard threshold crossing.

### What we skipped
- `bufferActivation` and `bufferTokens` settings
- Background buffering operation registry/de-dupe

### Benefit over current state
- Smoother token profile (fewer large observation spikes)
- Better latency under long runs with bursty turns
- Reduces “big catch-up” observe passes

### Cost / risk
- More concurrency/state edge cases
- Requires robust de-duplication for in-flight buffer jobs

---

## 3) Dynamic Shared Token Budget (Observations vs Tail)

### What it is
Use a shared budget policy where observation block size and retained recent tail flex based on current conditions, instead of static behavior.

### What we skipped
- Configurable shared-budget policy (hard cap + allocation strategy)
- Runtime budget manager for each cycle

### Benefit over current state
- Better context utilization under varying workloads
- Fewer cases where either observations or recent messages starve the other
- Improved quality near high-context limits

### Cost / risk
- Additional tuning surface
- Must keep policy predictable and debuggable

---

## 4) Section-Aware Observation Merge (Beyond Substring Guard)

### What it is
Upgrade merge logic to operate on structured sections (date/thread/topic blocks) with replace-in-place semantics and overlap resolution.

### What we skipped
- Structured parser/merger for observation sections
- Stronger loop/degenerate-output detection and cleanup

### Benefit over current state
- Better prevention of subtle duplication/staleness
- Lower observation token growth over very long sessions
- Safer incremental updates when observer outputs partial-overlap blocks

### Cost / risk
- Parser complexity and format contract sensitivity
- Needs regression tests for merge edge cases

---

## 5) Per-Step Persistence / Turn Journaling

### What it is
Persist turn-level OM intermediate state so partial turns, retries, or interruptions do not lose or reprocess message chunks.

### What we skipped
- Step journal schema
- Recovery and replay semantics after interrupted cycles

### Benefit over current state
- Stronger crash/interruption resilience
- Less chance of re-observe/re-prune anomalies after retries
- Better forensic traceability for debugging odd sessions

### Cost / risk
- Higher persistence volume and complexity
- More migration/versioning responsibility for state format

---

## 6) Multi-Thread / Cross-Thread Memory Scoping

### What it is
Support thread-scoped sections and optional cross-thread context merge policies.

### What we skipped
- Thread-aware observation sectioning
- Scope policy (`thread-only`, `resource-shared`, weighted merge)

### Benefit over current state
- Better correctness for forked or parallel workstreams
- Cleaner memory boundaries between unrelated tasks

### Cost / risk
- Significant model/prompt and storage complexity
- Higher chance of UX confusion without strong tooling

---

## Suggested Implementation Order (Pragmatic)

1. **Single OM orchestrator** (foundation)
2. **Section-aware merge** (correctness + token control)
3. **Async buffering** (latency smoothing)
4. **Dynamic shared budget** (context optimization)
5. **Per-step persistence** (resilience)
6. **Multi-thread scoping** (only if product need is concrete)

---

## Do Not (to avoid regressions)

- Do not remove bounded-tail pruning.
- Do not reintroduce full-history fallback when cursor resolution is uncertain.
- Do not add async buffering without in-flight de-duplication.
- Do not add budget logic without exposing decision telemetry in `om_status`.

---

## Acceptance Signals for Any Refactor

- Context usage forms a stable sawtooth pattern under long sessions.
- `om_status` explains each cycle decision (cursor mode, pruning effect, observe/reflect triggers).
- Duplicate/stale observation blocks do not reappear under overlap-heavy sessions.
- No regression in long-session UX quality (like the recent successful multi-doc Opus run).
