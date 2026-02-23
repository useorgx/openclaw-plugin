# Chat Agent Mentions Spec

Defines role semantics and interaction behavior for assignee + watcher mentions.

## Semantic Model

- Assignee: one execution owner per launch.
- Watchers: optional context participants.
- Mentions do not auto-spawn additional runs.

## Interaction Model

- `@` opens mention menu.
- Selecting mention inserts watcher chip in message context.
- Assignee set through dedicated assignee selector.

## Visual Hierarchy

- Assignee chip has stronger emphasis.
- Watcher chips are lower visual weight.
- Unresolved watcher references are marked with warning styling and tooltip.

## Launch Preview Requirements

Display before launch:
- `Executes as` value (single)
- `Watchers` list
- unresolved mention warnings

## Error and Conflict Handling

- Deleted or unavailable watcher: keep token, mark unresolved, allow removal.
- Missing assignee: launch blocked with direct set-assignee action.

## Accessibility Requirements

- Mention menu supports arrow-key navigation and enter selection.
- Watcher chips expose remove action via keyboard and SR label.
- Assignee control announces current selection state.

## QA Scenarios

1. Assignee-only launch.
2. Assignee + multiple watcher mentions.
3. Unresolved watcher mention handling.
4. Keyboard-only mention selection and chip removal.
