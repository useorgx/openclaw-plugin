# Runtime Behavior Enforcement: Guardrails & Rollback Discovery (Slice 9d5d47e1)

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)  
Workstream: Runtime Behavior Enforcement (`853d6b1c-be7f-4bad-8dfa-eb3fe3d9c834`)

## Scope

Document current guardrail enforcement and rollback capabilities in the plugin runtime path, then identify concrete gaps for implementation.

## Current Guardrails (verified)

1. Dispatch spawn-guard enforcement blocks execution and raises decisions.
- `src/http/helpers/dispatch-lifecycle.ts:858` enforces spawn guard before dispatch.
- `src/http/helpers/dispatch-lifecycle.ts:903` emits rate-limit vs blocked events.
- `src/http/helpers/dispatch-lifecycle.ts:939` updates blocked task status and syncs rollups when non-retryable.
- `src/http/helpers/dispatch-lifecycle.ts:957` creates blocking OrgX decisions with evidence payloads.

2. Auto-continue lane flow enforces guardrails during autonomous slices.
- `src/http/helpers/auto-continue-engine.ts:2539` stores lane `rate_limited` state with retry timing.
- `src/http/helpers/auto-continue-engine.ts:2615` marks primary task blocked on non-retryable spawn-guard denial.
- `src/http/helpers/auto-continue-engine.ts:2664` requests blocking decision (`autopilot_spawn_guard_block`) with evidence refs.

3. Decision strictness has an environment guardrail.
- `src/http/helpers/dispatch-lifecycle.ts:41` supports `DECISION_EVIDENCE_REQUIRED_FOR_BLOCKING`.
- `src/http/helpers/dispatch-lifecycle.ts:439` downgrades blocking decisions when evidence is missing under strict mode.

4. Dispatch job has operational backpressure guardrails.
- `scripts/run-codex-dispatch-job.mjs:1468` computes resource throttling.
- `scripts/run-codex-dispatch-job.mjs:2123` emits throttle activity and pauses additional spawn.
- `scripts/run-codex-dispatch-job.mjs:2327` classifies spawn-guard block vs retry behavior per task.

## Current Rollback Coverage (verified)

1. Skill pack policy rollback exists and is audited.
- `src/skill-pack-state.ts:312` exposes `rollbackSkillPackPolicy`.
- `src/skill-pack-state.ts:339` writes `policy.rollback` audit entries with `rollbackOfAuditId`.
- `tests/contracts/skill-pack-schema.test.mjs:170` validates rollback restores prior policy and persists audit history.

## Gaps for Guardrails & Rollback Milestone

1. No runtime execution rollback primitive for a slice run.
- Dispatch and auto-continue flows block/retry but do not capture rollback checkpoints per task/run before mutation.
- No direct integration found with run checkpoint restore paths during guardrail-triggered failures.

2. Block remediation is decision-centric, not recovery-centric.
- Current handling asks for manual unblock decisions, but does not provide a deterministic "restore last-known-good state" action in the same flow.

3. Rollback telemetry is policy-only.
- Skill-pack policy rollback is audited, but runtime rollback events (checkpoint created/restored) are not represented as first-class structured activity in the slice execution path.

## Implementation Targets (next slice)

1. Introduce pre-mutation runtime checkpoints in the autonomous execution path.
- Capture checkpoint metadata before status/artifact mutations for each launched slice task.

2. Add guarded rollback path for non-retryable spawn-guard failures.
- On qualifying failures, optionally restore latest checkpoint and emit structured `rollback_applied` activity.
- Keep strict idempotency and avoid automatic rollback loops.

3. Extend decision payloads with rollback options.
- Include explicit actions: `restore_last_checkpoint`, `approve_exception`, `reassign`.
- Preserve existing dedupe keys and evidence requirements.

## Verification Evidence

Commands used in this slice:
- `rg -n "spawn_guard|rollback|checkpoint|rate_limited" src/http/helpers/dispatch-lifecycle.ts src/http/helpers/auto-continue-engine.ts src/skill-pack-state.ts`
- `sed -n '840,1040p' src/http/helpers/dispatch-lifecycle.ts`
- `sed -n '280,380p' src/skill-pack-state.ts`
- `rg -n "spawnGuard|resource guard|rollback|checkpoint|throttle|retry|blocked" scripts/run-codex-dispatch-job.mjs`

Outcome:
- Guardrail and rollback behavior documented with code-level anchors.
- Gaps and implementation targets narrowed to runtime checkpoint + rollback enforcement.
