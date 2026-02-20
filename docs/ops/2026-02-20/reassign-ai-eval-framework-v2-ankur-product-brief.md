# Reassign Existing Initiative Task: AI Eval Framework v2 (Ankur)

- Initiative: `MCP Stream Agent Reassignment Capability` (`99aceceb-d8b0-4c43-86ae-278fbd7d59ea`)
- Workstream: `Reassign Existing Initiatives` (`fe7d7021-e37d-4f5a-9bef-476bc14234ae`)
- Milestone: `Fix Agent Assignments on Active Initiatives` (`b2fe6bd7-ff62-48bf-9fc9-dc25472305dc`)
- Task: `Reassign AI Eval Framework v2 Ankur` (`71964b43-a2bd-451d-a778-c54196ac7f70`)

## Assignment Changes

| Work item | Prior owner | New owner |
| --- | --- | --- |
| Success Criteria & Metrics | unassigned/mixed | `product` |
| Dataset Construction | unassigned/mixed | `engineering` |
| Eval Criteria & Failure Analysis | unassigned/mixed | `engineering` |
| Offline & Online Pipelines | unassigned/mixed | `engineering` |

## Scope Boundaries

### Product-owned
- Define the evaluation north-star, KPI hierarchy, and metric guardrails.
- Lock target thresholds for launch-readiness and regression tolerances.
- Publish metric definitions that engineering can compute consistently.

### Engineering-owned
- Build/curate representative datasets and versioning approach.
- Implement criteria/failure-analysis instrumentation and reporting.
- Implement offline and online pipeline execution with repeatable runs.

## Interface Contract Between Product and Engineering

- Product delivers metric specification first; engineering implementation starts after spec approval.
- Engineering returns sample outputs against the metric specification for sign-off.
- Any metric schema change after implementation start requires explicit change log entry and impact note.

## Success Criteria for This Reassignment

- All four work items have a single accountable owner (`product` or `engineering`) with no overlap ambiguity.
- Product metric specification is accepted before engineering pipeline hardening begins.
- Engineering artifacts explicitly trace to the approved metric definitions.

## Verification Plan

1. Confirm task record reflects the owner split exactly as listed in **Assignment Changes**.
2. Review product output for explicit metric targets and definitions.
3. Review engineering outputs for dataset, criteria, and pipeline artifacts mapped to those metrics.
4. Confirm handoff notes include at least one product-to-engineering sign-off checkpoint.

## Risks and Mitigations

- Risk: Product metrics are not specific enough for implementation.
  - Mitigation: Require numeric targets and pass/fail thresholds before engineering starts.
- Risk: Engineering pipeline work drifts from agreed metrics.
  - Mitigation: Add metric mapping section to each engineering deliverable.
