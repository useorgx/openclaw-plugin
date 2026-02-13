# OrgX Live Dashboard UX Audit
**Date:** 2026-02-13
**Scope:** `/orgx/live` - Activity Feed, Agent Chats, Session Modals, Timeline
**Standard:** Jony Ive-level attention to detail - every pixel, every interaction, every label

---

## Executive Summary

The OrgX live dashboard has strong visual foundations - a cohesive dark glassmorphism palette, thoughtful color semantics (lime/teal/red/amber), and professional-grade animations. But beneath the surface polish, there are **42 specific UX issues** across 10 categories that create friction, confusion, and cognitive overhead. The experience is currently a 6.5/10. The fixes below bring it to 10/10.

---

## ISSUE 1: Information Architecture Collision

### 1.1 Two Competing Activity Systems
**Severity:** Critical
**Files:** `ActivityStream.tsx`, `ActivityTimeline.tsx`

There are **two completely separate activity feed components** - `ActivityStream` (legacy paginated list with "All/Artifacts/Decisions" tabs) and `ActivityTimeline` (advanced with deduplication, clustering, detail panel, keyboard nav). Both exist in the codebase and render different UIs for the same data.

**What's confusing:** A user cannot predict which view they'll see. The legacy `ActivityStream` uses manual pagination (10 items/page with prev/next buttons), while `ActivityTimeline` uses progressive rendering (240-item chunks with intersection observer). The filter vocabularies differ: "All/Artifacts/Decisions" vs. "All/Messages/Artifacts/Decisions". The sort controls exist only in the timeline.

**Fix:** Retire `ActivityStream.tsx` entirely. The `ActivityTimeline` is strictly superior. Keep one canonical activity view. Remove the "Messages" filter from `ActivityTimeline` (or rename "All" to "Everything") so the filter set is: **Everything | Artifacts | Decisions** - three buckets, zero ambiguity.

---

### 1.2 Thread View vs. Detail Panel - Two Ways to See One Thing
**Severity:** High
**Files:** `ActivityTimeline.tsx` (inline detail panel), `ThreadView.tsx`

Clicking a single activity item opens an **inline detail panel** on the right side of the timeline. But selecting a single session switches to a completely different **ThreadView** with its own layout, header, turn-by-turn breakdown, and back button. These are two unrelated interaction models for "I want to see more about this thing."

**What's confusing:** There's no visual indication that clicking a session will replace the entire timeline view. The detail panel slides in; the thread view teleports you away. The detail panel has structured/JSON toggle and LLM-powered headlines. The thread view has none of that - it has cost/duration/provenance metadata instead.

**Fix:** Unify into one progressive-disclosure model:
1. Click any item -> side panel (current detail panel behavior)
2. Side panel has a "View full session" link that opens the thread view **within** the side panel, not replacing the whole timeline
3. Both views share the same metadata: cost, duration, model, provenance, summary

---

## ISSUE 2: Inconsistent Navigation Patterns

### 2.1 Back Button Inconsistency
**Severity:** High
**Files:** `ThreadView.tsx`, `AgentDetailModal.tsx`, `EntityDetailModal.tsx`

- `ThreadView`: Text link "Back to timeline" with left chevron, positioned top-left
- `AgentDetailModal`: No back button; has breadcrumb "Agents > Agent Name" at top
- `EntityDetailModal`: Has breadcrumbs but they're non-clickable labels (except initiative link in task detail), plus a circular X close button top-right

**What's confusing:** Three different back/close/navigation patterns for three similar contexts. Users build muscle memory for one and get surprised by the others.

**Fix:** Standardize on one pattern:
- **All modals:** Breadcrumb at top-left (clickable for drill-up) + round X close button top-right
- **All inline views:** Same breadcrumb + "Back to [parent]" as the first breadcrumb crumb, clickable
- Remove the standalone back button from ThreadView; use the breadcrumb pattern instead

---

### 2.2 Keyboard Navigation Only in Timeline
**Severity:** Medium
**Files:** `ActivityTimeline.tsx`

The timeline detail panel supports arrow keys and L/H for prev/next navigation. No other view supports keyboard navigation. Session modals, entity modals, agent modals, and the chat panel are all mouse-only.

**What's confusing:** Power users who discover keyboard nav in the timeline expect it everywhere. It works in exactly one place.

