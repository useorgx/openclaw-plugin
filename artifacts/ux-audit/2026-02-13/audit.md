# OrgX Live UX Audit (Jony Ive Bar)

Date: 2026-02-13
Source: `http://127.0.0.1:18789/orgx/live`
Evidence run: `artifacts/ux-audit/2026-02-13/run-152713`

## Scope + What Was Actually Audited

- Activity feed cards captured: 18
- Activity detail modals captured: 18
- Session list items clicked: 8 (limited by what was present in the UI at capture time)
- Session thread views captured: 8
- Session detail drawer captured: 8

Notes:
- The gateway was not connected to OrgX; the dashboard was entered via the onboarding screen and then into offline/demo data.
- Because only 8 sessions were present in the UI in this mode, a “20 session” clickthrough is not possible without more session data in the feed.

---

## Design Principles (The Bar)

- Every card should answer: **What happened, why does it matter, what should I do next**.
- Prefer **one primary label** per card. All other metadata should either:
  - collapse into a secondary line,
  - live in the detail view,
  - or be hidden behind an “Info” affordance.
- The system must preserve **semantic hierarchy**:
  - Title: human meaning
  - Subtitle: actor + context
  - Meta: time, identifiers, provenance
- Never show raw IDs/hashes unless the user explicitly asked or toggled “debug”.
- “Detail” should reveal **the payload that matters** and default to human language; raw JSON belongs behind a “Raw” toggle.

---

## Global Issues (Across Most Cards)

1. **Tag explosion / confetti metadata**
   - Cards routinely show 4-7 chips: primary tag + run label + event type + relative time + initiative + workstream + etc.
   - This reads as a tooling console, not a product surface.
   - Recommendation: constrain to 2 chips max on the card surface (primary state + one context chip). Move the rest into detail.

2. **Duplicate semantics**
   - Example: `Decision requested` appears as title; a chip says `DECISION`; another chip says `decision requested`; summary repeats title.
   - Recommendation: remove duplicate layers. Make “Decision” the category; make the title the actual question/ask.

3. **Inconsistent “who” hierarchy**
   - Sometimes the actor is in subtitle, sometimes implied by avatar, sometimes both.
   - Recommendation: card should show one consistent actor line: `Dana (Design) · Running` or `OrgX · System`.

4. **Debug leakage on primary surfaces**
   - We have cards whose title begins with `User: System: [timestamp] Exec failed ...` and includes raw runtime noise.
   - Recommendation: automatically classify these as `System error` and show a clean title + one-line human explanation; keep full stderr in detail.

5. **Time duplication**
   - Cards show absolute time top-right and also relative time in chips.
   - Recommendation: pick one on card. Prefer relative (“2m ago”) and move absolute into detail.

6. **Color semantics not tight**
   - Rails and chips use accent color; good, but multiple accents compete.
   - Recommendation: one accent per card (by bucket). Secondary badges should be neutral.

---

## Activity Feed: Per-Item Issues

Below: each activity item references its captured evidence.

### Activity 0001 (Decision requested)
Evidence:
- Card: `run-152713/shots/activity-cards/card-0001.png`
- Detail: `run-152713/shots/activity-details/detail-0001.png`

Issues:
- Title is generic (`Decision requested`) instead of the actual ask (which exists in description).
- Chip redundancy: `DECISION` + `decision requested` is the same information twice.
- Detail view repeats the same sentence in Title, Summary, Details. No new information is revealed.
- The detail header shows navigation + copy controls before meaning; feels like a debug inspector.

Hide / Move:
- Hide `Copy run`, `Copy agent`, `Copy event` behind a “More” menu or debug toggle.

Componentization:
- Decision card component should be distinct:
  - Primary: the question/ask
  - Secondary: decision owner + consequence + due/urgency
  - CTA: `Review` (not just “open detail”)

### Activity 0002 (Artifact created: Subject line variants)
Evidence:
- Card: `run-152713/shots/activity-cards/card-0002.png`
- Detail: `run-152713/shots/activity-details/detail-0002.png`

Issues:
- “Artifact created” is system phrasing; user meaning is “3 subject lines ready for review”.
- Chips: `UPDATE`, initiative, `artifact created`, time, and extra context; too many.

Hide / Move:
- The literal event type (`artifact created`) should not be shown as a chip when the title already expresses it.

Componentization:
- Artifact card should show a preview snippet or count (e.g. “3 variants”), and a single CTA: `View artifact`.

### Activity 0003 (Task delegated)
Evidence:
- Card: `run-152713/shots/activity-cards/card-0003.png`
- Detail: `run-152713/shots/activity-details/detail-0003.png`

Issues:
- “delegation” chip is jargon; user meaning is “Eli asked Data agent to do X”.
- The card doesn’t clarify: delegated to whom? (Often missing on the card surface.)

Componentization:
- Delegation card should show: `From → To` and the delegated task in plain language.

