# Chat Composer Component Spec

Surface: top-row single input bar with progressive expansion.

## Purpose

- Let users capture intent instantly.
- Expose execution context without heavy modal flow.
- Keep `Send` and `Launch` clearly distinct.

## In Scope

- Collapsed and expanded composer states.
- Primary assignee, watcher mentions, attachments, scope chip.
- Send and launch controls.

## Out of Scope

- Full transcript synchronization with external provider sessions.
- Multi-agent auto-fanout behavior.

## Anatomy

### Collapsed State

- Input placeholder
- Quick controls: assignee, attach, scope
- Send affordance

### Expanded State

- Multiline message input
- Assignee selector (single)
- Watcher mention chips
- Attachment tray
- Scope chip + link action
- Footer actions: `Send` and `Launch`

## Behavioral Contract

- Focus or click expands composer.
- `Enter` sends unless mention menu is active.
- `Shift+Enter` inserts newline.
- `Cmd/Ctrl+K` focuses composer.
- `Esc` closes menus first; only collapses when draft is empty.

## Validation and Guardrails

- Send enabled when non-empty message exists.
- Launch enabled when:
- message persisted
- primary assignee set
- no unresolved validation error

- Launch warning shown for non-ready attachments.

## State Matrix

| State | Trigger | UI Treatment | Next Action |
|---|---|---|---|
| idle | no draft | collapsed | start typing |
| drafting | user input | expanded | send or continue editing |
| sending | send action | optimistic row + subtle pending state | await reconcile |
| sent | server ack | timestamp + stable state chip | optional launch |
| launch_ready | assignee + sent message | launch button active | launch |
| launch_blocked | launch attempt fails validation | inline reason + action hint | fix requirement |

## Token Contract

- Surface: `colors.cardBgElevated`
- Border: `border.color.default`
- Radius: `radius.shell` outer, `radius.controlPill` controls
- Focus: `interaction.focusRing`
- Touch target min: `interaction.minTouchTarget`

## Accessibility Contract

- Explicit label for input and distinction text for `Send` vs `Launch`.
- Assignee and mentions use ARIA listbox/option semantics.
- Attachment row announces file name and state.
- Disabled launch explains why in accessible description.

## Telemetry Events

- `chat_message_draft_started`
- `chat_message_sent`
- `chat_launch_requested`
- `chat_launch_validation_failed`

## QA Scenarios

1. Collapsed -> expanded transition.
2. Mention menu keyboard navigation.
3. Attachment add/remove and failed status.
4. Send only flow (no launch).
5. Send + launch flow.
6. Offline send with replay indicator.
