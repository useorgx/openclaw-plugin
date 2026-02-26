# WS1 Slice 85270e0e: Outbox Replay Progress Fallback Verification

Date: 2026-02-26
Initiative: init-1
Workstream: ws-1
Task focus: task-ws1-running

## Objective
Verify that outbox replay for progress events preserves `run_id` on first submission and falls back to deterministic `correlation_id` only when OrgX returns a 404 run-not-found response.

## Evidence Collected
- Test file: `tests/outbox-replay-progress-runid.test.mjs`
- Command:

```bash
npm run test:file -- tests/outbox-replay-progress-runid.test.mjs
```

- Result: 3/3 tests passing
  - `progress replay keeps run_id first and falls back to correlation_id on 404 run-not-found`
  - `progress replay fallback also handles HTTP-prefixed 404 run-not-found errors`
  - `retro replay normalizes structured retro payload before submit`

## Outcome
Verification passed for this slice. No additional code changes were required in this run because the current implementation and regression tests already satisfy expected behavior.
