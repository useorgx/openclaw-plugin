# Chat UX Design Audit Report

Date: 2026-02-23
Audited scope:
- `docs/ux/chat-*.md`
- `docs/product/chat-phase-rollout-plan.md`
- `docs/product/chat-telemetry-kpis.md`

Method:
- `design-audit` 8-pass framework
- Target score: >= 9/10 per pass

## Before Audit (Initial Draft)

| Pass | Score | Key Gaps |
|---|---|---|
| AI Slop | 7.9 | Generic checklists, insufficient anti-pattern specificity |
| Cognitive | 8.1 | Missing explicit decision-load budgets and state causality |
| Gestalt | 8.0 | Limited hierarchy and visual-weight enforcement language |
| Master Principles | 8.2 | Rams/Fukasawa/Hara checks not operationalized |
| Interaction Physics | 8.0 | Motion guidance too abstract for implementation |
| Layout/Typography | 8.1 | Insufficient spacing/type constraints per component |
| Reference Parity | 8.3 | Weak linkage to existing Activity/Sessions rationale |
| Agent-First | 8.2 | Limited semantic/action-state contract language |

## Remediations Applied

1. Converted all component docs to implementation-grade contracts with:
- explicit state matrices
- entry/exit criteria
- deterministic user feedback requirements

2. Added stronger anti-slop and ambiguity controls across docs:
- explicit launch semantics
- copy contract rules
- error-state format requirements

3. Hardened mobile and accessibility requirements:
- 375 behavior contract
- keyboard/focus restoration rules
- screen-reader state announcement requirements

4. Elevated phase rollout and telemetry docs to gate-level rigor:
- per-phase required references
- quantified KPI targets and alert thresholds
- release readiness checklist

5. Added audit-control index and formal report artifacts:
- `docs/ux/chat-reference-index.md`
- `docs/ux/chat-design-audit-report.md`

## After Audit (Current)

| Pass | Score | Rationale |
|---|---|---|
| AI Slop | 9.3 | Anti-patterns and semantic constraints now explicit and enforceable |
| Cognitive | 9.2 | Decision points and state transitions constrained and measurable |
| Gestalt | 9.1 | Hierarchy and visual weight rules now codified in component specs |
| Master Principles | 9.1 | Rams-style thoroughness and minimalism reflected in state/exit criteria |
| Interaction Physics | 9.2 | Motion and causality rules now implementation-specific |
| Layout/Typography | 9.0 | Token and rhythm constraints now tied to component behavior |
| Reference Parity | 9.3 | Strong cross-links to existing plugin rationale docs |
| Agent-First | 9.2 | ARIA/state semantics and machine-readable contracts defined |

## Critical/Major Findings Status

- Critical findings open: 0
- Major findings open: 0
- Minor findings open: 3

Minor findings to resolve during implementation:
1. Add concrete screenshot path conventions in QA evidence scripts.
2. Add concrete reduced-motion snapshot assertions in automated QA.
3. Add field-level analytics schema validation in integration tests.

## Audit Exit

- All 8 passes now >= 9/10 at the spec level.
- Docs are implementation-ready and phase-gated.

## Implementation Audit (ChatSurface)

Date: 2026-02-23  
Target: `dashboard/src/components/activity/chat/ChatSurface.tsx`

### Pass Scores (Post-Implementation)

| Pass | Score | What Changed |
|---|---|---|
| AI Slop | 9.2 | Reduced control clutter, introduced single clear primary action state (`Launch ready` vs `Draft`), removed redundant copy.
| Cognitive | 9.1 | Added guidance rail (`composerGuidance`), quick-start prompts, and explicit launch prerequisites to reduce decision friction.
| Gestalt | 9.1 | Strengthened section grouping (composer, list, panel), clearer figure/ground separation, and improved active-thread isolation.
| Master Principles | 9.0 | Added more purposeful status language and reduced decorative variance while preserving clear utility.
| Interaction Physics | 9.2 | Added spring hover/tap motion for key controls and cards; improved entry/exit motion for composer and panel.
| Layout/Typography | 9.0 | Tightened spacing rhythm and hierarchy for mobile + desktop; improved list/card readability.
| Reference Parity | 9.1 | Updated interaction style to align with premium assistant surfaces (focused composer, concise metadata, intent-forward actions).
| Agent-First | 9.1 | Added semantic labels, machine-readable timestamps, stable state attributes, and data-test hooks for automation.

### Key Fixes Applied

1. Composer architecture:
- Added expandable premium single-bar composer treatment with quick-start prompts and launch readiness badge.
- Added deterministic send/launch gating via `canSend`, `canLaunch`, and `composerGuidance`.

2. Error-state psychology:
- Added `humanizeApiError` mapping for API/network failures, including an explicit remediation for `Unknown API endpoint`.
- Preserved draft-oriented reassurance language for send failures.

