# Runtime Behavior Enforcement: Execution Pipeline Integration Discovery

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)  
Workstream: Runtime Behavior Enforcement (`853d6b1c-be7f-4bad-8dfa-eb3fe3d9c834`)  
Task context: Execution Pipeline Integration: Discovery (`67ff3a82-6695-485b-b4db-e6970e9e4f3b`)

## Scope

Define what is already enforced in the runtime execution pipeline, what must be integrated next, and what proof points sales can use to show enterprise-safe autonomous execution.

## Current Enforcement Surface (Code-Verified)

1. Token guardrail is explicit and operator-controlled.
- `defaultAutoContinueTokenBudget` only honors explicit budget input or `ORGX_AUTO_CONTINUE_TOKEN_BUDGET`; legacy hidden toggles are intentionally ignored.
- Evidence: `src/http/helpers/auto-continue-engine.ts:909`.

2. Autopilot halts before dispatch when token budget is exhausted.
- Guardrail check runs before selecting/starting a new workstream slice.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2029` and `src/http/helpers/auto-continue-engine.ts:2035`.

3. Concurrency is actively bounded.
- Active slice count is compared against `maxParallelSlices` prior to scheduling more work.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2041`.

4. Workstream-level targeting and verification gating exist.
- Scheduler respects `allowedWorkstreamIds` and `includeVerification` to control what can execute.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2096` and `src/http/helpers/auto-continue-engine.ts:2102`.

5. Spawn guard denial triggers hard runtime intervention.
- On non-rate-limit denial, primary task is marked blocked, parent rollups are synced, and a blocking decision is requested.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2399`, `src/http/helpers/auto-continue-engine.ts:2424`, `src/http/helpers/auto-continue-engine.ts:2437`.

6. Rollback and run controls are exposed via API and MCP.
- API supports `pause`, `resume`, `cancel`, `rollback`, and `complete`; rollback requires checkpoint ID.
- Evidence: `src/http/routes/run-control.ts:5`, `src/http/routes/run-control.ts:106`, `src/tools/core-tools.ts:361`.

## Integration Gaps To Close

1. Config provenance is not first-class in execution events.
- Need each slice dispatch/report event to include behavior config version/hash and effective policy source.

2. Guardrail evaluation outputs are not normalized as a reusable runtime contract.
- Need a structured `evaluation_result` object persisted on slice/run records for dashboard and downstream reporting.

3. Operator visibility is fragmented.
- Current state exists in activity messages and metadata, but there is no single config health view (per-agent effective config, last changed, eval pass rate).

4. Rollback readiness is mechanical, not behavior-aware.
- Need checkpoint metadata to capture config fingerprint so rollbacks can restore both execution state and behavior state coherently.

## Execution Pipeline Integration Plan (Smallest Shippable)

1. Emit behavior configuration identity at dispatch time.
- Add fields to dispatch/activity metadata:
  - `behavior_config_id`
  - `behavior_config_version`
  - `behavior_config_hash`
  - `policy_source` (`default|workstream|task|operator_override`)

2. Persist guardrail evaluation envelope per slice.
- Standard schema:
  - `allowed` (boolean)
  - `reason_code` (string)
  - `reason` (string)
  - `evaluated_at` (ISO timestamp)
  - `required_skills` (string[])
  - `domain` (string)

3. Extend mission-control/dashboard payloads with config health primitives.
- For each active agent lane and recent slice:
  - effective config version
  - last config change timestamp
  - rolling evaluation pass rate

4. Include config fingerprint in checkpoint payload.
- On checkpoint create/restore flows, store/read behavior fingerprint fields to ensure rollback consistency.

## Sales Proof Pack (What Reps Can Demonstrate)

1. Deterministic guardrails before autonomous execution.
- Demo: token budget and max parallel constraints preventing runaway execution.

2. Safe failure behavior with human escalation.
- Demo: spawn guard denial auto-blocks the task and requests a blocking decision with actionable options.

3. Reversible operations.
- Demo: checkpoint list + rollback path with explicit checkpoint requirement.

4. Governance visibility.
- Demo target: config health dashboard showing effective config and pass-rate trend per agent/workstream.

## Acceptance Signals For “Discovery Done”

1. Engineering has a concrete event/payload contract for behavior enforcement metadata.
2. Product has a clear config health dashboard data model and minimum columns.
3. Sales has a repeatable three-step demo narrative (guardrails, escalation, rollback) mapped to existing runtime behaviors.
4. No new infra required for phase 1; implementation can start in plugin runtime and dashboard payload shaping.

## Verification Steps (Executed)

1. Read guardrail/token-budget and scheduling enforcement code paths.
- `src/http/helpers/auto-continue-engine.ts:909`
- `src/http/helpers/auto-continue-engine.ts:2029`
- `src/http/helpers/auto-continue-engine.ts:2399`

2. Read run-control API route behavior.
- `src/http/routes/run-control.ts:5`
- `src/http/routes/run-control.ts:106`

3. Read MCP tool contract for rollback requirement.
- `src/tools/core-tools.ts:361`
