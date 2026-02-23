# Chat Thread Card Spec (Activity)

Thread cards are first-class Activity items and must inherit Activity scan patterns.

## Purpose

- Surface thread progress at feed speed.
- Preserve causal context between conversation and execution.

## Card Content Priority

1. Title/summary of latest meaningful change.
2. Current execution status.
3. Ownership context (assignee + watchers).
4. Scope context (initiative/workstream/task/unscoped).
5. Time context.

## Anatomy

- Thread title or derived summary
- Latest snippet (message or system event)
- Assignee avatar/name + watcher indicator
- Status chip
- Scope chip
- Relative and absolute time

## Actions

- Primary click: open thread panel.
- Secondary menu:
- Link/promote initiative
- Relaunch latest message
- Copy deep link

## Interaction Rules

- Feed card updates optimistically on send.
- Status and timestamps reconcile with authoritative snapshot.
- Reorder behavior follows feed sort setting and should avoid jarring jumps during active reading.

## Search/Filter Rules

- Search fields:
- title
- snippet
- assignee/watcher names
- scope labels

- Filters:
- status
- time window
- scope presence

## Visual Rules

- Keep same row rhythm as `docs/ux/activity-timeline-redesign.md`.
- Use state tones from token system only.
- No custom gradient/border treatments for chat rows.

## State Matrix

| Card State | Visual Signal | Required Copy |
|---|---|---|
| message-only | neutral chip | "Message sent" |
| queued | planned/active chip | "Queued" |
| running | active chip | "Running" |
| blocked | blocked chip | concise reason snippet |
| completed | done chip | result snippet/artifact count |
| failed | blocked chip + error icon | concise failure and retry path |

## QA Scenarios

1. New thread without launch.
2. Thread transitions queued -> running -> completed.
3. Blocked launch with clear action hint.
4. Completed thread with artifact indicator.
