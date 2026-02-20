# Runtime Behavior Enforcement: Guardrails & Rollback Discovery

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)  
Workstream: Runtime Behavior Enforcement (`853d6b1c-be7f-4bad-8dfa-eb3fe3d9c834`)  
Task context: Guardrails & Rollback: Discovery (`a805350d-2b5f-4318-b3cb-f19085072a41`)

## Scope

Validate what runtime guardrails and rollback controls already exist, and isolate the smallest remaining gaps for behavior-enforcement hardening.

## Findings (Code-Verified)

1. Token guardrail behavior is explicit and non-implicit.
- `defaultAutoContinueTokenBudget()` only honors direct input or `ORGX_AUTO_CONTINUE_TOKEN_BUDGET`, and intentionally ignores legacy hidden toggles.
- Evidence: `src/http/helpers/auto-continue-engine.ts:916`, `src/http/helpers/auto-continue-engine.ts:921`.

2. Budget exhaustion stops autopilot before dispatching additional slices.
- Runtime loop checks `run.tokensUsed >= run.tokenBudget` and stops with `budget_exhausted`.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2051`.

3. Behavior approval is a hard pre-dispatch guardrail.
- When behavior config requires approval, the engine emits a blocked event, requests a blocking decision, and marks workstream lane blocked.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2318`, `src/http/helpers/auto-continue-engine.ts:2341`, `src/http/helpers/auto-continue-engine.ts:2384`.

4. Run-control rollback is available via HTTP and MCP contracts.
- HTTP run actions support rollback/cancel/pause/resume and pass `checkpointId` through to run action execution.
- MCP tool contract requires `checkpointId` for rollback and rejects rollback requests without it.
- Evidence: `src/http/routes/run-control.ts:5`, `src/http/routes/run-control.ts:106`, `src/tools/core-tools.ts:325`, `src/tools/core-tools.ts:360`.

5. Behavior policy rollback for skill packs is already implemented with audit lineage.
- Policy rollback restores `beforePolicy`, writes a `policy.rollback` audit entry, and records `rollbackOfAuditId`.
- API route validates rollback payload shape and forbids mutation fields during rollback requests.
- Evidence: `src/skill-pack-state.ts:312`, `src/skill-pack-state.ts:343`, `src/http/routes/agent-suite.ts:268`, `src/http/routes/agent-suite.ts:287`.

## Gaps Remaining (Minimal)

1. No shared guardrail evaluation envelope.
- Enforcement exists, but there is no normalized persisted object for guardrail outcomes (allow/deny, reason code, timestamp) across slice lifecycle records.

2. Rollback metadata is checkpoint-oriented, not behavior-fingerprint-oriented.
- Rollback mechanics are present, but discovery evidence does not show guaranteed behavior-config fingerprint capture on checkpoint create/restore paths.

3. Single-pane guardrail observability is incomplete.
- Signals are present in activity metadata and lane states, but no explicit consolidated operator view is documented here for guardrail pass/fail posture over time.

## Recommended Next Implementation Slice

1. Define and persist a `guardrail_evaluation` payload on slice lifecycle events.
- Minimum fields: `allowed`, `reason_code`, `reason`, `evaluated_at`, `behavior_config_id`, `behavior_config_version`, `behavior_config_hash`.

2. Include behavior fingerprint data in checkpoint payloads and restore responses.
- Ensure rollback can be validated as both execution-state and behavior-state coherent.

3. Add mission-control response shaping for guardrail posture summary.
- Minimum: latest guardrail outcome per active lane + recent failure count.

## Verification Steps Executed

1. Reviewed token budget and pre-dispatch guardrail enforcement.
- `src/http/helpers/auto-continue-engine.ts:916`
- `src/http/helpers/auto-continue-engine.ts:2051`
- `src/http/helpers/auto-continue-engine.ts:2318`

2. Reviewed rollback control contracts for API and MCP layers.
- `src/http/routes/run-control.ts:5`
- `src/http/routes/run-control.ts:106`
- `src/tools/core-tools.ts:325`
- `src/tools/core-tools.ts:360`

3. Reviewed skill-pack policy rollback implementation and route validation.
- `src/skill-pack-state.ts:312`
- `src/skill-pack-state.ts:343`
- `src/http/routes/agent-suite.ts:268`
- `src/http/routes/agent-suite.ts:287`

4. Executed targeted rollback guardrail tests (Node test runner).
- Command: `node --test tests/http/agent-suite-route.test.mjs tests/mcp/mcp-http-handler.test.mjs`
- Result: 9 tests passed, 0 failed.