**Fix:** Add keyboard navigation to all modal contexts:
- Left/Right arrows to navigate between items in any list-backed modal
- Escape to close (already works via Modal.tsx)
- Tab cycling within modals (already works via focus trap)

---

## ISSUE 3: Status Label Chaos

### 3.1 Seven Different Status Vocabularies
**Severity:** Critical
**Files:** `entityStatusColors.ts`, `AgentsChatsPanel.tsx`, `tokens.ts`, `types.ts`

Status labels across the dashboard:

| Context | Active States | Done States | Blocked States |
|---------|-------------|------------|----------------|
| Initiatives | `active` | `completed` | `blocked`, `paused` |
| Tasks | `in_progress`, `active` | `done`, `completed` | `blocked` |
| Sessions | `running`, `active`, `queued`, `pending`, `in_progress`, `working`, `planning` | `completed` | `blocked`, `failed` |
| Activity | `run_started`, `run_completed`, `run_failed` | - | - |
| Agent modals | "Active", "Blocked", "Idle" | - | - |

**What's confusing:** `active` and `in_progress` mean the same thing but appear differently. `done` vs. `completed` is arbitrary. Sessions have **seven** different active-state labels. A user sees "running" in one place and "active" in another for the same agent doing the same thing.

**Fix:** Normalize to exactly 5 user-facing status labels:
- **Active** (lime) - maps from: running, active, queued, pending, in_progress, working, planning
- **Paused** (amber) - maps from: paused, draft
- **Blocked** (red) - maps from: blocked, failed
- **Done** (teal) - maps from: done, completed, archived, cancelled
- **Planned** (gray) - maps from: todo, planned

Display the normalized label everywhere. Store whatever the API sends internally; transform at render time via a single `normalizeStatus()` utility.

---

### 3.2 Status Colors Conflict
**Severity:** Medium
**Files:** `AgentsChatsPanel.tsx:60-75`, `entityStatusColors.ts`

`in_progress` is **amber** in `AgentsChatsPanel` (`colors.amber`) but **lime** in `entityStatusColors.ts` (`bg-[#BFFF00]/10`). `queued` is amber in chats but doesn't exist in entity status. `paused` is gray (`rgba(255,255,255,0.5)`) in chats but amber (`#F5B700`) in entity status.

**What's confusing:** The same status shows different colors in different panels. A user learns "amber = warning" from one context and "amber = active" from another.

**Fix:** One `statusColor()` function in `tokens.ts`, used everywhere. Kill the local `statusColors` map in `AgentsChatsPanel.tsx`.

---

## ISSUE 4: Agent Identity Confusion

### 4.1 Hardcoded Agent Names vs. Dynamic Agents
**Severity:** High
**Files:** `AgentsChatsPanel.tsx:51-58`, `tokens.ts` (agentColors, agentRoles)

Six agents are hardcoded as `DEFAULT_ORGX_AGENTS` (Orchestrator, Engineering, Product, Marketing, Design, Operations). Separately, `tokens.ts` defines colors/roles for 9 agents (Pace, Eli, Dana, Mark, System, Sage, Orion, Xandy, Nova). These are **completely different naming schemes** for potentially the same agents.

**What's confusing:** The chat panel shows "Orchestrator" and "Engineering" as agent names. The token system colors an agent named "Eli" in lime. Are Eli and Engineering the same agent? Is Pace the Orchestrator? There's no mapping.

**Fix:** Decide on one identity system. Either:
- Display agent persona names everywhere (Pace, Eli, etc.) with role subtitles
- Display role names everywhere (Orchestrator, Engineering) with persona names as optional metadata
- Never mix both in the same session

---

### 4.2 Agent Avatar Fallback Inconsistency
**Severity:** Low
**Files:** `AgentAvatar.tsx`, `tokens.ts`

Agents with no predefined color fall back to teal. Agents with no name show a generic "?" or first letter. But the fallback teal is also the color for "System" and "Orion", making it impossible to distinguish unknown agents from those specific agents by color alone.

**Fix:** Use a neutral gray (`rgba(255,255,255,0.25)`) as the unknown-agent fallback. Reserve teal for known agents only.

---

## ISSUE 5: Modal Overload

