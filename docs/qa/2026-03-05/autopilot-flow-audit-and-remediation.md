# Autopilot Flow Audit + Remediation (2026-03-05)

## Scope
- Why Auto/Start looked non-persistent.
- What users expect vs what they actually saw in Activity + Mission Control.
- Concrete architecture and UX fixes shipped in this patch.

## Evidence Used
- Fresh QA capture bundle:
  - `docs/qa/2026-03-05/activity-view/desktop-01-baseline.png`
  - `docs/qa/2026-03-05/activity-view/desktop-02-detail-modal.png`
  - `docs/qa/2026-03-05/activity-view/mobile-01-activity.png`
  - `docs/qa/2026-03-05/mission-control/desktop-01-hierarchy-table.png`
  - `docs/qa/2026-03-05/mission-control/desktop-03-modal-workstream.png`
  - `docs/qa/2026-03-05/mission-control/mobile-01-mission-control.png`
- Prior live-run issue evidence:
  - `qa-artifacts/activity-audit-2026-03-04/21-activity-auto-off-before-toggle.png`
  - `qa-artifacts/activity-audit-2026-03-04/22-after-start-autopilot-activity-filtered-empty.png`
  - `qa-artifacts/activity-audit-2026-03-04/26-activity-after-autopilot-state-events.png`
  - `qa-artifacts/activity-audit-2026-03-04/34-mission-control-idle-blocked-after-autopilot-cycle.png`
  - `qa-artifacts/activity-audit-2026-03-04/activity-audit-issues.md`

## User Expectation vs Actual

### Before Pressing Start/Auto
- Expected:
  - Next Up has only executable work slices.
  - Auto toggle reflects true lifecycle target for the selected initiative.
  - In Progress, Decisions, and Blocked all agree on what is active.
- Actual (before this patch):
  - Target initiative drifted with queue focus changes.
  - Auto could show `Off` in Activity while Mission Control showed enabled/blocked context.
  - Runtime reporting/system slices could bleed into queue-derived state and inflate running counts.

### Pressing Start (single dispatch)
- Expected:
  - Immediate visual transition: queued slice becomes running in In Progress.
  - Activity feed shows dispatch event, then first execution event.
  - No unrelated filters auto-hide the feed.
- Actual:
  - Transition happened, but continuity was easy to lose when queue data mixed with non-work signals.

### Pressing Auto (initiative auto-continue)
- Expected:
  - Auto state sticks to one initiative context until explicitly stopped or resolved.
  - If blocked, UI should still show a persistent "needs intervention" state, not silently fall back to Off.
  - Resume should prefer the blocked initiative, not jump to unrelated queue items.
- Actual:
  - Activity toggle treated only `running/stopping` as "on", so blocked looked like "off".
  - Restart target could pick a different initiative than the previously blocked run.
  - Mission Control target was coupled to dynamic rail focus, creating perceived non-persistence.

## Happy Path Requirements
1. User presses `Start` on Next Up workstream.
2. Card transitions `queued -> running`.
3. Activity feed receives `dispatch -> slice started -> progress` sequence.
4. In Progress card tracks same workstream with stable lineage.
5. Detail modal opens and shows timeline + artifacts + decisions for that run.

## Sad Path Requirements
1. Auto run blocks on dependency/decision.
2. Auto control must show a persistent blocked state (`Hold`), not reset to `Off`.
3. Feed event click must route to decision/blocker context with explicit resolution action.
4. Resume action should target the same initiative by default.

## Root Causes
1. Multiple control planes in UI:
   - Activity and Mission Control derived Auto state differently.
2. Moving target initiative:
   - Mission Control bound Auto status to rail focus (`nowWorking/nextQueued`) instead of active/blocked Auto context.
3. Queue contamination:
   - Slices fallback path did not strictly enforce `sliceKind=work_slice`.

## Fixes Implemented

### 1) Stable Auto target in Mission Control
- Auto status now anchors to queue items with active or blocked Auto lineage before falling back to rail focus.
- File:
  - `dashboard/src/components/mission-control/MissionControlView.tsx`

### 2) Activity Auto state is lifecycle-aware (running/stopping/blocked/idle)
- Added deterministic context derivation from queue items by recency.
- Auto badge now shows `Hold` for blocked state and keeps intervention context visible.
- Resume path prefers blocked initiative when restarting Auto.
- File:
  - `dashboard/src/App.tsx`

### 3) Strict work-slice filtering for queue fallbacks
- Canonical and slices->queue mapping now drop non-`work_slice` records.
- Prevents runtime reporting/system slices from polluting Next Up and running counts.
- Files:
  - `src/http/routes/mission-control-read.ts`
  - `dashboard/src/hooks/useNextUpQueue.ts`
  - `dashboard/src/types.ts` (typed `sliceKind` + `updatedAt` support)

## Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run qa:capture -- --date 2026-03-05 --skip-build --verbose` completed and generated screenshots/videos.

## Remaining Gaps
- Local QA run used demo/static flow for screenshots; live OrgX endpoints were unavailable in that harness run (404s on `/orgx/api/live/*`).
- Full production-like validation should re-run the same flow against connected live endpoints and compare:
  - Auto button state continuity across Activity + Mission Control.
  - Next Up running count vs In Progress/Decision/Blocked totals.
  - Timeline/detail modal intervention flow (decision resolution -> resume).
