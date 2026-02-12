# OrgX OpenClaw Plugin Feature Index

Last reviewed: 2026-02-07
Scope: current repository state in `src/` and `dashboard/src/`

## 1) Core Runtime Features

- Background sync service (`orgx-sync`) with configurable interval (`syncIntervalMs`).
- API credential resolution precedence:
  - plugin config (`plugins.entries.orgx.config.apiKey`)
  - `ORGX_API_KEY` env
  - persisted plugin auth store
  - legacy local dev `.env.local` fallback
- Persisted onboarding auth and installation identity under user config directory.
- Tooling surface registration:
  - MCP tools
  - CLI command group (`openclaw orgx ...`)
  - HTTP handler (`/orgx/...`) for dashboard and API bridge.

## 2) Onboarding + Auth Features

- Browser pairing flow:
  - `POST /orgx/api/onboarding/start`
  - `GET /orgx/api/onboarding/status`
  - pair status handling (`pending`, `authorized`, `ready`, `consumed`, failure paths)
- Manual key fallback flow:
  - `POST /orgx/api/onboarding/manual-key`
- Disconnect flow:
  - `POST /orgx/api/onboarding/disconnect`
- Runtime credential update and secure persisted storage.
- Auth flow investigation notes (Clerk, MCP, ChatGPT, OpenClaw):
  - `docs/auth/auth-flows-investigation-2026-02-12.md`

## 3) MCP Tool Inventory (Current)

- `orgx_status`
- `orgx_sync`
- `orgx_delegation_preflight`
- `orgx_run_action`
- `orgx_checkpoints_list`
- `orgx_checkpoint_restore`
- `orgx_spawn_check`
- `orgx_quality_score`
- `orgx_create_entity`
- `orgx_update_entity`
- `orgx_list_entities`
- `orgx_report_progress`
- `orgx_request_decision`
- `orgx_register_artifact`

## 4) CLI Surface (Current)

- `openclaw orgx status`
- `openclaw orgx sync --memory ... --daily-log ...`

## 5) HTTP API Surface (Current)

- Legacy summary endpoints:
  - `GET /orgx/api/status`
  - `GET /orgx/api/agents`
  - `GET /orgx/api/activity`
  - `GET /orgx/api/initiatives`
  - `GET /orgx/api/health`
- Onboarding endpoints:
  - `GET /orgx/api/onboarding`
  - `POST /orgx/api/onboarding/start`
  - `GET /orgx/api/onboarding/status`
  - `POST /orgx/api/onboarding/manual-key`
  - `POST /orgx/api/onboarding/disconnect`
- Entity endpoints:
  - `GET /orgx/api/entities?type=...`
  - `POST /orgx/api/entities`
- Live endpoints:
  - `GET /orgx/api/dashboard-bundle`
  - `GET /orgx/api/live/snapshot`
  - `GET /orgx/api/live/sessions`
  - `GET /orgx/api/live/activity`
  - `GET /orgx/api/live/agents`
  - `GET /orgx/api/live/initiatives`
  - `GET /orgx/api/live/decisions`
  - `POST /orgx/api/live/decisions/approve`
  - `POST /orgx/api/live/decisions/:id/approve`
  - `GET /orgx/api/live/stream` (SSE bridge)
- Run control endpoints:
  - `GET /orgx/api/runs/:runId/checkpoints`
  - `POST /orgx/api/runs/:runId/checkpoints`
  - `POST /orgx/api/runs/:runId/checkpoints/:checkpointId/restore`
  - `POST /orgx/api/runs/:runId/actions/:action`
- Delegation endpoint:
  - `POST /orgx/api/delegation/preflight`
- Handoffs endpoint:
  - `GET /orgx/api/handoffs`

## 6) Dashboard Capabilities (Current)

- Onboarding gate (pairing/manual key/skip/resume UX).
- Live connection state (`connected`, `reconnecting`, `disconnected`) with SSE + polling fallback.
- Session tree and inspector.
- Activity timeline with filtering.
- Initiative panel.
- Decision queue with single and bulk approve.
- Mobile tabbed navigation.
- Entity creation modal for initiatives/workstreams.

## 7) Reliability/Resilience Features

- Local OpenClaw snapshot fallback when OrgX live APIs fail:
  - local sessions
  - derived activity
  - local agents
  - local initiatives
- Degraded mode signaling from `/orgx/api/live/snapshot`.
- Local outbox buffering for progress/decision/artifact events during cloud failures.

## 8) Quick-Win Status for Marketing Leverage

Ranking scale:
- Impact: Low/Medium/High
- Effort: S/M/L

1. [Done] Add plugin diagnostics (`doctor`) command and health endpoint.
- Impact: High
- Effort: S
- Why: Removes setup uncertainty and gives strong "self-healing/diagnosable" marketing claim.

2. [Done] Add outbox observability in UI (pending count and replay status badge).
- Impact: High
- Effort: S
- Why: Turns reliability behavior into visible proof users can trust.

3. [Done] Add run control shortcuts in dashboard (pause/resume/cancel/rollback buttons).
- Impact: High
- Effort: M
- Why: Converts backend control APIs into a strong operator workflow story.

4. [Done] Add "copy setup command" and API key source indicator in onboarding.
- Impact: Medium
- Effort: S
- Why: Lowers first-run friction and shortens time-to-value.

5. [Done] Publish canonical feature matrix in README and docs with concrete scenarios.
- Impact: High
- Effort: S
- Why: Current value is stronger than current external messaging; copy is lagging capabilities.

## 9) Immediate Improvement Implemented in This Session

- Automatic outbox replay on successful sync:
  - buffered `progress`, `decision`, and `artifact` events are retried and removed when delivered.
- Live snapshot now merges locally buffered outbox activity so users can see offline-captured events in dashboard views.
- Added diagnostics surfaces:
  - CLI command: `openclaw orgx doctor` (`--json`, `--no-remote`)
  - HTTP endpoint: `GET /orgx/api/health`
- Added outbox observability to dashboard header metrics/notifications:
  - pending outbox count
  - replay status/error signal
- Added onboarding setup convenience:
  - copy setup command button
  - API key source indicator chips
- Added run control shortcuts in Session Detail:
  - pause / resume / cancel actions
  - create checkpoint + rollback to latest checkpoint
