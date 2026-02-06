# Agentic Handoffs Workstream — Live Session Graph + High‑Signal Timeline + Handoff UX

## Goals
- Make parallel agent work visible at a glance (session tree with parent/child runs).
- Surface only high‑signal activity (decisions, completions, handoffs, artifacts).
- Preserve context at handoff boundaries with progress indicators.
- Support real‑time updates via SSE with polling fallback.

## Non‑Goals
- Playbooks, learnings, and artifact libraries (separate workstreams).
- Deep OpenClaw core instrumentation (future phase).
- Automated handoff fulfillment or approval workflows (read‑only in v1).

## Success Criteria
- Users can identify active parallel sessions and their status in under 10 seconds.
- Activity feed stays low‑noise and highlights decisions/completions.
- Handoff panel shows progress and context without navigating away.

## Data Sources
- `agent_runs` (session core + parent/child linking)
- `agent_outbox_events` (activity stream)
- `handoffs` + `handoff_events` (handoff state + events)
- `decision_requests` (decision prompts used by activity mapper)
- `agent_run_artifacts` (context for artifact activity)

## Canonical Session Model
Session = `agent_run` with parent/child links:
- Prefer `parent_run_id`
- Fallback to `metadata.parentRunId` for backward compatibility

## API Contracts

### SessionTreeResponse
```
{
  nodes: SessionTreeNode[],
  edges: { parentId, childId }[],
  groups: { id, label, status }[]
}
```

### SessionTreeNode
```
{
  id, parentId, runId, title, agentId, agentName,
  status, progress, initiativeId, workstreamId,
  groupId, groupLabel, startedAt, updatedAt,
  lastEventAt, lastEventSummary, blockers
}
```

### LiveActivityItem
```
{
  id,
  type: run_started|run_completed|run_failed|artifact_created|
        decision_requested|decision_resolved|handoff_requested|
        handoff_claimed|handoff_fulfilled|blocker_created|
        milestone_completed|delegation,
  title, description, agentId, agentName, runId,
  initiativeId, timestamp, metadata
}
```

### HandoffSummary
```
{
  id, title, status, priority, summary,
  currentActorType, currentActorId, createdAt, updatedAt,
  events: HandoffEvent[]
}
```

### SSE Events
- `snapshot` (sessions + activity + handoffs)
- `session.updated`
- `activity.appended`
- `handoff.updated`
- `heartbeat`

## OrgX Backend Endpoints (API Key Auth)
- `GET /api/client/live/agents`
- `GET /api/client/live/initiatives`
- `GET /api/client/live/activity`
- `GET /api/client/live/sessions`
- `GET /api/client/live/stream` (SSE)
- `GET /api/client/handoffs`

## Dashboard UX
- **Session Tree**: grouped by initiative/workstream with collapsible child runs.
- **Activity Timeline**: filters for decisions, handoffs, artifacts, failures; collapse/expand by time group.
- **Session Inspector**: selected session status, progress, blockers, recent events.
- **Handoff Panel**: progress indicator (created → claimed → fulfilled) and summary.

## Dedupe + Noise Filtering
- Drop `agent.answer` events and other high‑frequency chatter.
- Dedupe by `event_id` or synthetic ID.
- Keep decision and handoff events even if repeated; surface most recent.

## Rollout Plan
1. Ship API key live endpoints + SSE.
2. Proxy endpoints through OpenClaw plugin.
3. Upgrade dashboard with session tree + timeline + handoff panel.
4. Gather feedback and refine event mapping/noise filters.

## Port Verification Checklist
- Start OpenClaw with the OrgX plugin installed.
- Visit `http://127.0.0.1:18789/orgx/live/`.
- Confirm `GET /orgx/api/onboarding` returns `200 OK`.

## Future Workstreams (Out of Scope)
- Playbooks (run guidance + best practices).
- Learnings integration (post‑run insights).
- Artifact library and semantic search.
