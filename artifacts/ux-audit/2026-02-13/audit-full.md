# OrgX Live UX Audit (Jony Ive 10/10 Bar)

Date: 2026-02-13
Surface: `http://127.0.0.1:18789/orgx/live`
Evidence:
- Activity (20 cards + 20 detail modals): `artifacts/ux-audit/2026-02-13/run-full-154609`
- Sessions (8 sessions available in offline/demo at time of capture): `artifacts/ux-audit/2026-02-13/run-152713`

## Non-Negotiable Product Standard

The UI must behave like a calm instrument:
- **Meaning first** (human intent) and **mechanics last** (ids, hashes, internal event types).
- Every surface must answer: **What happened, why it matters, what I should do**.
- “Debug” is a mode, not a vibe. Default must be legible to a non-operator.

---

## Global Issues (Systemic)

### 1) Card surface looks like a log viewer
Symptoms:
- Chips encode event types (`decision requested`, `artifact created`), hashes (`#ebc7`, `#7d1e`, `#a4fb`), and pipeline labels (`delegation`).
- Too many parallel metadata lines.

Fix:
- Card gets at most:
  - 1 category chip (Decision/Artifact/Update/Error/System)
  - 1 context chip (Initiative or Session)
  - 1 time indicator (relative)
- All ids/hashes move to detail under a `Debug` accordion.

### 2) Duplicate semantics everywhere
Examples:
- Title says `Decision requested` and also `DECISION` and also `decision requested` chip.
- Detail repeats title as Summary as Details.

Fix:
- Category is implied by bucket color + one chip.
- Title should be the meaningful sentence.
- Summary should be different from title or omitted.

### 3) Wrong information in thread view
Evidence: `dashboard/src/components/activity/ThreadView.tsx` uses `humanizeModel(item.description)`.

Fix:
- Only show model if you have a dedicated field.
- Otherwise remove model line entirely.

### 4) “System noise” is not correctly classified
Examples:
- Titles beginning with `User: System:` or containing stack traces, JSON fragments, SIGKILL.

Fix:
- Auto-detect and collapse into a `System error` component:
  - Title: “Execution failed”
  - Subtitle: agent + run + task
  - Body: 1 sentence explanation + suggested action
  - Raw logs hidden.

### 5) Detail modal is a tooling inspector
Evidence: activity detail modal top row foregrounds copy buttons + navigation.

Fix:
- Meaning stack at top:
  - Title
  - Actor line
  - One-line summary
  - CTA(s)
- Copy/navigate moved into overflow menu.

---

## Activity Feed Audit (Per Card + Detail)

Format:
- Evidence: card + detail screenshot
- Confusions / hierarchy failures
- What should be hidden
- What should become a dedicated component

### Activity 0001
Evidence:
- `run-full-154609/shots/activity-cards/card-0001.png`
- `run-full-154609/shots/activity-details/detail-0001.png`

Confusions:
- Generic title on card instead of the real question.
- Duplicate category labeling (title + chips).
- Detail repeats content (title/summary/details same).

Hide:
- Copy buttons by default.

Component:
- `DecisionCard` with clear ask + urgency + CTA (`Review`).

### Activity 0002
Evidence:
- `run-full-154609/shots/activity-cards/card-0002.png`
- `run-full-154609/shots/activity-details/detail-0002.png`

Confusions:
- System phrasing: “Artifact created” vs user meaning (“3 variants ready”).
- No artifact preview or affordance to open artifact.

Hide:
- Literal event type chip.

Component:
- `ArtifactCard` with preview/count and single CTA.

### Activity 0003
Evidence:
- `run-full-154609/shots/activity-cards/card-0003.png`
- `run-full-154609/shots/activity-details/detail-0003.png`

Confusions:
- Doesn’t say clearly who received the delegation.

Component:
- `DelegationCard` showing `From -> To` and delegated task.

### Activity 0004
Evidence:
- `run-full-154609/shots/activity-cards/card-0004.png`
- `run-full-154609/shots/activity-details/detail-0004.png`

