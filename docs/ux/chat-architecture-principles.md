# Chat Architecture UX Principles

This doc defines the quality bar for the seamless chat surface and the rules every component spec inherits.

## Product Promise

- One premium command surface for discussing work and launching execution.
- `Send` captures intent and collaboration.
- `Launch` starts execution through the queue/runtime path.
- Activity remains the narrative backbone for what changed and why.

## Mandatory Experience Outcomes

1. Users can identify the next meaningful action within 3 seconds.
2. Every state transition is visible and causally explained.
3. No dead-end UI states.
4. Mobile 375 is first-class.
5. Existing Activity/Sessions behavior remains intact.

## 8-Pass Audit Targets

All chat docs/components must meet >= 9/10 in each pass.

| Pass | Target | Failure Condition |
|---|---|---|
| AI Slop | No major slop pattern remains | Badge soup, redundant CTA, jargon leak |
| Cognitive | <= 3 visible actions at decision points | Action overload or unclear primacy |
| Gestalt | Dominant focus element per viewport | Flat hierarchy under blur test |
| Master Principles | Rams DR-4, DR-8, DR-10 pass | Ambiguous purpose or missing state design |
| Interaction Physics | Spring/causal motion system intact | CSS-only transition for key interactions |
| Layout/Typography | Token-scale spacing only | Arbitrary spacing or >4 type levels |
| Reference Parity | Matches internal premium surfaces | Feels detached from current plugin language |
| Agent-First | Semantic/action clarity in DOM | State not machine-readable or ambiguous |

## Mental Model

- Thread is the conversation container.
- Message is intent/evidence payload.
- Launch is a deliberate execution transition.
- Activity is the canonical timeline of observable progress.
- Initiative linkage is additive context, not a blocker to start.

## Visual Hierarchy Contract

1. Primary visual focus per viewport:
- Composer in creation context.
- Thread status/progress in review context.

2. Secondary visual stack:
- Scope and assignment context.
- Artifacts and supporting metadata.

3. Decorative weight limit:
- No decorative element may outweigh primary content.

## Token and Motion Contract

- Color, spacing, radius, focus, and motion from `dashboard/src/lib/tokens.ts` only.
- Interaction minimum touch target: `interaction.minTouchTarget`.
- Focus ring must use `interaction.focusRing` values.
- Motion timing must use `motion.duration*` tokens.

## Language Contract

- Labels are operational and unambiguous.
- Avoid internal infra jargon in user-facing copy.
- Error text always includes failure point, preservation outcome, and next action.

## Risk Controls

- Do not auto-launch on send.
- Do not infer execution assignee from watcher mentions.
- Do not block message send because initiative is unset.
- Do not hide blocked launch reasons behind generic toasts.

## Exit Criteria For Any Chat UI Change

1. Component spec updated.
2. Related QA checklist item executed.
3. Desktop + 375 evidence captured.
4. No regressions in Activity/Sessions baseline behavior.
