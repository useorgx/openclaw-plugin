# G2.1 Discovery: Decision Creation Mid-Execution

Date: 2026-02-25
Workstream: Decision Gate Flow (`ea90bdd6-f2d5-4b8e-999a-42617ae6a547`)
Slice: `eeb86eb0-257f-48a1-9419-cc101aa90a05`

## Scope
Document the current autopilot decision-gate behavior and identify the smallest implementation slice for "decision creation mid-execution".

## Verified Current Behavior

### 1) Slice output decisions are converted into OrgX `decision.create` operations
- Source: `src/http/helpers/auto-continue-engine.ts` (slice result handling block)
- Behavior:
  - Parses `decisions_needed[]` from slice JSON output.
  - Applies default blocking policy based on status:
    - `completed` => default non-blocking
    - all other statuses => default blocking
  - Calls `requestDecisionQueued(...)` for each decision with dedupe keys + evidence refs.

### 2) Status normalization is already implemented before queuing decisions
- Source: `src/http/helpers/auto-continue-engine.ts`
- Behavior:
  - `completed` + blocking decisions => normalized to `needs_decision`
  - `needs_decision` + zero blocking decisions => normalized to `completed`

### 3) Fallback blocking decision is synthesized when blocked/error has no blocking decision payload
- Source: `src/http/helpers/auto-continue-engine.ts`
- Behavior:
  - If slice is blocked/error and no blocking decision was queued, engine creates a fallback blocking decision with retry/pause/skip options.

### 4) Lifecycle tests cover decision-first semantics and fallback creation
- Source: `tests/http/autopilot-slice-lifecycle.test.mjs`
- Verified scenarios:
  - `needs_decision` creates blocking decision and marks decision-required metadata.
  - blocked without decision payload synthesizes a fallback blocking decision.
  - optional/non-blocking decisions preserve completed status.
  - completed-without-outputs generates a follow-up verification decision and stops run as blocked.

## Gap Relative to G2.1 "Mid-Execution"
Current decision creation is concentrated in the "slice finished" path. There is no explicit mid-execution hook that can emit a decision while a slice is still running.

## Smallest Safe Implementation Slice (proposed)
1. Add a mid-execution event channel in the auto-continue engine that listens for decision-intent signals while worker output/log streaming is active.
2. Reuse existing `requestDecisionQueued(...)` path for idempotent queueing (same dedupe/evidence patterns).
3. Persist emitted mid-execution decision IDs on slice runtime state to prevent duplicate queueing at finalization.
4. Add focused lifecycle tests for:
- "mid-execution decision signal queues blocking decision before completion"
- "same decision signal is deduped between mid-execution + final output"

## Risk Notes
- Duplicate decision creation risk is highest; dedupe key design must include run/workstream + normalized question + signal source.
- Mid-execution blocking behavior needs policy clarity: pause only current lane vs stop whole auto-continue run.
