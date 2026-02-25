# Dispatch Progress Reporting Discovery (G1.3)

Date: 2026-02-25  
Scope: `scripts/run-codex-dispatch-job.mjs` reporting flow for execution-time progress.

## Objective

Verify whether dispatch execution already emits progress at meaningful checkpoints, and identify the smallest follow-up work needed for reliable progress visibility.

## Evidence Reviewed

- `scripts/run-codex-dispatch-job.mjs:965-1167` (`createReporter`, `emit`, `milestoneStatus`, `workstreamStatus`)
- `scripts/run-codex-dispatch-job.mjs:1362-1371` (`rollupChanged`)
- `scripts/run-codex-dispatch-job.mjs:1979-2029` (`syncParentRollups` usage for milestone/workstream updates)
- `scripts/run-codex-dispatch-job.mjs:2085-2123` (job startup emit)
- `scripts/run-codex-dispatch-job.mjs:2848-2879` (heartbeat emit)
- `scripts/run-codex-dispatch-job.mjs:2903-2928` (job completion emit)

## What Already Works

1. Startup emit exists and includes initial `progressPct` and runtime metadata.
2. Execution emits are present for key events:
   - Resource throttling
   - Behavior automation blocks
   - Spawn guard retry/fail paths
   - Task completion/failure transitions
3. Parent rollups are emitted when status or rollup metrics change (`rollupChanged` gate).
4. Heartbeat emits periodically with completed/running/queued/blocked counts.
5. Final completion emit includes summary counts and next-step guidance.
6. Reporting is intentionally best-effort and non-fatal to dispatch continuation.

## Gaps / Risks (Discovery)

1. Rollups are initialized in memory, but initial milestone/workstream rollup events are not emitted until a task transition triggers `syncParentRollups`.
2. A run that exits very quickly (or pauses early) can produce sparse intermediate telemetry even though startup/final emits exist.
3. There is no explicit per-task "spawned" progress marker before worker output begins, which can reduce traceability in high concurrency.

## Smallest Follow-up Work

1. Emit one baseline rollup snapshot for tracked milestones/workstreams immediately after rollup initialization.
2. Add a lightweight "worker_spawned" progress emit with task id, attempt, and queue/running counts.
3. Keep existing best-effort error handling behavior so reporting failures never fail the dispatch loop.

## Verification Commands Used

```bash
rg -n "orgx_report_progress|report_progress|progress" scripts/run-codex-dispatch-job.mjs src
rg -n "milestoneStatus\\(|workstreamStatus\\(|rollupChanged\\(" scripts/run-codex-dispatch-job.mjs
sed -n '900,1180p' scripts/run-codex-dispatch-job.mjs
sed -n '1320,1425p' scripts/run-codex-dispatch-job.mjs
sed -n '1880,2065p' scripts/run-codex-dispatch-job.mjs
sed -n '2065,2365p' scripts/run-codex-dispatch-job.mjs
sed -n '2840,2935p' scripts/run-codex-dispatch-job.mjs
```

## Recommendation

Discovery is complete for G1.3. Proceed with a narrow implementation PR that adds baseline rollup + worker-spawn emits, then validate via a short dry run and event log inspection.
