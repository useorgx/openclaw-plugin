# Agentic UX Reality Appendix (OpenClaw Plugin)

Status: Implementation appendix for OrgX canonical spec
Last updated: 2026-02-06

## Why this exists
Define plugin-side implementation details that realize the canonical OrgX agentic UX contract in OpenClaw surfaces.

## What user sees
- New control tools for run actions and checkpoints.
- Delegation preflight available before launching autonomous tasks.
- Dashboard session tree enriched with phase/state, ETA, cost, and checkpoint counts.
- Live stream events aligned to normalized envelope fields.

## What system does
- Extends plugin API client, MCP tools, and HTTP proxy routes.
- Proxies new OrgX control endpoints.
- Preserves fallback behavior for older server responses.

## Acceptance tests
1. Plugin can list and restore checkpoints for an owned run.
2. Plugin can pause/resume/cancel/rollback run via run action tool.
3. Delegation preflight tool returns scope quality, ETA, and cost estimate.
4. Dashboard activity renders phase/state/kind/summary fields from live stream.

## Plugin API Additions
File: `src/api.ts`
- `delegationPreflight(payload)`
- `runAction(runId, action, payload)`
- `listRunCheckpoints(runId)`
- `createRunCheckpoint(runId, payload)`
- `restoreRunCheckpoint(runId, { checkpointId, reason })`

Also hardened `syncMemory` to accept wrapped responses (`{ ok, data }`) and direct payloads.

## MCP Tool Additions
File: `src/index.ts`
- `orgx_delegation_preflight`
- `orgx_run_action`
- `orgx_checkpoints_list`
- `orgx_checkpoint_restore`

Tool contract notes:
- Explicit schemas with `additionalProperties: false`.
- `orgx_run_action` enforces checkpoint requirement for rollback.

## HTTP Proxy Route Additions
File: `src/http-handler.ts`
- `POST /orgx/api/delegation/preflight`
- `GET|POST /orgx/api/runs/:id/checkpoints`
- `POST /orgx/api/runs/:id/checkpoints/:checkpointId/restore`
- `POST /orgx/api/runs/:id/actions/:action`

Fallback behavior:
- Returns clear 405 for wrong methods.
- Returns structured error payload for unavailable upstream responses.

## Dashboard Contract Mapping
Files:
- `src/types.ts`
- `dashboard/src/types.ts`

Required enriched fields now expected in live payloads:
- Activity: `phase`, `state`, `kind`, `summary`, `decisionRequired`, `costDelta`
- Session: `phase`, `state`, `eta`, `cost`, `checkpointCount`, `blockerReason`

## SSE Mapping
Plugin forwards `/api/client/live/stream` and expects activity entries to already be normalized.
Key event streams:
- `snapshot`
- `activity.appended`
- `session.updated`
- `handoff.updated`
- `heartbeat`

Consumer rule:
- Dedupe by event `id`.
- Render newest by `timestamp`.

## Compatibility Notes
- Supports both `workspaceState` and `workspace_state` sync style from server.
- Does not require immediate dashboard redesign; added fields are additive to existing rendering.
- Preserves existing decision approval endpoints and behavior.