Confusions:
- Reads like internal mechanism. “1 operation” is content-free.
- Hash chips have no meaning.

Hide:
- Hide from default feed or group under `System` collapsed.

Component:
- `SystemEventCard` (subdued) with human rewrite.

### Activity 0005
Evidence:
- `run-full-154609/shots/activity-cards/card-0005.png`
- `run-full-154609/shots/activity-details/detail-0005.png`

Confusions:
- Another replay/system-style event: should not compete visually with human work.

Hide:
- Hash chips.

Component:
- `SystemReplayCard` only if user toggles “Show system events”.

### Activity 0006
Evidence:
- `run-full-154609/shots/activity-cards/card-0006.png`
- `run-full-154609/shots/activity-details/detail-0006.png`

Confusions:
- If this is a heartbeat/telemetry type message, it should be suppressed or grouped.

Hide:
- Heartbeat events by default.

Component:
- `HeartbeatCluster` collapsed (“xN heartbeats”).

### Activity 0007
Evidence:
- `run-full-154609/shots/activity-cards/card-0007.png`
- `run-full-154609/shots/activity-details/detail-0007.png`

Confusions:
- Long title likely includes internal status; truncation hides meaning.

Fix:
- Ensure first 60 chars are meaningful; push internal tokens to second line.

### Activity 0008
Evidence:
- `run-full-154609/shots/activity-cards/card-0008.png`
- `run-full-154609/shots/activity-details/detail-0008.png`

Confusions:
- “Buffered retro for session #7d1e” is unclear. Retro of what? Why buffered? What do I do?

Hide:
- `#7d1e` unless “debug”.

Component:
- `RetroOutcomeCard` with label “Retro captured” + link to outcome artifact.

### Activity 0009
Evidence:
- `run-full-154609/shots/activity-cards/card-0009.png`
- `run-full-154609/shots/activity-details/detail-0009.png`

Confusions:
- If this is a run failure, it must be styled and worded distinctly.

Component:
- `ErrorCard` with remediation suggestion.

### Activity 0010
Evidence:
- `run-full-154609/shots/activity-cards/card-0010.png`
- `run-full-154609/shots/activity-details/detail-0010.png`

Confusions:
- Card begins with `User: [timestamp] Execution policy ...`.
- This is catastrophic information hierarchy: we show the internal “operating system” instead of the work.

Hide:
- All policy/debug lines.

Component:
- `SystemDirectiveCard` (if needed) or suppress entirely.

### Activity 0011
Evidence:
- `run-full-154609/shots/activity-cards/card-0011.png`
- `run-full-154609/shots/activity-details/detail-0011.png`

Confusions:
- Similar to 0010 class: execution policy/log spew.

Fix:
- Same reclassification.

### Activity 0012
Evidence:
- `run-full-154609/shots/activity-cards/card-0012.png`
- `run-full-154609/shots/activity-details/detail-0012.png`

Confusions:
- Likely another system/heartbeat/update with little human value.

Fix:
- Collapse into “System noise” cluster.

### Activity 0013
Evidence:
- `run-full-154609/shots/activity-cards/card-0013.png`
- `run-full-154609/shots/activity-details/detail-0013.png`

Confusions:
- If “Exec failed / SIGKILL” appears, default title should not include it.

Fix:
- “Execution failed” + “view logs”.

### Activity 0014
Evidence:
- `run-full-154609/shots/activity-cards/card-0014.png`
- `run-full-154609/shots/activity-details/detail-0014.png`

Confusions:
- System framing again; needs human rewrite and/or suppression.

### Activity 0015
Evidence:
- `run-full-154609/shots/activity-cards/card-0015.png`
- `run-full-154609/shots/activity-details/detail-0015.png`

Confusions:
- Truncation with internal tokens likely.

Fix:
- Ensure title starts with verb/object.

### Activity 0016
Evidence:
- `run-full-154609/shots/activity-cards/card-0016.png`
- `run-full-154609/shots/activity-details/detail-0016.png`

Confusions:
- If this is a completion, show result not mechanism.

