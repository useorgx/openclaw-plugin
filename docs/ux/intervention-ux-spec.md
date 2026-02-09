# Intervention UX Spec (MVP)

Interventions are the “human steering wheel” for agent execution. This spec defines **what interventions exist**, **where they live in the UI**, **how they are gated**, and **what backend support is required**.

## Goals

- Let users intervene in an active run without hunting across surfaces.
- Make every intervention **safe** (confirmations, audit trail, reversible when possible).
- Keep MVP small: a user should understand and use interventions in under 10 seconds.

## Top 5 Intervention Intents (Priority Order)

1. **Focus session**
   - Move from an Activity event to the session inspector with run controls.
2. **Message agent**
   - Send a short instruction to the running agent (clarify, redirect, ask for status).
3. **Pause / Resume**
   - Temporarily stop and later continue execution (status-gated).
4. **Cancel**
   - Stop execution permanently (status-gated, confirmation required).
5. **Rollback**
   - Restore to last good checkpoint (dangerous; explicit confirmation + explain effect).

## Entry Points (Where The User Finds Interventions)

### 1. Activity Detail Modal (Primary)

- Always show:
  - `Focus session` (if `runId` exists).
  - Copy controls (run id, agent id, event id) where applicable.
- Show run controls only if the event has a `runId` and the session is **active**:
  - `Pause` (when allowed), `Resume` (when allowed), `Cancel`, `Rollback`.
- Optional (MVP+): `Message agent` as a compact input with “Send” button.

### 2. Session Inspector (Run Control Surface)

- This is where power users spend time.
- Add a single primary action based on status:
  - Active: `Pause` (primary) + `Cancel` (secondary).
  - Blocked/paused: `Resume` (primary) + `Rollback` (secondary).
- `Message agent` lives here as well (same component as Activity modal, shared styling).

### 3. Mission Control (Future)

- Mission Control should not become a run-control kitchen sink.
- MVP: only show “Focus session” from nodes that reference a run.

## Permission Model

- **All users**:
  - `Focus session`, copy ids, view detail.
- **Paid users** (or users with explicit entitlement):
  - `Pause/Resume/Cancel/Rollback`.
- **BYOK users**:
  - Can still intervene in local execution mode; controls must clarify whether the action affects *cloud* vs *local* runs.

## Copy / Microcopy Requirements

Every intervention must answer:

- What happens?
- When does it take effect?
- Is it reversible?

Suggested copy:

- Pause: “Pauses execution. You can resume later.”
- Cancel: “Stops this run. This can’t be undone.” (confirm)
- Rollback: “Restores the run to the last checkpoint. You may lose recent progress.” (confirm)

## Backend / API Deltas (Expected)

Existing run control endpoints (already wired in dashboard code):

- `POST /orgx/api/runs/:runId/actions/resume`
- (Expected) `POST /orgx/api/runs/:runId/actions/pause`
- (Expected) `POST /orgx/api/runs/:runId/actions/cancel`
- (Expected) `POST /orgx/api/runs/:runId/actions/rollback`
- `GET /orgx/api/runs/:runId/checkpoints`

For **message agent** MVP, we need one of:

1. `POST /orgx/api/runs/:runId/messages` with `{ text }`, or
2. `POST /orgx/api/runs/:runId/actions/intervene` with `{ kind: "message", text }`.

All mutation endpoints must:

- Return clear status + updated session state.
- Emit an activity event (so Activity timeline reflects the intervention).
- Be idempotent where feasible (at least “resume”).

## Audit Trail (Minimum)

Every intervention emits:

- `who`: user id (if available) or `source_client`
- `what`: intervention kind + payload
- `when`: timestamp
- `where`: run id + initiative/workstream/task ids (if known)

In the UI, interventions should appear as Activity items with the correct `runId` so they’re attributable.

