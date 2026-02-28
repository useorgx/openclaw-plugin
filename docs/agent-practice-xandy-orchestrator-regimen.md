# Xandy (Orchestrator) Practice Regimen

## Purpose
Build a repeatable daily practice loop for Xandy to improve:
- routing accuracy across domains
- cross-domain synthesis quality
- coordination clarity under handoff pressure

This regimen is designed for OrgX/OpenClaw operations where Xandy is the orchestrator and execution agents deliver scoped slices.

## Daily Routing Plan (60 Minutes)

### 1) Intake and Scope Framing (10 min)
- Review 3 incoming tasks with mixed ambiguity (engineering, product, operations).
- Normalize each into: objective, constraints, required evidence, acceptance criteria.
- Write one explicit assumption per task.

Pass condition:
- each task has a concrete deliverable and at least one measurable verification step.

### 2) Domain Routing Drill (15 min)
- Route each task to the best-fit primary domain and one fallback domain.
- For each routing decision, record:
  - why this domain is primary
  - what would trigger reassignment
  - expected output artifact type

Pass condition:
- no task is routed without a stated reassignment trigger.

### 3) Cross-Domain Synthesis Drill (20 min)
- Select one task requiring at least 2 domains.
- Produce a synthesis brief containing:
  - shared context all agents need
  - division of responsibilities
  - integration contract (interfaces, handoff format, timing)
  - final quality gate

Pass condition:
- synthesis brief can be executed without follow-up clarification from the orchestrator.

### 4) Debrief and Calibration (15 min)
- Score routing and synthesis using the rubric below.
- Log one recurring failure pattern and one corrective rule for tomorrow.

Pass condition:
- at least one concrete rule change is captured for next-day behavior.

## Coordination Rubric (Score 1-5)

### A. Routing Precision
- 1: domain assignment is vague or mismatched
- 3: mostly correct domain with partial rationale
- 5: correct domain, clear rationale, clear reassignment trigger

### B. Scope Fidelity
- 1: objectives and constraints are incomplete
- 3: objectives are clear but constraints or acceptance criteria are weak
- 5: objective, constraints, and acceptance criteria are explicit and testable

### C. Handoff Quality
- 1: agents would need re-briefing to start
- 3: handoff is usable but leaves ambiguity on ownership or outputs
- 5: ownership, output format, and success checks are unambiguous

### D. Cross-Domain Synthesis
- 1: workstreams are independent and not integrated
- 3: integration intent exists but contracts/timing are unclear
- 5: integration contract, order, and dependency boundaries are explicit

### E. Feedback Integration
- 1: no change from prior errors
- 3: lessons captured but not translated into action rules
- 5: lessons become concrete next-day routing rules

## Scoring Bands
- 22-25: ready for high-autonomy orchestration
- 17-21: operationally sound, requires targeted improvement
- 12-16: increased supervision required
- <=11: pause autonomous routing; run remediation drills first

## Weekly Progression
- Monday-Thursday: run full daily loop and log scores.
- Friday: review score trend, identify top 2 repeated failure modes, define next week's focus drills.

Minimum weekly target:
- average score >= 20
- no criterion below 3 for 3 consecutive days

## Evidence Capture Template

Use one record per day:

```md
Date:
Tasks routed:
Average rubric score:
Lowest criterion:
Failure pattern observed:
Corrective rule for next run:
```

## Exit Criteria for First Improvement Cycle
This regimen is considered effective for the first cycle when:
- 10 consecutive practice days are logged
- weekly average is >= 20 for 2 consecutive weeks
- no critical handoff failure (score 1 in Handoff Quality) in the final 5 days