### Activity 0004 (Changeset replayed)
Evidence:
- Card: `run-152713/shots/activity-cards/card-0004.png`
- Detail: `run-152713/shots/activity-details/detail-0004.png`

Issues:
- This is implementation detail (outbox replay), not human work.
- “1 operation” is meaningless without what operation changed.
- Chips like `#ebc7` and `milestone completed` read like internal ids.

Hide / Move:
- This should be hidden by default in Activity (or grouped under “System”).
- If shown, rewrite as: “Milestone marked complete (replayed after reconnect)”.

Componentization:
- System event component with subdued styling; collapsible by default.

### Activity 0005-0018
Evidence:
- Cards: `run-152713/shots/activity-cards/card-0005.png` ... `card-0018.png`
- Details: `run-152713/shots/activity-details/detail-0005.png` ... `detail-0018.png`

Common issues repeated:
- Long titles truncate without a “why” or “status” line.
- Chips encode ids/hashes (`#a4fb`, `#2f7e`) that have no meaning to humans.
- Some events appear to be raw model/tool output; needs humanization layer.

Actionable rule:
- If an activity title contains any of: `Exec failed`, `SIGKILL`, JSON fragments, stack traces
  - classify bucket = `System error`
  - card title = “Execution failed”
  - subtitle = which agent, which task
  - summary = 1 sentence + recommended user action
  - raw payload only in detail under “Raw logs”

---

## Sessions: Clickthrough Audit (8 Sessions)

Each session includes:
- the session row (left rail)
- the activity thread view (center)
- the session detail drawer (right)

### Session 001 (Q4 Feature Ship – Planning)
Evidence:
- Row: `run-152713/shots/sessions/session-row-001.png`
- Thread: `run-152713/shots/sessions/thread-001.png`
- Drawer: `run-152713/shots/sessions/drawer-001.png`

Issues:
- Session row’s hierarchy is unclear: title vs status vs timestamp vs the “AGENT” pill. “AGENT” reads like redundant labeling.
- Drawer shows `BREADCRUMB` as a label, but the breadcrumb itself repeats the session title; feels circular.
- “Quick actions” includes `Continue Priority` (unclear what it will do) and `Dispatch Session` (unclear difference).
- “Session controls” show 5 actions with equal weight; risk of misuse.
- “Recent messages: none” contradicts the idea that there is activity in thread view; the mapping is unclear.

Hide / Move:
- `ETA —`, `Checkpoints —` should collapse when empty.

Hierarchy fix:
- Drawer top should be: Session title + 1-line human summary + status pill.
- Controls should be progressive disclosure: show only 1-2 safe actions; rest under “More controls”.

### Session 002-008
Evidence:
- Rows: `run-152713/shots/sessions/session-row-002.png` ... `session-row-008.png`
- Threads: `run-152713/shots/sessions/thread-002.png` ... `thread-008.png`
- Drawers: `run-152713/shots/sessions/drawer-002.png` ... `drawer-008.png`

Common issues:
- Thread view models: it displays a “model” line derived from `item.description` (see `ThreadView.tsx`), which is wrong semantically and produces confusing output.
- Thread event list is pretty, but doesn’t tell the user what the turn actually contains; no preview of content, no link to artifact, no decision state.
- Timeline dot icons are nice but not meaningfully grouped: decisions/artifacts/errors should create sections.
- Drawer: multiple buttons use strong accent backgrounds simultaneously (Pause/Resume/Checkpoint/Rollback/Cancel). This breaks hierarchy.

---

## Timeline (Thread View) Issues

Evidence:
- `run-152713/shots/sessions/thread-001.png` etc.

Issues:
- Title: ok.
- The meta chips at top include: domain/provider/model/tier/kickoff hash/status. This is too much for default.
- The per-turn lines do not show enough of the actual human payload.

Hide / Move:
- Provider/model/tier/kickoff hash belong behind an “Info” drawer.

Componentization:
- Thread should render different row components for:
  - Message
  - Tool call
  - Artifact created (preview + open)
  - Decision requested (question + approve/reject state)
  - Error (human summary + “view logs”)

---

## Specific High-Severity Confusions To Fix First

1. Activity detail view should not be an inspector by default.
   - Put meaning first, debug last.
2. Remove id/hash chips from cards.
3. Reduce chip count: 2 max on card.
4. Fix the “model” line in thread view (it currently uses `description` as model).
5. Session drawer controls need hierarchy and safer defaults.

---

## Next Data Needed To Complete Your Original Ask

To audit “20 sessions in the agent chat”, we need at least 20 sessions present in the UI (connected mode or a larger mock dataset).

If you want, I can:
1) expand the mock dataset to 20+ sessions with realistic activity variety (errors, artifacts, decisions), then rerun this automated capture; or
2) run the capture against a connected OrgX workspace once the pairing timeout is resolved.
