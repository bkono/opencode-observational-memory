# OM Roadmap Summary

Short planning view for potential larger Observational Memory refactors.

## Goal
Keep long-session quality high while improving determinism, resilience, and token efficiency.

## Current State (Done)

- Bounded unobserved-tail pruning
- Duplicate-guarded observation merge
- Mastra-style anti-repeat observer prompt
- `<system-reminder>` continuation formatting
- ID+timestamp cursor fallback with safe latest-message floor
- Cycle/prune telemetry in `om_status`

## Proposed Phases

## Phase 1 — Deterministic Core

### Deliver
- Single OM orchestrator/state machine across all hook entrypoints

### Why
- Removes ordering ambiguity and cross-hook drift
- Simplifies future enhancements

### Success signal
- Same behavior regardless of whether cycle is entered via idle, chat transform, or compaction

---

## Phase 2 — Merge Correctness + Token Control

### Deliver
- Section-aware observation merge (date/topic/thread-aware replace-in-place)

### Why
- Prevents subtle stale/duplicate accumulation beyond substring checks
- Improves long-session token stability

### Success signal
- Overlap-heavy sessions do not grow duplicate memory sections

---

## Phase 3 — Throughput Smoothing

### Deliver
- Async pre-threshold buffering (`bufferActivation`, `bufferTokens`) with in-flight dedupe

### Why
- Avoids large “catch-up” observation spikes
- Smoother turn latency on long/bursty sessions

### Success signal
- Fewer large observation cycles; steadier token profile

---

## Phase 4 — Budget Optimization

### Deliver
- Shared dynamic token budget between observation block and recent tail

### Why
- Better context utilization under pressure
- Reduces starvation of either memory summary or recent turns

### Success signal
- Better answer quality near context limits with stable prune behavior

---

## Phase 5 — Resilience Hardening

### Deliver
- Per-step persistence / turn journaling and restart-safe replay semantics

### Why
- Safer handling of interruptions/retries
- Better auditability for odd edge cases

### Success signal
- No re-observe/re-prune anomalies after interrupted cycles

---

## Phase 6 — Optional Scope Expansion

### Deliver
- Multi-thread / cross-thread memory scoping policies

### Why
- Better boundary correctness for forks/parallel threads

### Success signal
- Cross-thread contamination reduced without losing useful shared context

---

## Guardrails (Must Keep)

- Keep bounded-tail pruning behavior
- Never fall back to full-history replay on uncertain boundaries
- Require telemetry exposure for any new decision policy
- Add regression checks for duplicate/stale memory reappearance

## Recommendation
Given recent successful long-session performance, prioritize **Phase 1 + Phase 2** first; defer Phases 3–6 until real pain signals appear.