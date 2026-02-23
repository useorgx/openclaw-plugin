# Chat Thread Panel Spec

Panel opened from Activity thread cards for full context and action.

## Purpose

- Provide complete message + execution timeline.
- Keep launch and linking actions in context.
- Preserve user orientation back to Activity.

## Layout

### Header

- Title
- Status chip
- Scope chip
- Assignee/watchers
- Quick actions: launch, link scope, share

### Body Sections

- Conversation
- Execution timeline
- Artifacts
- Scope/context metadata

## Conversation Rules

- Chronological message order.
- Group contiguous sender runs for readability.
- System events remain inline, visually distinct, and concise.

## Execution Timeline Rules

- Every launch attempt listed with:
- run id
- mode/provider
- status transitions
- terminal outcome

- Failed/blocked attempts must include one-click recovery path.

## Artifact Rules

- Show artifact type, title, summary, and timestamp.
- Prefer inline previews; fallback to viewer modal.

## Context Rules

- Show initiative/workstream/task links.
- Show session/thread metadata and references.
- Support comments/notes anchor when enabled.

## Interaction Physics

- Panel open/close uses directional slide + fade.
- Preserves Activity scroll position on close.
- Keyboard navigation between sections is deterministic.

## Accessibility

- Focus enters panel header on open.
- Focus returns to source card on close.
- Tabs/sections expose aria state semantics.

## QA Scenarios

1. Thread with messages only.
2. Thread with multiple launch attempts.
3. Thread with artifacts.
4. Thread linked after initial creation.