### 5.1 Too Many Modal Types with Inconsistent Layouts
**Severity:** High
**Files:** `EntityDetailModal*.tsx`, `AgentDetailModal.tsx`, `AgentLaunchModal.tsx`, `BulkDecisionsModal.tsx`, `BulkHandoffsModal.tsx`, `BulkSessionsModal.tsx`, `BulkOutboxModal.tsx`, `ArtifactPreview.tsx`, `DecisionModal.tsx`, `DecisionDetailModal.tsx`, `SettingsModal.tsx`, `ByokSettingsModal.tsx`

There are **12+ different modal components**, each with slightly different header layouts, padding, close button positions, and content structures. Some use `max-w-5xl`, others use different widths. Some have breadcrumbs, some don't.

**What's confusing:** Every modal feels slightly different. Close button size, position, and style vary. Header padding is `px-5 py-3` in entity modals but different elsewhere. Content scrolling behavior differs.

**Fix:** Create a `ModalShell` compound component:
```
<ModalShell maxWidth="5xl">
  <ModalShell.Header breadcrumbs={[...]} onClose={onClose} />
  <ModalShell.Body>{children}</ModalShell.Body>
  <ModalShell.Footer>{actions}</ModalShell.Footer>
</ModalShell>
```
Every modal uses `ModalShell`. One header pattern. One close button. One scroll behavior.

---

### 5.2 Entity Detail Modals Have Duplicate Breadcrumbs
**Severity:** Medium
**Files:** `EntityDetailModal.tsx:38-55`, `EntityDetailModal.Task.tsx:99-112`

The `EntityDetailModal` wrapper renders breadcrumbs in the header. Then each entity detail sub-component (TaskDetail, MilestoneDetail, etc.) renders **its own breadcrumbs** inside the content area. Users see two breadcrumb trails.

**What's confusing:** Two breadcrumb strips, one above the divider and one below. They show similar but not identical information.

**Fix:** Remove breadcrumbs from the inner detail components. The wrapper's breadcrumb is the single source of truth. If drill-down navigation is needed within the modal (e.g., clicking initiative name in task view), make the wrapper breadcrumb items clickable.

---

## ISSUE 6: Typography & Spacing Inconsistencies

### 6.1 Font Size Proliferation
**Severity:** Medium
**Files:** Throughout - `index.css`, all components

The dashboard uses **9 different font sizes**: 9px, 10px, 11px, 12px, 13px, 14px, 15px, 16px, and a 0.92em relative size. This is too many discrete sizes for a system that needs to feel unified.

**Fix:** Consolidate to 5 sizes:
- **XS** (10px) - meta labels, uppercase kickers, status pills
- **SM** (11px) - secondary labels, badges, timestamps
- **Base** (13px) - body text, descriptions, list items
- **LG** (15px) - section headings
- **XL** (18px) - page/modal titles
Remove the 9px, 12px, 14px, and 16px sizes. Remap all usages.

---

### 6.2 Inconsistent Text Opacity Values
**Severity:** Medium
**Files:** Throughout

Text opacity appears in at least 15 distinct values: `white/25`, `white/30`, `white/35`, `white/38`, `white/40`, `white/42`, `white/45`, `white/50`, `white/52`, `white/55`, `white/60`, `white/70`, `white/75`, `white/78`, `white/80`, `white/85`, `white/88`, `white/90`, `white/92`, `white/95`. The difference between `white/42` and `white/45` is imperceptible.

**Fix:** Consolidate to 5 opacity tiers:
- **Invisible** (`white/20`) - dividers, hairlines
- **Muted** (`white/40`) - timestamps, meta, hints
- **Secondary** (`white/60`) - secondary labels, descriptions
- **Primary** (`white/80`) - main body text
- **Bright** (`white/95`) - titles, headings, emphasis

---

### 6.3 Border Opacity Inconsistency
**Severity:** Low
**Files:** `index.css`, `Markdown.tsx`, `MarkdownText.tsx`, components

Border opacities used: `0.035` (hairline), `0.04`, `0.05` (subtle), `0.06`, `0.08` (standard), `0.1`, `0.10`, `0.12` (strong), `0.14`, `0.16`. The CSS variables define 4 tiers but components frequently use arbitrary in-between values.

