# Chat Copy and Tone Guidelines

Defines language standards for a premium operational interface.

## Voice

- Calm, direct, and factual.
- State outcome first, guidance second.
- Avoid ambiguous assistant-style filler language.

## Terminology Rules

- `Send`: saves a message to thread.
- `Launch`: starts execution.
- `Blocked`: execution cannot continue until requirement is resolved.

## Preferred Patterns

- Outcome + context + next action.
- Keep labels short and operational.
- Avoid internal infra vocabulary in user-facing strings.

## Approved Microcopy Examples

- `Queued locally. Run starts when a worker is available.`
- `Launch blocked: set a primary assignee.`
- `Attachment indexed and ready for launch context.`

## Anti-Patterns

- `Something went wrong.`
- `Please try later.` without preserving context details.
- Overly promotional or anthropomorphic system messaging.

## Empty State Copy

- One sentence of orientation.
- One primary action.

## Error Copy Template

- Failure: `<what failed>`
- Preservation: `<what was saved>`
- Action: `<next step>`
