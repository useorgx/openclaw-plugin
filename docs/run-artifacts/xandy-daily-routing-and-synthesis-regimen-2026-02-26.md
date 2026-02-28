# Xandy Practice Regimen: Daily Routing + Cross-Domain Synthesis

- Date: 2026-02-26
- Initiative: `7906cc8b-d60c-43d6-b714-8a91502d6ceb`
- Workstream: `0b28b2ae-3ad0-4066-8a06-7f9be4c0f6df`
- Task target: `Xandy (Orchestrator) — daily routing plan + cross-domain synthesis practice with coordination rubric` (`b595c826-cfc1-4ba4-b5ce-379d050189c8`)

## Objective

Define an execution-ready daily practice loop for Xandy that improves:

- routing quality across domains,
- contradiction resolution speed,
- milestone/owner consistency,
- objective-to-deliverable traceability.

## Daily Routing Plan (2 Runs/Day)

Token/cost alignment follows current practice budget work (`<=50,000` tokens/run baseline).

1. Morning Routing Run (Run A)
- Inputs:
  - active initiatives snapshot,
  - open blockers,
  - pending decisions,
  - prior-day artifact list.
- Required outputs:
  - prioritized routing table (`domain`, `owner`, `task`, `dependency`, `due_window`),
  - top 3 cross-domain risks,
  - explicit escalation path per risk.
- Exit criteria:
  - all active workstreams assigned or explicitly deferred with reason,
  - no dependency without owner.

2. Afternoon Synthesis Run (Run B)
- Inputs:
  - completed/updated tasks since Run A,
  - decision outcomes,
  - artifacts produced by each domain.
- Required outputs:
  - cross-domain synthesis memo,
  - conflict list with resolution decision for each item,
  - traceability map (`objective -> milestone -> task -> artifact/decision`).
- Exit criteria:
  - all new conflicts either resolved or escalated,
  - every key deliverable linked to a source objective.

## Cross-Domain Synthesis Practice Drill

Run once per day inside Run B:

1. Select one initiative with at least 3 active domains.
2. Build a contradiction matrix with rows:
- `statement`, `source`, `conflicting_statement`, `impact`, `proposed_resolution`.
3. Resolve using deterministic priority order:
- safety/compliance,
- user impact,
- milestone critical path,
- effort/cost.
4. Publish a single decision log section with:
- chosen resolution,
- why alternatives were not selected,
- follow-up owner and deadline.

## Coordination Rubric (1-5)

Score each run and record evidence links.

1. Routing completeness (target `>=4`)
- `1`: multiple unowned dependencies
- `3`: ownership mostly clear, some missing handoff data
- `5`: all routed items include owner, prerequisite, and due window

2. Cross-stream coherence (target `>=4`)
- `1`: plan conflicts across streams
- `3`: minor contradictions remain
- `5`: milestones and priorities align across domains

3. Conflict resolution latency (target `>=4`)
- `1`: unresolved conflicts persist across day
- `3`: conflicts resolved but late
- `5`: conflicts resolved same-day with documented rationale

4. Traceability completeness (target `>=5`)
- `1`: outputs unlinked to objective
- `3`: partial linkage
- `5`: full chain present for all major deliverables

5. Handoff quality (target `>=4`)
- `1`: missing prerequisites and acceptance checks
- `3`: handoffs usable but incomplete
- `5`: handoffs include prerequisites, inputs, acceptance checks, and fallback

## Scorecard Template

Use this template each day:

```json
{
  "date": "2026-02-26",
  "agent": "xandy",
  "run_a": {
    "routing_completeness": 0,
    "cross_stream_coherence": 0,
    "handoff_quality": 0,
    "evidence": []
  },
  "run_b": {
    "cross_stream_coherence": 0,
    "conflict_resolution_latency": 0,
    "traceability_completeness": 0,
    "evidence": []
  },
  "daily_summary": {
    "score_avg": 0,
    "open_conflicts": 0,
    "escalations": [],
    "next_day_focus": ""
  }
}
```

## Verification Procedure

1. Execute Run A and Run B outputs for one day.
2. Confirm all rubric dimensions are scored with evidence links.
3. Verify the traceability map includes objective, milestone, task, and artifact/decision references.
4. Pass condition:
- no unrouted active item,
- no unresolved high-impact contradiction at end of day,
- daily average score `>=4.0`.

## Rollout Notes

- Week 1: enforce template and scoring only.
- Week 2: compare daily averages and isolate lowest metric.
- Week 3: tighten guardrails on lowest metric with explicit checklist additions.