**Fix:** Use exactly the 4 CSS variable tiers:
- `--orgx-border-hairline` (0.035)
- `--orgx-border-subtle` (0.05)
- `--orgx-border` (0.08)
- `--orgx-border-strong` (0.12)
Apply via Tailwind theme extension, not arbitrary `border-white/[0.14]` values.

---

## ISSUE 7: Activity Feed Specific Issues

### 7.1 Deduplication Hides Important Context
**Severity:** High
**File:** `ActivityTimeline.tsx`

The timeline deduplicates activity items within a day by `type + title`. If an agent creates 5 artifacts in succession, only 1 shows with a "(5)" cluster badge. Expanding shows all items, but the expand target is a tiny number badge - easy to miss.

**What's confusing:** Users think only 1 artifact was created. The cluster badge looks like a version number, not a "there are more hidden" indicator.

**Fix:**
- Replace the number badge with explicit text: "and 4 more" with an expand chevron
- Show collapsed clusters with a subtle stacked-card visual (offset shadows) to signal "there's more"
- Never auto-collapse clusters of 3 or fewer - only collapse at 4+

---

### 7.2 LLM-Generated Headlines are Unlabeled
**Severity:** Medium
**File:** `ActivityTimeline.tsx`

The detail panel fetches an "enhanced summary" from a local endpoint and generates LLM-powered headlines. There's a `HeadlineSource` type (`'llm' | 'heuristic' | null`) but no UI indicator showing which is which.

**What's confusing:** Users may think a summary is a direct quote from the agent when it's actually an LLM interpretation. This breaks trust.

**Fix:** When `headlineSource === 'llm'`, show a subtle sparkle icon and "AI Summary" label in `text-[10px] text-white/35` below the headline.

---

### 7.3 Sort Toggle is Non-Standard
**Severity:** Low
**File:** `ActivityTimeline.tsx`

Sort order toggles between "newest" and "oldest" via a button click. The button label shows the current state, not the action. "Newest" means "currently sorted newest-first", but users read it as "click to sort by newest."

**Fix:** Use a standard pattern: show an up/down arrow icon next to a "Time" label. Arrow direction indicates current sort. Clicking toggles. No text label needed.

---

## ISSUE 8: Session & Chat Panel Issues

### 8.1 Agent Groups Without Sessions Look Broken
**Severity:** Medium
**File:** `AgentsChatsPanel.tsx`

Default agents (Orchestrator, Engineering, etc.) always appear in the list even if they have zero sessions. They show with an empty body and just the header. This creates dead space.

**What's confusing:** "Why is Engineering listed if it's never done anything?" The empty agent groups make the panel look sparse and lifeless, especially on first use.

**Fix:** Hide agents with zero sessions from the chat panel by default. Add a "Show all agents" toggle at the bottom if the user wants the full roster. Or: show a single-line inactive state ("Engineering - No sessions") instead of a full card.

---

### 8.2 Session Status Metric Overload in Agent Modal
**Severity:** Medium
**File:** `AgentDetailModal.tsx`

The agent detail modal shows a 4-metric grid: Running (lime), Blocked (red), Failed (amber), Completed (teal). Four large colored numbers in a row. For most agents, 3 of 4 will be "0", creating visual noise.

**Fix:** Show only non-zero metrics. If all sessions are completed, show a single "12 sessions completed" summary instead of four boxes. Only show the grid when there are mixed states worth comparing.

---

### 8.3 "Show X more" vs. Pagination Inconsistency
**Severity:** Low
**File:** `AgentsChatsPanel.tsx`

Active sessions use "Show X more" toggle (up to 10 visible). Archived sessions use page-based pagination (10 per page with prev/next). Two different disclosure patterns for sibling lists.

**Fix:** Use "Show more" everywhere. Pagination implies finite pages; progressive disclosure is better for streams. Load 10 more each click, infinitely.

---

## ISSUE 9: Comments & Notes UX Issues

### 9.1 "Leave a note..." vs. "Post note" Mislabel
**Severity:** Medium
**File:** `EntityCommentsPanel.tsx`

The textarea placeholder says "Leave a note..." and the submit button says "Post note". But the system calls them "comments" everywhere in the code (`EntityCommentsPanel`, `commentType: 'note'`, API endpoint `/comments`). The header says nothing - there's no section title.

**What's confusing:** Is this a comment or a note? Are they different? (They're not.)

