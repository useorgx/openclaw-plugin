# Chat Initiative Linking Spec

Defines how threads map to initiative/workstream/task context without interrupting flow.

## Core Decision

- Threads can begin unscoped.
- Linking is progressive, reversible, and additive.

## User Jobs

1. Start a thread immediately.
2. Link later when execution context is clear.
3. Promote a high-value thread into a new initiative.

## Linking Paths

- Link to existing initiative.
- Create new initiative from thread.
- Optionally attach workstream/task when known.

## Linking Surface Requirements

- Scope chip appears in composer and thread panel.
- Inline picker first; modal only for richer create flow.
- Successful link emits a visible system event in thread timeline.

## Promotion Defaults

When creating initiative from thread:
- title prefilled from thread title
- summary prefilled from first message cluster
- workspace defaults to current workspace
- status defaults to draft or configured launch policy

## Integrity Rules

- Linking never drops message history.
- Re-linking creates a historical event trail.
- Launch payload always reflects current scope binding.

## Edge Cases

- Target initiative archived/inaccessible.
- Concurrent link update from another client.
- User cancels create-link midway.

## UX Copy Contract

- Scope unset label: `Unscoped`.
- Post-link confirmation: `Linked to <initiative>`.
- Re-link warning: `This thread will move context to <initiative>.`

## QA Scenarios

1. Keep thread unscoped through message + launch.
2. Link to existing initiative after messages exist.
3. Promote thread to new initiative.
4. Re-link thread to a different initiative with history preserved.
