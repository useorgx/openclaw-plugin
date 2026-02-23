# Chat Telemetry and KPI Spec

Defines performance, quality, and reliability signals for chat rollout.

## KPI Categories

### UX Performance KPIs

- Send-to-visible latency: p50 <= 400ms, p95 <= 1200ms
- Launch request-to-queued latency: p95 <= 1000ms
- Queue-to-running latency: tracked per mode and environment
- Mobile 375 flow completion rate

### Behavior and Adoption KPIs

- Launch conversion rate: `launch_click / sent_messages`
- Thread-to-initiative promotion rate
- Relaunch rate after blocked/failed launch

### Reliability KPIs

- Send failure rate
- Launch failure rate
- Outbox replay success rate
- Snapshot reconciliation mismatch rate

### Quality KPIs

- Accessibility defects per release candidate
- Regression count in Activity/Sessions flows
- Copy clarity incidents from support feedback

## Event Taxonomy

Required events:
- `chat_thread_created`
- `chat_message_sent`
- `chat_message_send_failed`
- `chat_launch_requested`
- `chat_launch_queued`
- `chat_launch_started`
- `chat_launch_blocked`
- `chat_launch_completed`
- `chat_launch_failed`
- `chat_thread_linked_initiative`
- `chat_thread_relinked_initiative`
- `chat_attachment_state_changed`

Required event fields:
- workspace id
- thread id
- message id (when applicable)
- run id (when applicable)
- initiative/workstream/task refs
- assignee id and watcher count
- execution mode and provider
- timestamp and correlation id

## Alert Thresholds (Initial)

- Send-to-visible p95 > 1500ms for 15 minutes
- Launch failure rate > 8% for 1 hour
- Blocked launch rate > 20% for 1 hour
- Outbox replay success < 95% for 24 hours

## Instrumentation Quality Rules

- All events idempotent and deduplicated by correlation id.
- Client and server event clocks reconciled for latency integrity.
- Event failures should not block user actions.

## Review Cadence

- Daily dashboard review during rollout week.
- Weekly trend review after stabilization.
- Post-incident deep dive for any threshold breach.
