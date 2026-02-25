# Plan to Initiative Bridge Discovery (2026-02-24)

## Scope
Discovery for workstream `Plan to Initiative Bridge` focused on the execution path from planning metadata to a runnable autonomous slice in this plugin repository.

## Current State (Observed)
- Slice output contract and parsing already exist in [`src/http/helpers/autopilot-slice-utils.ts`](/Users/hopeatina/Code/orgx-openclaw-plugin/src/http/helpers/autopilot-slice-utils.ts).
- Dispatch runtime and guardrails exist in [`scripts/run-codex-dispatch-job.mjs`](/Users/hopeatina/Code/orgx-openclaw-plugin/scripts/run-codex-dispatch-job.mjs).
- Launch planning data exists in [`scripts/apply-launch-plan-v2.mjs`](/Users/hopeatina/Code/orgx-openclaw-plugin/scripts/apply-launch-plan-v2.mjs), but it is script-local and not a reusable bridge contract.
- The current flow has strong execution controls (spawn checks, throttling, progress reporting), but weak explicit mapping from "plan objects" to "scaffolded executable work items."

## Bridge Gaps
1. No canonical typed `Plan -> Initiative` translation contract that is shared between planning scripts and dispatch workers.
2. No dedicated scaffold step that materializes normalized workstream/task seeds from plan files before dispatch.
3. Limited visibility into translation quality (for example, missing required fields, inferred defaults, or skipped plan items) before execution starts.

## Minimal Bridge Design (Incremental)
1. Add a typed bridge module:
- New module in `src/http/helpers/` or `src/contracts/` with schema and normalization for:
  - plan metadata
  - initiative payload
  - workstream/task scaffold payload
- Keep `additionalProperties: false` for strictness where exposed to MCP tools.

2. Add scaffold stage in dispatch workflow:
- Create a pre-dispatch scaffold function that:
  - reads a plan source (file/path or object),
  - validates required fields,
  - emits deterministic workstream/task candidates.
- Persist scaffold output alongside state file for retry/resume parity.

3. Add launch bridge telemetry:
- Emit structured progress entries for:
  - scaffold started/completed
  - skipped plan units with reason
  - launch handoff counts (workstreams/tasks ready, blocked, deferred).

## Verification Plan for Next Slice
1. Unit tests for translation edge cases:
- missing initiative id
- duplicate workstream titles
- invalid dependencies
- unsupported task statuses

2. Targeted integration check:
- run dispatch script with `--plan_file` and `--dry_run=true`,
- assert scaffold summary appears in output/state.

3. Contract drift check:
- ensure scaffold output remains parseable by existing slice result schema utilities.

## Proposed Acceptance Criteria for Bridge Scaffolding
- A plan file can be converted into deterministic scaffold payloads with no manual edits.
- Invalid plan entries are reported with machine-readable reasons.
- Dry-run mode reports scaffolded totals before any worker spawn.
- Resume mode reuses existing scaffold state instead of regenerating conflicting IDs.

## Deliverable From This Discovery Slice
- This document captures the current bridge baseline, concrete gaps, and an incremental implementation sequence for `Plan -> Scaffold -> Launch Continuous Flow` without changing runtime behavior yet.
