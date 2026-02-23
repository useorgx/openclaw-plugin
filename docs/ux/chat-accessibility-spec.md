# Chat Accessibility Spec

Accessibility requirements for composer, thread cards, and thread panel.

## Keyboard Navigation

- Entire send/launch flow is keyboard-operable.
- Predictable tab sequence:
- input
- assignee
- mentions
- attachments
- send
- launch

- `Esc` closes nested overlays first before collapsing parent surfaces.

## Screen Reader Contract

- Controls have explicit labels and role semantics.
- `Send` and `Launch` purpose difference is announced.
- Launch status transitions announced via polite live region.

## Focus Management

- Opening thread panel focuses panel heading/action region.
- Closing thread panel restores focus to originating thread card.
- Menus/popovers trap and restore focus correctly.

## Contrast and Readability

- Status chips and text must meet dark-theme contrast requirements.
- Focus indicator remains visible on all interactive surfaces.

## State Semantics In DOM

- Expanded/collapsed states expose `aria-expanded`.
- Selection states expose `aria-selected` where relevant.
- Time values use semantic `<time>` when rendered.

## QA Checks

1. Keyboard-only send + launch flow.
2. Screen reader smoke test on status transitions.
3. Focus restoration checks across panel open/close.
4. Contrast checks on chips, controls, and disabled states.