3. Thread list and panel:
- Refined card hierarchy and active-state contrast.
- Added message bubble differentiation by role (user/agent/system) and improved loading/error/empty panel states.
- Added retry affordance for thread-load failures.

4. Motion and interaction:
- Standardized spring interaction tokens (`CONTROL_SPRING`, `CONTROL_TAP`) across key controls.
- Added entrance/exit blur + y transitions for perceived responsiveness.

### Remaining Risk

1. QA automation currently captures Activity/Mission Control flows but does not yet include dedicated scripted chat-state assertions (composer expanded/collapsed, panel error retry, attachment warning flow).

## Activity Feed Integration Audit (Runtime)

Date: 2026-02-23  
Target:
- `dashboard/src/components/activity/ActivityTimeline.tsx`
- `dashboard/src/components/activity/chat/ChatSurface.tsx`

Evidence captured:
- `docs/qa/2026-02-23/chat-activity-audit-desktop.png`
- `docs/qa/2026-02-23/chat-activity-audit-mobile.png`
- Playwright console warning trace for invalid motion keyframes (`filter`) during chat open/send flows.

### Pass Scores (Current Integration)

| Pass | Score | Notes |
|---|---|---|
| AI Slop | 8.8 | Structure is mostly disciplined, but contradictory “0 threads” state while thread panel is open undermines trust. |
| Cognitive | 7.6 | Overlay modal introduces context break from Activity feed; user loses continuity while triaging events. |
| Gestalt | 7.7 | Chat detail behaves like a separate app surface rather than an extension of Activity context. |
| Master Principles | 8.0 | Useful controls exist, but “integrated workflow” promise is broken by full-screen dialog behavior. |
| Interaction Physics | 6.9 | Repeated Framer Motion `filter` keyframe warnings indicate invalid animation configuration in production runtime. |
| Layout/Typography | 8.6 | Base rhythm is strong; search is correctly positioned in row 1, but panel layering dominates the page hierarchy. |
| Reference Parity | 8.1 | Composer quality is close to premium chat surfaces, but thread-detail handoff feels heavier than Anthropic/OpenAI/Cursor patterns. |
| Agent-First | 8.3 | Launch semantics are clear, but hidden thread list state after send creates agent-state ambiguity. |

### Findings

1. **Critical** — Context-breaking modal detaches chat from Activity flow.
- Evidence: thread detail uses viewport-level overlay (`fixed inset-0`) and full-height dialog, blocking surrounding feed context.
- Source: `dashboard/src/components/activity/chat/ChatSurface.tsx:1616`, `dashboard/src/components/activity/chat/ChatSurface.tsx:1628`.
- Impact: users cannot maintain “activity triage -> thread resolution” continuity; interaction feels like route change rather than in-feed expansion.

2. **Major** — Thread persistence state is contradictory after send.
- Evidence: runtime can show “Message sent” thread dialog while list count remains `0` and empty-state copy is visible.
- Source: overwrite from snapshot into local thread state in `dashboard/src/components/activity/chat/ChatSurface.tsx:546`.
- Impact: trust break in system status; users cannot verify where newly created thread lives.

3. **Major** — Motion warnings in production interaction path.
- Evidence: Playwright console emits repeated “Invalid keyframe value for property filter” warnings when composer and panel transitions run.
- Source: blur keyframes on motion nodes at `dashboard/src/components/activity/chat/ChatSurface.tsx:1170`, `dashboard/src/components/activity/chat/ChatSurface.tsx:1230`, `dashboard/src/components/activity/chat/ChatSurface.tsx:1550`, `dashboard/src/components/activity/chat/ChatSurface.tsx:1605`.
- Impact: reduced polish and potentially unstable animation behavior on target runtimes.

4. **Minor** — Search placement request is already satisfied in current implementation.
- Evidence: search input sits in the first Activity header row beside status/time controls.
- Source: `dashboard/src/components/activity/ActivityTimeline.tsx:4087`.
- Impact: no immediate action required for placement; remaining issue is interaction density, not row position.

5. **Minor** — Vercel AI SDK `useChat` is wired, but only for assistant guidance stream.
- Evidence: `TextStreamChatTransport` and `useChat` are configured against `/orgx/api/chat/usechat`; backend route exists.
- Source: `dashboard/src/components/activity/chat/ChatSurface.tsx:3`, `dashboard/src/components/activity/chat/ChatSurface.tsx:781`, `src/http/routes/chat.ts:367`.
- Impact: confirms transport choice is correct; premium gap is UX composition and state continuity rather than SDK selection.

### Recommended Fix Order

1. Replace viewport modal thread detail with integrated in-surface panel behavior (desktop split panel, mobile bottom sheet attached to Activity container).
2. Merge snapshot hydration with optimistic/local thread state instead of unconditional overwrite.
3. Remove `filter` keyframes from Framer Motion variants and rely on opacity/translate/scale springs.
4. Add explicit regression checks for “send -> list count increments -> panel opens same thread” in QA capture.
