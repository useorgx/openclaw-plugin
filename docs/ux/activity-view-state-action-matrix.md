# Activity View State / Action Matrix (Active vs Past Runs)

This document is the “what happens when I click?” contract for the **Activity** surface.
It covers connection + data states and specifies **primary CTAs**, **fallbacks**, and
the difference between **active runs** and **past runs**.

## Definitions

- **Active run**: a session whose status is one of `running | queued | pending | blocked`.
- **Past run**: a session whose status is one of `completed | failed | cancelled | archived`.
- **Multi-session mode**: the default Activity timeline (grouped by day).
- **Single-session mode**: thread view when exactly one session/run is selected.

## Connection States (Top Bar + Feed Semantics)

| State | Meaning | Primary CTA | Secondary | Notes |
|---|---|---|---|---|
| `connected` (live) | Live snapshot refresh succeeded; SSE/polling may still be idle | None | “Last updated” tooltip | Dot can pulse only when new events arrive |
| `connected` (idle) | No new events; transport is healthy | None | “Refresh” (optional) | Must not show “reconnecting” |
| `reconnecting` (degraded) | Partial data or fallback polling engaged | “Reconnect” / “Retry” | “Open Settings” | Must explain “what is happening + what can I do” |
| `disconnected` | Snapshot calls are failing | “Reconnect OrgX” | “Open Settings” | Show last known good snapshot timestamp |

## Data / UI States (>= 12)

| # | State | What The User Sees | Primary CTA | Secondary Actions | Clicking An Activity Item |
|---|---|---|---|---|---|
| 1 | **Loading** (first load) | Skeleton/pending with calm copy | None | Cancel (optional) | Disabled |
| 2 | **Empty feed** (no events) | Empty card with helpful next step | “Launch agent” | “Open Mission Control” | N/A |
| 3 | **Feed has events** | Grouped-by-day timeline | None | Search / filter | Opens detail modal |
| 4 | **Search yields no matches** | “No matching activity” + suggestion | “Clear search” | “Clear filters” | N/A |
| 5 | **Filter yields no matches** | “No messages/artifacts/decisions…” | “Show all” | “Clear session filter” | N/A |
| 6 | **Session filter active (multi-session)** | Pill showing selected session | “Clear session filter” | “Focus session” | Opens detail modal; “Focus session” is offered in detail modal |
| 7 | **Single-session mode (thread)** | ThreadView replaces timeline | “Back to timeline” | Scroll to latest | Opens detail inline within thread context (no cross-session jump) |
| 8 | **Event has missing/partial metadata** | Detail modal still renders cleanly | None | “Copy event id” | Opens detail; metadata section shows “—” where absent |
| 9 | **Artifact event** | Artifact section appears in detail modal | “Copy run” (if available) | Toggle Structured/JSON | Opens detail; artifact payload is always visible without hunting |
| 10 | **Decision event (blocking)** | Decision context is visible | “Focus session” | “Copy decision id” | Opens detail; next action is “Focus session” (not “Copy…”) |
| 11 | **Active run selected** | Session status shows `running/queued/...` | “Focus session” | “Resume/Pause/Cancel/Rollback” (if supported) | Opens detail; action buttons must be gated by run status |
| 12 | **Past run selected** | Session status shows `completed/...` | “Focus session” | “Copy run/event id” | Opens detail; must not show impossible actions (no “Resume” on completed) |
| 13 | **Auth blocked (401/403)** | Clear “Unauthorized” error guidance | “Open Settings” | “Retry” | Disabled until auth fixed |
| 14 | **Partial snapshot** (`degraded`) | Banner describing missing surfaces | “Retry” | “Reconnect” | Opens detail; must indicate data may be stale |

## Action Gating Rules

- **Never show an impossible control**:
  - `Resume` only when run is `paused | blocked | queued | pending`.
  - `Pause` only when run is `running | active | queued | pending`.
  - `Cancel` only when run is not `completed | cancelled | archived`.
  - `Rollback` only when run is not `cancelled | archived` (and backend supports it).
- **Copy actions** (run id, agent id, event id) are always available when the value exists.
- **Focus session** should be the default primary CTA when the event has a `runId`.

## Baseline Evidence Checklist (for QA task)

- Desktop + mobile screenshots for states: #2, #4, #6, #11, #12, #13.
- One failure state: forced snapshot error + reconnect path.
- One degraded state: partial data banner visible.

