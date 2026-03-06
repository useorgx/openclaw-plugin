# Activity + Mission Control UX Audit (Issue Collection Only)

Date: 2026-03-04  
Surface: `http://127.0.0.1:18789/orgx/live`  
Workspace scope observed: `OrgX Business`

## Audit Coverage

- Pressed/observed Auto and Start Autopilot controls on Activity + Mission Control.
- Captured timeline and agent panel state changes over time until Autopilot returned to idle/blocked.
- Opened activity detail modal and traversed 50 sessions via next/previous controls.
- Collected console + network logs and local autopilot output log summary.

## Evidence Bundle

- Baseline and state-transition screenshots:
  - `01-baseline-mission-control-before-start.png`
  - `21-activity-auto-off-before-toggle.png`
  - `22-after-start-autopilot-activity-filtered-empty.png`
  - `23-activity-after-clear-filters-mixed-statuses.png`
  - `24-mission-control-idle-before-start-autopilot.png`
  - `25-mission-control-after-start-autopilot-enabled.png`
  - `26-activity-after-autopilot-state-events.png`
  - `32-activity-running-state-after-modal-close.png`
  - `33-activity-30s-later-running-still-not-idle.png`
  - `34-mission-control-idle-blocked-after-autopilot-cycle.png`
- Modal evidence (specific):
  - `27-modal-autopilot-running-to-blocked.png`
  - `28-modal-autopilot-sequence.png`
  - `29-modal-autopilot-sequence.png`
  - `30-modal-autopilot-sequence.png`
  - `31-modal-autopilot-sequence.png`
- Full modal walk-through:
  - `modal-walk/modal-01.png` through `modal-walk/modal-50.png`
- Logs:
  - `console-errors.log`
  - `network-requests.log`
  - `autopilot-output-summary.txt`

## Findings

1. Autopilot control state is inconsistent across surfaces.
- Symptom: Mission Control can show `Enabled`/`Autopilot Active` while the primary button still reads `Start Autopilot`; Activity rail still shows `AUTO Off`.
- User confusion: unclear whether automation is actually on.
- Evidence: `24-mission-control-idle-before-start-autopilot.png`, `25-mission-control-after-start-autopilot-enabled.png`, `26-activity-after-autopilot-state-events.png`, `34-mission-control-idle-blocked-after-autopilot-cycle.png`.

2. Activity rail `Start autopilot` interaction causes unexpected filter side effect.
- Symptom: clicking the apparent autopilot control routes to/sets a workstream filter and empties timeline (`No activity yet for this workstream`), rather than clearly toggling global autopilot state.
- User confusion: control intent is ambiguous; user loses timeline context immediately after action.
- Evidence: `21-activity-auto-off-before-toggle.png`, `22-after-start-autopilot-activity-filtered-empty.png`.

3. Status churn/relabeling on existing events creates contradictory timeline semantics.
- Symptom: entries previously shown as `Completed` later render as `Issue`/blocked-style chips without clear causal explanation.
- User confusion: users cannot trust historical event state in feed.
- Evidence: `23-activity-after-clear-filters-mixed-statuses.png`, `32-activity-running-state-after-modal-close.png`, `33-activity-30s-later-running-still-not-idle.png`, `modal-walk/modal-*.png`.

4. Autopilot event sequence shows conflicting state story in a short window.
- Symptom: feed records `Autopilot enabled` -> `idle → running` -> `stopped: blocked` -> `running → blocked`, while UI controls and headers do not present a single coherent current state.
- User confusion: hard to determine whether system is running, stopped, or blocked right now.
- Evidence: `26-activity-after-autopilot-state-events.png`, `27-modal-autopilot-running-to-blocked.png`, `28-modal-autopilot-sequence.png`, `29-modal-autopilot-sequence.png`.

5. Agent panel metrics conflict with header metrics.
- Symptom: header/topline and left agent panel counts drift (`4 active` while header shows `6`/`8 running`, multiple per-agent run counts changing rapidly).
- User confusion: operators cannot quickly trust health/throughput numbers.
- Evidence: `23-activity-after-clear-filters-mixed-statuses.png`, `32-activity-running-state-after-modal-close.png`, latest snapshots during modal walk.

6. Mission Control top status and now-working rail are semantically misaligned.
- Symptom: top Autopilot status can show `Idle · blocked` while the now-working strip still indicates active running context and action buttons (`Pause/Defer/Auto/Open queue`).
- User confusion: appears simultaneously idle and active.
- Evidence: `34-mission-control-idle-blocked-after-autopilot-cycle.png`.

7. Repeated degraded-sync/toast overlays interfere with critical controls.
- Symptom: `Live degraded` toast repeatedly overlays control region during key actions.
- User confusion: controls appear unstable/obscured at decision moments.
- Evidence: `24-mission-control-idle-before-start-autopilot.png`, `34-mission-control-idle-blocked-after-autopilot-cycle.png`.

8. Activity detail endpoint errors are visible during modal navigation.
- Symptom: console shows `410 Gone` for activity detail request.
- User confusion: detail continuity can break while navigating historical items.
- Evidence: `console-errors.log`.

9. Data transport instability during polling/fallback cycles.
- Symptom: repeated `net::ERR_ABORTED` on `snapshot-v2` and `dashboard-bundle` requests with fallback to legacy endpoints.
- User confusion: perceived flicker/state instability and unexplained relabeling.
- Evidence: `network-requests.log`.

10. Backend/autopilot output artifacts indicate completed runs while timeline often presents blocked/issue framing.
- Symptom: output summaries show repeated `status: completed` with artifacts, while feed often emphasizes `Issue`/blocked semantics.
- User confusion: completion vs blocked narrative is not reconciled in UI.
- Evidence: `autopilot-output-summary.txt`, `32-activity-running-state-after-modal-close.png`, `33-activity-30s-later-running-still-not-idle.png`, `modal-walk/modal-*.png`.

## Note

This document is intentionally issue collection only. No fixes or remediation proposals are included here.
