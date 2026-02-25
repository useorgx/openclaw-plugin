# WS1 Slice Discovery: Dispatch Triage

- Slice run: `476f84ea-99c1-42c0-a3eb-06325185f042`
- Initiative: `aa6d16dc-d450-417f-8a17-fd89bd597195`
- Workstream: `76c9ffd4-d416-484b-ac39-69dfbe052486`
- Focus task: `aeb1cbb3-cc0f-4a46-ae3d-9343cb4f05d0` (G1.1 Discovery)
- Date: `2026-02-24`

## Scope

Read-only triage of spawn and dispatch execution paths:

- `scripts/run-codex-dispatch-job.mjs`
- `src/http/helpers/dispatch-lifecycle.ts`

## Findings

1. Spawn guard block handling is implemented in both dispatch layers and includes task blocking + decision escalation.
- Script path blocks tasks on failed guard and can open a decision (`decision_on_block=true`) with guard payload metadata.
- HTTP helper path also blocks entities and can create v2 decisions with structured evidence.

2. Progress reporting is resilient in helper lifecycle code.
- `emitActivitySafe` retries unknown `run_id` activity emission by replaying as `correlation_id`.
- When API calls fail, activity is appended to outbox for eventual replay, preserving operator visibility.

3. Primary triage risk: duplicated spawn-guard/decision logic between script and helper can drift over time.
- Both layers summarize block reason and emit activity separately.
- Divergence risk is behavioral inconsistency in decision wording and metadata over future edits.

## Suggested Next Fix Slice

Unify spawn-guard block event construction into one shared helper and call it from both dispatch entrypoints; then add one contract test asserting identical decision/event payload keys for a blocked guard outcome.

## Verification

Command executed:

```bash
node --test tests/jobs/run-codex-dispatch-job.test.mjs tests/http/dispatch-lifecycle.test.mjs
```

Result:
- 29 tests passed
- 0 failed

