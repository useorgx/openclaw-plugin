# OrgX FSD Orchestrator Verification Matrix v1

Last updated: 2026-03-05  
Status: Required before canonical cutover

## Summary

This matrix defines the minimum evidence required to prove the single-authority orchestration architecture works in production conditions.

Pass condition:

- All P0 and P1 cases pass
- Shadow comparator thresholds pass for 7 days
- No unresolved severity-1 continuity incidents

## Test Categories

## 1) Invariant Tests (P0)

1. `dispatch` continuity:
   - Given: slice in Next Up
   - When: dispatch command accepted
   - Then: same `slice_id` appears in In Progress within p95 < 300ms

2. terminal transition integrity:
   - Given: run reaches terminal completion
   - Then: slice exits In Progress and appears in Completed with same lineage

3. activity causality:
   - Given: run state transition event
   - Then: corresponding Activity row links via `correlation_id` and `run_id`

4. count parity:
   - `projection_in_progress.active_count` equals active run rows from kernel state

5. idempotent command handling:
   - duplicate `command_id` / same `idempotency_key` causes one applied transition

## 2) Contract Tests (P0)

1. command accept/reject schema
2. query projection envelope schema:
   - `projection_version`
   - `as_of_offset`
   - pagination fields
3. lineage contract:
   - every row has `initiative_id`
   - scope-appropriate IDs present (`workstream_id`, `milestone_id`, `task_id` where applicable)

## 3) Reconciliation and Retry Chaos Tests (P0)

1. executor process crash during active run
   - expected: run marked `stalled`, retry scheduled with typed reason

2. heartbeat loss > lease window
   - expected: claim expiry triggers reconcile action and deterministic retry path

3. slot exhaustion
   - expected: retry requeued with reason `resource_throttle`, no duplicate run launch

4. tracker/source transient failure
   - expected: reconcile continues on next tick, no state corruption

## 4) UX E2E Workflow Tests (P1)

1. Next Up to In Progress to Completed flow:
   - queue item dispatch
   - live progress visibility
   - completion visibility with artifact links

2. Autopilot persistence:
   - toggle on
   - refresh client
   - verify persisted policy state and indicator parity

3. Activity detail integrity:
   - click timeline event
   - open modal
   - validate no truncation, proper lineage, actionable controls

4. Decision/blocker intervention:
   - blocker event appears with clear action
   - decision resolution unblocks dispatch path

5. mobile parity (375px):
   - same continuity and intervention affordances on mobile layout

## 5) Shadow Comparator Gates (P0)

Window: 7 days continuous.

Thresholds:

1. state mismatch rate old vs new projections < 0.5%
2. running count mismatch < 0.1%
3. command->projection p95 < 300ms
4. zero severity-1 continuity regressions

Shadow logging fields:

- command_id
- slice_id
- run_id
- old_state
- new_state
- mismatch_type
- detection_timestamp

## 6) Monitoring and Alert Rules (P0)

1. alert: accepted command without state transition in 5s
2. alert: running row heartbeat stale > 30s
3. alert: projection lag > 1s sustained for 5m
4. alert: count parity failure sustained for 3 ticks

## 7) Rollback Validation (P0)

1. flip projection source to legacy in < 60s
2. commands continue to append to ledger
3. re-enable canonical source without data loss
4. produce post-rollback mismatch report

## 8) Test Execution Matrix

| Category | Environment | Owner | Frequency | Gate |
|---|---|---|---|---|
| Invariants | staging + prod shadow | orchestration | on deploy + hourly | hard |
| Contracts | CI | platform | every PR | hard |
| Chaos | staging | reliability | nightly | hard |
| UX E2E | staging | frontend + QA | daily | hard before cutover |
| Shadow compare | prod shadow | platform | continuous | hard |
| Rollback drill | staging then prod safe window | SRE | pre-cutover + monthly | hard |

## 9) Evidence Requirements

For each gate run:

1. command logs and response payloads
2. projection snapshots with `as_of_offset`
3. mismatch report artifact
4. timing histogram (p50/p95/p99)
5. UI screenshot/video evidence for user-visible paths

Evidence artifacts must be linked to the OrgX initiative under verification milestones.

