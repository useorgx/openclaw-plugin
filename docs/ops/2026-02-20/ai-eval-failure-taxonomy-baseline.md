# AI Eval Failure Taxonomy Baseline (2026-02-20)

## Scope

This slice defines a reproducible failure taxonomy baseline for the AI Product Evaluation Framework (Ankur Method), with initial frequency counts, severity mapping, and blocking thresholds.

## Evidence Sources

1. Runtime decision/error paths in `src/http/helpers/auto-continue-engine.ts`.
2. Domain failure follow-up templates in `src/retro/domain-templates.ts`.

### Reproduction Commands

```bash
rg -o 'autopilot_failure|autopilot_blocked_without_decision|mcp_handshake_failure|slice_missing_blocking_decision|slice_invalid_output|autopilot_spawn_guard_block' src/http/helpers/auto-continue-engine.ts | sort | uniq -c
rg -n 'failureFollowUpTitle:' src/retro/domain-templates.ts
```

## Failure Taxonomy (Baseline)

| Cluster | Signal(s) | Frequency (code references) | Severity | Default action |
|---|---|---:|---|---|
| Output contract failure | `slice_invalid_output` | 4 | High | Fail run, emit blocking decision, require schema-correct rerun |
| Generic autopilot execution failure | `autopilot_failure` | 4 | High | Fail run, require root-cause + patch before retry |
| Missing required blocker decision | `slice_missing_blocking_decision`, `autopilot_blocked_without_decision` | 3 | Critical | Hard-block; human decision required before continuation |
| MCP handshake failure | `mcp_handshake_failure` | 2 | Medium | Retry with backoff; escalate to blocker on repeated failure |
| Spawn guard policy block | `autopilot_spawn_guard_block` | 1 | Medium | Request explicit override or lower-risk route |

## Domain Failure Coverage

`src/retro/domain-templates.ts` contains 8 concrete failure follow-up templates (engineering, product, design, marketing, sales, operations, orchestration, fallback default). This supports domain-specific remediation instead of one generic retry loop.

## Eval Criteria Derived From Failures

Use these criteria in judge scoring and release gates:

1. Contract fidelity: output must conform to declared schema and required fields.
2. Decision completeness: blocked slices must include a blocking decision payload.
3. Dependency readiness: spawn/policy checks must pass before execution starts.
4. Integration readiness: MCP handshake must succeed or produce deterministic retry/escalation behavior.
5. Remediation specificity: failure outcomes must map to a domain-specific corrective action.

## Blocking Thresholds (Initial)

Apply per 7-day rolling window:

1. `slice_invalid_output` rate > 2%: block release candidate.
2. Missing blocker decision count >= 1: immediate block until corrected.
3. MCP handshake failure rate > 5%: mark milestone at-risk and pause autonomous retries after 2 consecutive failures.
4. Spawn guard block rate > 10%: require policy recalibration review before increasing dispatch volume.
5. Critical/High failure mix > 20% of failed runs: no threshold ratchet increases.

## Notes For Next Slice

1. Replace static code-reference frequencies with run-time observed frequencies from live activity telemetry.
2. Add a golden-example pack per artifact type aligned to the five evaluation criteria above.
3. Wire these thresholds into automated ratchet logic only after two stable windows.