**Fix:** Pick one word. "Notes" feels lighter and more appropriate for internal team communication. Rename: section title "Notes", placeholder "Add a note...", button "Post". The API can stay as `comments` internally.

---

### 9.2 Cmd/Ctrl+Enter Hint is Hidden
**Severity:** Low
**File:** `EntityCommentsPanel.tsx`

"Visible to agents & collaborators. Cmd/Ctrl+Enter to post." appears as static text below the textarea. The keyboard shortcut is buried in a sentence about visibility.

**Fix:** Split into two distinct elements:
1. Visibility notice: "Visible to agents & collaborators" as a subtle info line
2. Keyboard hint: Show "Cmd+Enter" as a styled keyboard shortcut badge (`<kbd>`) next to the Post button

---

### 9.3 Comments Expand-by-Default Toggle Missing
**Severity:** Low
**File:** `EntityDetailModal.Task.tsx:26`

The `showNotes` state defaults to `false`, meaning users have to manually expand the notes section every time they open a task. If there are existing comments, they're hidden behind a click.

**Fix:** Auto-expand notes if `comments.length > 0`. Only collapse by default when there are no comments yet.

---

## ISSUE 10: Micro-Interaction & Polish Issues

### 10.1 Cost Display Formatting Inconsistency
**Severity:** Low
**Files:** `ThreadView.tsx:32-41`

Cost formatting uses two different precisions: `$0.0012` (4 decimal places for < $0.01) and `$1.23` (2 decimal places for >= $0.01). This creates visual inconsistency in cost columns.

**Fix:** Always show 2 decimal places: `$0.00`, `$0.01`, `$1.23`. For costs below a cent, show `<$0.01` instead of the exact value. Engineers don't need 4-decimal precision in a dashboard.

---

### 10.2 Relative Time Without Absolute Tooltip
**Severity:** Medium
**Files:** `time.ts`, all components using `formatRelativeTime`

All timestamps show relative time ("5m ago", "2h ago", "3 days ago") with no way to see the actual date/time. For activity that happened "3 days ago," users can't tell if it was Monday morning or Sunday night.

**Fix:** Wrap every relative timestamp in a `<time>` element with `title={absoluteDateTime}` for native tooltip on hover. Consider adding `datetime` attribute for accessibility.

---

### 10.3 Empty States are Generic
**Severity:** Medium
**Files:** `ActivityStream.tsx`, `ActivityTimeline.tsx`, `ThreadView.tsx`

Empty states are:
- Activity stream: Clock icon + "Waiting for activity" (white/40)
- Thread view: "No activity in this session yet."
- Agent detail: (no empty state for empty session list)

**What's confusing:** "Waiting for activity" doesn't tell users what to do next. It's passive.

**Fix:** Make empty states actionable:
- "No activity yet. Launch an agent or connect a session to get started." with a CTA button
- "This session hasn't produced activity. It may still be initializing." for thread view
- Include a subtle animation (not just a static icon) to signal "this is a live view that will update"

---

### 10.4 Two Markdown Renderers
**Severity:** Medium
**Files:** `Markdown.tsx`, `MarkdownText.tsx`

Two separate markdown components:
- `Markdown.tsx` - Full `react-markdown` + `remark-gfm` library (2KB+ runtime)
- `MarkdownText.tsx` - Custom hand-rolled regex parser with table support (317 lines of custom parsing)

Styling differs between them:
- `Markdown`: Code bg `bg-black/30`, block code `bg-black/35`, text `white/70`
- `MarkdownText`: Code bg `bg-white/[0.08]`, block code `bg-black/40`, text `white/78`

**What's confusing:** Same content renders differently depending on which component renders it.

