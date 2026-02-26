# OrgX Live UI P0 Contract Matrix

Last updated: 2026-02-26

## Goal

Define the minimum, non-negotiable UI contracts for `/orgx/live` so regressions in autopilot, next-up, activity, and decisions are caught before release.

## Scope

- Surface: `Activity`, `Mission Control`, right-rail (`In Progress`, `Next Up`, `Decisions`)
- Data sources: `/orgx/api/live/snapshot`, `/orgx/api/live/initiatives`, `/orgx/api/live/decisions`, `/orgx/api/mission-control/next-up`
- Workspace scope: `workspace_id` / `command_center_id` / `center` query params

## P0 Contracts

| ID | Contract | Verification | Pass Criteria |
| --- | --- | --- | --- |
| `P0-1` | Live shell renders three primary panes (agents, activity, right rail) | `scripts/agent-browser-live-ui-p0-audit.mjs` | Each pane is visible and not stuck in loading state > 45s |
| `P0-2` | Autopilot state is visible and actionable | `scripts/agent-browser-live-ui-p0-audit.mjs` | Autopilot control exists and exposes explicit state (`On`, `Off`, or `Idle`) |
| `P0-3` | Agent panel shows active session rows when session count > 0 | `scripts/agent-browser-live-ui-p0-audit.mjs` + snapshot cross-check | If live sessions exist, at least one session row appears under agent cards |
| `P0-4` | Next Up rows expose actionable controls | `scripts/agent-browser-live-ui-p0-audit.mjs` | First visible next-up card shows at least one execution action (`Start`, `Pause`, `Resume`) plus a secondary action button (`More` or menu trigger) |
| `P0-5` | Decisions count and list are consistent with API | `scripts/agent-browser-live-ui-p0-audit.mjs` | If `/live/decisions` returns pending rows, UI does not present an empty decisions state |
| `P0-6` | Next Up initiatives are a subset of live initiatives for the same scope | `scripts/agent-browser-live-ui-p0-audit.mjs` (API cross-check) | Every `initiativeId` in next-up appears in `/live/initiatives` for the same scope |
| `P0-7` | Slice completion emits UI-required metadata | `tests/http/autopilot-slice-lifecycle.test.mjs` | `autopilot_slice_result` metadata includes run/initiative/workstream/task linkage + summary fields |
| `P0-8` | Decision and handoff lifecycle metadata are present in activity stream | `tests/http/autopilot-slice-lifecycle.test.mjs` | Activity payloads include structured fields used by timeline/detail modals (`event`, `user_summary`, `next_actions`, `activity_bucket`) |

## Release Gate

All P0 checks must pass before merge for:

- Autopilot lifecycle changes
- Activity feed / decision UX changes
- Workspace scoping changes
- Next-up interaction changes

## Runbook

```bash
# API + lifecycle metadata contracts
npm run test:file tests/http/autopilot-slice-lifecycle.test.mjs

# Live UI P0 audit against local plugin host
node scripts/agent-browser-live-ui-p0-audit.mjs
```

## Notes

- This matrix is intentionally small and strict. Additions should only be made when a regression escaped existing P0 coverage.
- Visual polish (spacing, animation quality, copy tone) remains covered by focused QA captures, but P0 contracts here protect core trust signals first.