### Activity 0017
Evidence:
- `run-full-154609/shots/activity-cards/card-0017.png`
- `run-full-154609/shots/activity-details/detail-0017.png`

Confusions:
- If this is an artifact or decision, it should use its dedicated component rather than generic message card.

### Activity 0018
Evidence:
- `run-full-154609/shots/activity-cards/card-0018.png`
- `run-full-154609/shots/activity-details/detail-0018.png`

Confusions:
- Genericization and chip overload.

### Activity 0019
Evidence:
- `run-full-154609/shots/activity-cards/card-0019.png`
- `run-full-154609/shots/activity-details/detail-0019.png`

Confusions:
- System noise vs user value needs clearer sorting.

### Activity 0020
Evidence:
- `run-full-154609/shots/activity-cards/card-0020.png`
- `run-full-154609/shots/activity-details/detail-0020.png`

Confusions:
- Same pattern: too much mechanism.

---

## Session UX Audit (8 Sessions Available)

You asked for 20 sessions; in offline/demo mode at capture time, the UI only exposed 8 sessions.

Evidence directory: `artifacts/ux-audit/2026-02-13/run-152713/shots/sessions`

### Session 001
Evidence:
- `run-152713/shots/sessions/session-row-001.png`
- `run-152713/shots/sessions/thread-001.png`
- `run-152713/shots/sessions/drawer-001.png`

Confusions:
- Row: `AGENT` pill is redundant and eats attention.
- Drawer: `BREADCRUMB` label is unnecessary; breadcrumb repeats the same label.
- `Continue Priority` vs `Dispatch Session` distinction is unclear.
- Controls have equal weight; destructive actions are visually adjacent.
- “Recent messages: none” while the user can see activity; mismatch in mental model.

### Session 002
Evidence:
- `run-152713/shots/sessions/session-row-002.png`
- `run-152713/shots/sessions/thread-002.png`
- `run-152713/shots/sessions/drawer-002.png`

Confusions:
- Thread view does not show the actual conversation content; it’s a list of event headlines.

### Session 003
Evidence:
- `run-152713/shots/sessions/session-row-003.png`
- `run-152713/shots/sessions/thread-003.png`
- `run-152713/shots/sessions/drawer-003.png`

Confusions:
- Drawer: empty fields (`ETA —`, `Checkpoints —`) should collapse.

### Session 004
Evidence:
- `run-152713/shots/sessions/session-row-004.png`
- `run-152713/shots/sessions/thread-004.png`
- `run-152713/shots/sessions/drawer-004.png`

Confusions:
- Too many CTAs at once; doesn’t guide user to the correct action.

### Session 005-008
Evidence:
- `run-152713/shots/sessions/session-row-005.png` ... `session-row-008.png`
- `run-152713/shots/sessions/thread-005.png` ... `thread-008.png`
- `run-152713/shots/sessions/drawer-005.png` ... `drawer-008.png`

Common issues:
- Thread “timeline” is aesthetic but not informative.
- No artifact preview in-thread.
- No decision state in-thread.

---

## Timeline (Thread View) Specific Issues

Evidence:
- `run-152713/shots/sessions/thread-*.png`

Issues:
- The header chips (provider/model/tier/kickoff hash) are operator metadata.
- Per-event rows do not expose the payload.

Fix:
- Replace with typed rows (Message/Tool/Artifact/Decision/Error).
- Move provenance to collapsible info.

---

## Priority Fix List (Highest Leverage)

1. Rebuild activity card hierarchy: 2 chips max, meaning-first titles, suppress system noise.
2. Redesign activity detail modal: meaning stack first; debug behind overflow.
3. Thread view: show real message content previews and typed rows; remove the bogus “model” line.
4. Session drawer: progressive disclosure for controls; collapse empty fields.
5. Add a “Show system events” toggle and default it off.

---

## What’s Missing To Satisfy “Click Through 20 Sessions”

We need at least 20 sessions visible in the UI.
Options:
1) Connect OrgX successfully so real session history appears.
2) Expand `dashboard/src/data/mockData.ts` to generate 20+ sessions with a realistic distribution (decisions, artifacts, errors), then rerun capture.
