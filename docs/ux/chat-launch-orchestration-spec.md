# Chat Launch Orchestration Spec

Defines user-facing launch behavior for thread-driven execution.

## Core Semantics

- Send is conversational persistence.
- Launch is explicit execution intent.
- Default mode in v1 is local queue.

## Launch Entry Points

- Composer launch button.
- Thread panel launch action.
- Thread card overflow relaunch action.

## Preflight Summary Requirements

Before enqueueing, display:
- primary assignee
- execution mode
- scope target
- message being launched
- unresolved warnings (attachments, missing scope recommendations)

## Lifecycle Feedback Requirements

| Stage | User Signal | Persistence |
|---|---|---|
| requested | inline pending + toast | thread event |
| queued | status chip + timeline row | queue timestamp |
| running | active timeline progression | run id + started_at |
| blocked | explicit reason + remediation button | blocked event |
| completed | completion summary + artifacts | terminal event |
| failed | concise error + retry affordance | terminal event |

## Failure and Recovery UX

- Guardrail block: show exact reason category + fix action.
- Provider unavailable: offer provider fallback relaunch path.
- Timeout: preserve run context and surface retry with diagnostic hint.

## Data Integrity Rules

- Launch response must include run id for timeline binding.
- Duplicate launch prevention should be visible (cooldown/debounce messaging).
- Launch history remains visible even after successful retries.

## QA Scenarios

1. Happy path launch.
2. Guardrail blocked launch.
3. Provider fallback relaunch.
4. Timeout and retry.
