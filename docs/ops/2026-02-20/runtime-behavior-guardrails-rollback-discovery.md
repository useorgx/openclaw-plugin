# Runtime Behavior Enforcement: Guardrails & Rollback Discovery

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)  
Workstream: Runtime Behavior Enforcement (`853d6b1c-be7f-4bad-8dfa-eb3fe3d9c834`)  
Milestone: Guardrails & Rollback (`85f5404c-8956-4dd0-b5cb-2aa1ca392992`)  
Task context: Guardrails & Rollback: Discovery (`a805350d-2b5f-4318-b3cb-f19085072a41`)

## Scope

Document what guardrails and rollback controls are already enforced in plugin runtime paths, and identify the smallest implementation-ready gaps needed for behavior-aware rollback guarantees.

## Current Guardrail Guarantees (Code-Verified)

1. Token budget guardrail is explicit-only.
- Runtime only uses an explicit budget input or `ORGX_AUTO_CONTINUE_TOKEN_BUDGET`; hidden legacy toggles are intentionally ignored.
- Evidence: `src/http/helpers/auto-continue-engine.ts:916`.

2. Budget exhaustion hard-stops autonomous continuation before new dispatch.
- The scheduler checks `run.tokensUsed >= tokenBudget` before selecting another slice and exits with `budget_exhausted`.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2051`.

3. Parallel execution is bounded.
- Active slice runs are counted and compared against `maxParallelSlices`; scheduler pauses lane expansion when limit is reached.
- Evidence: `src/http/helpers/auto-continue-engine.ts:2057`.

4. Run controls are normalized through one route surface.
- Runtime control actions are routed via `/runs/:runId/actions/:action`, including `pause`, `resume`, `cancel`, `rollback`, and `complete`.
- Evidence: `src/http/routes/run-control.ts:5` and `src/http/routes/run-control.ts:106`.

## Current Rollback Guarantees (Code-Verified)

1. MCP rollback requires a checkpoint identifier.
- Tool contract rejects rollback calls without `checkpointId` before invoking OrgX API.
- Evidence: `src/tools/core-tools.ts:323` and `src/tools/core-tools.ts:360`.

2. Skill-pack behavior policy has local audit-backed rollback.
- Policy rollback reads prior audit entries, computes diff, writes a `policy.rollback` audit event, and persists atomically.
- Evidence: `src/skill-pack-state.ts:312`.

3. HTTP policy mutation validates rollback payload shape.
- Rollback action rejects mixed update fields and enforces `rollbackToAuditId` when `action=rollback`.
- Evidence: `src/http/routes/agent-suite.ts:257` and `src/http/routes/agent-suite.ts:274`.

4. Rollback path is covered by route tests.
- Tests verify policy rollback response, audit linkage (`rollbackOfAuditId`), and invalid rollback payload rejection.
- Evidence: `tests/http/agent-suite-route.test.mjs:138` and `tests/http/agent-suite-route.test.mjs:302`.

## Gap Analysis

1. Runtime run rollback and behavior policy rollback are separate domains.
- Run rollback uses checkpoint IDs; policy rollback uses local policy audit IDs.
- There is no canonical linkage proving which behavior policy was active at a given run checkpoint.

2. Checkpoint metadata lacks behavior fingerprint.
- Current checkpoint/control flow accepts optional payload, but no required schema for behavior-policy identity.

3. Guardrail evaluation output is not persisted as a stable envelope.
- Token/concurrency checks exist, but denials and pass/fail context are not consistently attached to checkpoint-ready artifacts.

## Smallest Implementation Slice After Discovery

1. Introduce behavior fingerprint in checkpoint payload.
- Add fields: `behaviorPolicyChecksum`, `behaviorPolicyAuditId`, `behaviorPolicyFrozen`.
- Persist on checkpoint creation and surface on checkpoint list responses.

2. Emit a normalized guardrail decision envelope for each attempted slice dispatch.
- Minimum fields: `allowed`, `reasonCode`, `reason`, `evaluatedAt`, `tokenBudget`, `tokensUsed`, `maxParallelSlices`, `activeSliceCount`.

3. Add rollback consistency validation.
- On rollback action, warn or block when requested checkpoint behavior fingerprint does not match current effective behavior policy, unless explicit override is present.

## Verification Steps Executed

1. Inspected token budget + scheduler guardrail logic.
- `src/http/helpers/auto-continue-engine.ts:916`
- `src/http/helpers/auto-continue-engine.ts:2051`

2. Inspected run-control action routing.
- `src/http/routes/run-control.ts:5`
- `src/http/routes/run-control.ts:106`

3. Inspected MCP rollback contract.
- `src/tools/core-tools.ts:323`
- `src/tools/core-tools.ts:360`

4. Inspected policy rollback implementation and endpoint validations.
- `src/skill-pack-state.ts:312`
- `src/http/routes/agent-suite.ts:257`

5. Inspected rollback validation tests.
- `tests/http/agent-suite-route.test.mjs:138`
- `tests/http/agent-suite-route.test.mjs:302`

No runtime behavior was changed in this slice; this is a discovery artifact only.

## Re-Verification Matrix

Use the commands below to re-validate each discovery claim against current source.

1. Token budget + scheduler guardrails.
- `nl -ba src/http/helpers/auto-continue-engine.ts | sed -n '900,940p;2038,2070p;2308,2395p'`
- Confirm explicit-only token budget handling, budget stop, and approval-gate blocking flow.

2. Run-control and rollback contracts.
- `nl -ba src/http/routes/run-control.ts | sed -n '1,140p'`
- `nl -ba src/tools/core-tools.ts | sed -n '315,375p'`
- Confirm action surface includes `rollback` and MCP requires `checkpointId` for rollback.

3. Skill-pack policy rollback + endpoint validation.
- `nl -ba src/skill-pack-state.ts | sed -n '300,360p'`
- `nl -ba src/http/routes/agent-suite.ts | sed -n '245,310p'`
- Confirm rollback audit lineage and rollback payload guards.

4. Rollback route tests.
- `nl -ba tests/http/agent-suite-route.test.mjs | sed -n '130,320p'`
- Confirm tests cover success rollback and invalid rollback payloads.
