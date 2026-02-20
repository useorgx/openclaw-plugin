# AI Product Evaluation Framework (Ankur Method): Agent Success Criteria + Metrics

- Initiative: `AI Product Evaluation Framework (Ankur Method)` (`9cb1ce04-03f0-4562-ab3a-ae839b8e8e33`)
- Workstream: `Success Criteria & Metrics Definition` (`8725a878-c093-4d1b-9511-707ee1829094`)
- Slice run: `4a52e1c0-3bd6-461b-8b60-3af110732704`
- Date: 2026-02-20

## Evaluation Model

All agents are evaluated on two layers:

1. Behavior fidelity: does the agent produce the expected class of output for its domain?
2. Metric attainment: do outputs meet measurable quality and outcome thresholds?

Scoring bands per metric:

- `5` = exceeds target by >=10%
- `4` = meets target
- `3` = within 10% below target
- `2` = 10-25% below target
- `1` = >25% below target or missing output

Release-readiness rule per agent:

- No critical metric below `3`
- Average score across listed metrics >= `4.0`

## Expected Behaviors and Measurable Metrics by Agent

### 1) Nova (Strategist / PM)

Expected behaviors:
- Produces clear problem framing and objective hierarchy.
- Converts ambiguity into prioritized execution plans.
- Identifies dependencies, risks, and decision points.

Metrics:
- Objective clarity rate: `% of deliverables with explicit objective + success metric + owner` (target: `>=95%`).
- Plan completeness score: `% of plans containing scope, milestones, risks, and dependencies` (target: `>=90%`).
- Decision latency: `median time from identified decision to explicit recommendation` (target: `<=24h`).

### 2) Dev Delivery (Engineering)

Expected behaviors:
- Ships production-ready implementation aligned to acceptance criteria.
- Minimizes regressions and rework.
- Verifies changes with targeted tests.

Metrics:
- First-pass acceptance rate: `% of implementation tasks accepted without major rework` (target: `>=85%`).
- Regression escape rate: `% of shipped tasks causing post-merge defects within 7 days` (target: `<=5%`).
- Verification coverage: `% of tasks with explicit verification steps + executed checks` (target: `>=95%`).

### 3) Mark Marketing (GTM)

Expected behaviors:
- Produces audience-specific messaging with clear offer and CTA.
- Aligns channel execution to funnel stage.
- Uses measurable hypotheses, not generic copy.

Metrics:
- Message-to-ICP alignment: `% of assets with explicit ICP pain/value mapping` (target: `>=90%`).
- Channel readiness rate: `% of assets meeting channel-specific format/constraint rules` (target: `>=95%`).
- Experiment quality rate: `% of campaigns with hypothesis + primary KPI + decision threshold` (target: `>=90%`).

### 4) Sales Sage (Revenue)

Expected behaviors:
- Qualifies opportunities with explicit criteria.
- Generates deal guidance tied to account context.
- Produces actionable next-step recommendations.

Metrics:
- Qualification completeness: `% of opportunities with full MEDDICC/BANT-equivalent fields` (target: `>=90%`).
- Next-step specificity: `% of outputs with owner + due date + expected outcome` (target: `>=95%`).
- Forecast confidence delta: `absolute error between projected and actual close window` (target: `<=15%`).

### 5) Ops Orbit (Operations)

Expected behaviors:
- Converts intent into reliable process/routing.
- Detects blockers and proposes unblocking actions.
- Maintains clean operational handoffs.

Metrics:
- Handoff completeness: `% of handoffs containing prerequisites, inputs, and acceptance checks` (target: `>=95%`).
- Blocker detection lead time: `median time from blocker emergence to logged escalation` (target: `<=4h`).
- Workflow adherence: `% of runs that follow defined SOP/guardrails without manual correction` (target: `>=92%`).

### 6) Design Codex (Design / UX)

Expected behaviors:
- Produces coherent UX specs aligned to product goals.
- Balances visual quality, usability, and implementation feasibility.
- Validates mobile and accessibility constraints.

Metrics:
- Spec implementation success: `% of design specs implemented without clarification loop` (target: `>=85%`).
- UX quality pass rate: `% of designs meeting accessibility + responsiveness checks on first review` (target: `>=90%`).
- Rework ratio: `avg number of major design revisions before signoff` (target: `<=1.5`).

### 7) Xandy (Cross-functional Integrator)

Expected behaviors:
- Synthesizes outputs across agents into a coherent execution path.
- Resolves conflicts across priorities, dependencies, and timelines.
- Maintains end-to-end traceability from objective to execution.

Metrics:
- Cross-stream coherence score: `% of plans with consistent milestones/owners across functions` (target: `>=90%`).
- Conflict resolution latency: `median time to resolve cross-agent contradiction` (target: `<=12h`).
- Traceability completeness: `% of deliverables linked to objective, task, artifact, and decision` (target: `>=95%`).

## Baseline Measurement Protocol (for next task)

Run each agent against a fixed 5-prompt rubric and score all metrics above using the 1-5 scale.

Protocol:
- Use the same prompt set and context packet for all baseline runs.
- Capture raw outputs and scorecards in one record per agent.
- Require two raters for subjective metrics; use average score.
- Compute per-agent summary:
  - critical metric min
  - metric average
  - pass/fail against release-readiness rule

Suggested baseline artifact schema:
- `agent_name`
- `run_timestamp`
- `prompt_set_version`
- `metric_scores` (metric id -> score)
- `evidence_links`
- `rater_notes`
- `readiness_status`

## Completion Boundary for This Slice

This slice defines expected behaviors and measurable metrics for all seven OrgX agents and provides a concrete baseline protocol for execution in the next slice.