**Fix:** Keep `MarkdownText.tsx` (it's faster, lighter, and handles tables). Remove `Markdown.tsx` and `react-markdown` dependency. Align the styling to match the design tokens exactly.

---

### 10.5 Inconsistent Icon Stroke Width
**Severity:** Low
**Files:** `EntityIcon.tsx`, `SearchInput.tsx`, `EntityDetailModal.tsx`, `ThreadView.tsx`

Most SVG icons use `strokeWidth: 1.8`. But:
- SearchInput magnifying glass: `strokeWidth: 2`
- Close buttons (X): `strokeWidth: 2`
- Breadcrumb chevrons: `strokeWidth: 2.5`
- Back arrow: `strokeWidth: 2`

**Fix:** Standardize: `strokeWidth: 1.8` for content icons, `strokeWidth: 2` for interactive controls (buttons). Never use 2.5.

---

## ISSUE SUMMARY

| Priority | Issue | Impact |
|----------|-------|--------|
| P0 | Two competing activity systems (#1.1) | Fundamental architecture confusion |
| P0 | Seven status vocabularies (#3.1) | Cognitive overload across every view |
| P1 | Thread vs. detail panel collision (#1.2) | Broken mental model |
| P1 | Back/close navigation inconsistency (#2.1) | Muscle memory broken |
| P1 | Agent identity confusion (#4.1) | Users can't track who's who |
| P1 | Modal layout inconsistency (#5.1) | Death by a thousand paper cuts |
| P1 | Status color conflicts (#3.2) | Same thing, different color |
| P1 | Deduplication hides context (#7.1) | Users miss important activity |
| P2 | Duplicate breadcrumbs (#5.2) | Visual clutter |
| P2 | Font size proliferation (#6.1) | Loose visual hierarchy |
| P2 | Text opacity chaos (#6.2) | Muddy information hierarchy |
| P2 | Empty agents in chat panel (#8.1) | Dead space |
| P2 | Agent modal metric overload (#8.2) | Visual noise |
| P2 | Comments/notes naming (#9.1) | Terminology confusion |
| P2 | No absolute time tooltip (#10.2) | Can't pin events to real time |
| P2 | Two markdown renderers (#10.4) | Inconsistent content display |
| P2 | Generic empty states (#10.3) | No actionable guidance |
| P2 | LLM headlines unlabeled (#7.2) | Trust issue |
| P3 | Keyboard nav only in timeline (#2.2) | Power user frustration |
| P3 | Border opacity inconsistency (#6.3) | Subtle visual noise |
| P3 | Show more vs. pagination (#8.3) | Pattern inconsistency |
| P3 | Cmd+Enter hint buried (#9.2) | Discoverability |
| P3 | Notes collapsed by default (#9.3) | Extra click |
| P3 | Cost formatting (#10.1) | Minor visual inconsistency |
| P3 | Sort toggle non-standard (#7.3) | Micro-confusion |
| P3 | Icon stroke width variance (#10.5) | Subtle inconsistency |
| P3 | Agent avatar teal fallback (#4.2) | Ambiguous identity |

---

## Holistic Solution: The 10/10 Path

### Phase 1: Foundations (High Impact, Low Effort)
1. **Create `normalizeStatus()` utility** - One function, used everywhere, maps all status strings to 5 display labels
2. **Create `ModalShell` compound component** - Standardize all 12+ modals in one week
3. **Retire `ActivityStream.tsx`** - Delete the file, update imports
4. **Retire `Markdown.tsx`** - Use `MarkdownText` everywhere
5. **Add `<time title={absolute}>` wrapper** to `formatRelativeTime`

### Phase 2: Consistency Pass (Medium Effort)
6. **Consolidate text opacity** to 5 tiers via Tailwind theme tokens
7. **Consolidate font sizes** to 5 sizes via Tailwind theme tokens
8. **Standardize border opacity** to 4 CSS variable tiers
9. **Unify navigation pattern** - breadcrumb + X button everywhere
10. **Map agent identities** - Resolve persona vs. role naming

### Phase 3: Interaction Refinements (Higher Effort)
11. **Merge thread view into detail panel** - Progressive disclosure model
12. **Improve deduplication UX** - "and N more" + stacked visual
13. **Make empty states actionable** - CTAs, not just icons
14. **Add keyboard navigation** to modals
15. **Label LLM-generated content** with sparkle indicator

### Design Principles for the 10/10 Version
- **One word, one meaning** - Each status/label/term maps to exactly one concept
- **One pattern, one behavior** - Navigation, closing, expanding work the same way everywhere
- **Progressive disclosure, not mode-switching** - Show more detail in place, don't teleport
- **If it's computed, label it** - AI summaries, derived metrics, inferred statuses
- **Fewer options, more clarity** - 5 font sizes, 5 opacity tiers, 5 status labels, 4 border weights
