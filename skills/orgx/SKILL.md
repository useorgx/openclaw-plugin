---
name: orgx
description: Use when managing work with OrgX — reporting progress, requesting decisions, registering artifacts, syncing memory, checking quality gates, or viewing org status. Activates for phrases like "report progress", "request approval", "create initiative", "check orgx", "sync with orgx", "register artifact".
version: 3.0.0
user-invocable: true
tags:
  - orchestration
  - multi-agent
  - productivity
  - reporting
---

# OrgX Integration

Connect to OrgX for multi-agent orchestration, decision workflows, initiative tracking, model routing, quality gates, and structured work reporting.

## Quick Start

```bash
# Install the plugin
openclaw plugins install @useorgx/openclaw-plugin

# Or via npx
npx @useorgx/openclaw-plugin
```

After installing, pair with OrgX via the live dashboard at `http://127.0.0.1:18789/orgx/live` or set `ORGX_API_KEY` in your environment.

## MCP Tools Reference

### Work Reporting (primary contract)

Use the **two-tool reporting contract** for launch reporting:

**`orgx_emit_activity`** — Append-only telemetry (frequent updates).
```
orgx_emit_activity({
  initiative_id: "aa6d16dc-d450-417f-8a17-fd89bd597195",
  message: "Implemented auth middleware and validated redirects",
  phase: "execution",         // intent | execution | blocked | review | handoff | completed
  progress_pct: 60,           // optional 0-100
  next_step: "Add integration tests" // optional
})
```

**`orgx_apply_changeset`** — Transactional state mutations (batched, idempotent).
```
orgx_apply_changeset({
  initiative_id: "aa6d16dc-d450-417f-8a17-fd89bd597195",
  idempotency_key: "run_abc_turn_7_commit_1",
  operations: [
    { op: "task.update", task_id: "task_uuid", status: "in_progress" },
    { op: "decision.create", title: "Use SSE for live updates", urgency: "medium" }
  ]
})
```

Backward-compatible aliases:
- `orgx_report_progress` delegates to `orgx_emit_activity`
- `orgx_request_decision` delegates to `orgx_apply_changeset` (`decision.create`)

**`orgx_register_artifact`** — Register a deliverable (PR, document, config, etc.).
```
orgx_register_artifact({
  name: "PR #107: Fix Vercel build size",
  artifact_type: "pr",        // pr | commit | document | config | report | design | other
  description: "Reduced function size by pruning recursive assets",
  url: "https://github.com/org/repo/pull/107"  // (optional)
})
```

### Org Status & Sync

**`orgx_status`** — View active initiatives, agent states, pending decisions, tasks.

**`orgx_sync`** — Push local memory/daily log to OrgX, receive org context back.
```
orgx_sync({
  memory: "Contents of MEMORY.md",
  dailyLog: "Today's session summary"
})
```

### Quality & Spawning

**`orgx_spawn_check`** — Check quality gate + get model routing before spawning a sub-agent.
```
orgx_spawn_check({ domain: "engineering", taskId: "..." })
// Returns: { allowed: true, modelTier: "sonnet", checks: {...} }
```

**`orgx_quality_score`** — Record quality score (1-5) for completed work.
```
orgx_quality_score({
  taskId: "...",
  domain: "engineering",
  score: 4,
  notes: "Clean implementation, good test coverage"
})
```

### Entity Management

**`orgx_create_entity`** — Create an initiative, workstream, task, decision, milestone, artifact, or blocker.

**`orgx_update_entity`** — Update status/fields on any entity.

**`orgx_list_entities`** — Query entities by type and status.

### Run Control

**`orgx_delegation_preflight`** — Score scope quality and estimate ETA/cost before execution.

**`orgx_run_action`** — Pause, resume, cancel, or rollback a run.

**`orgx_checkpoints_list`** / **`orgx_checkpoint_restore`** — List and restore run checkpoints.

## Reporting Protocol

When working on a task or initiative, follow the two-tool reporting contract. This keeps state deterministic and idempotent.

### On task start
Call `orgx_emit_activity` with `phase: "intent"` and a brief summary of what you're about to do.

### At meaningful progress points
Call `orgx_emit_activity` at natural checkpoints: after finishing research, after implementation passes, after tests pass, etc. Include `progress_pct` when possible.

### When you need a human decision
Call `orgx_apply_changeset` with a `decision.create` operation including clear context/options. Set `blocking: true` when work must pause. Set urgency appropriately:
- **low** — Can wait hours/days
- **medium** — Should be decided today
- **high** — Blocking progress, needs attention soon
- **urgent** — Critical path, needs immediate attention

### When you produce a deliverable
Call `orgx_register_artifact` for anything the team should see: PRs, documents, config changes, reports, design files. Include a URL when available.

### On task completion
1. Call `orgx_emit_activity` with `phase: "completed"` and `progress_pct: 100`
2. Call `orgx_apply_changeset` to mark task/milestone completion or record final decisions
3. Call `orgx_quality_score` to self-assess your work (1-5 scale)

### On blockers
Call `orgx_emit_activity` with `phase: "blocked"` and describe the blocker. If human intervention is needed, use `orgx_apply_changeset` with a `decision.create` op.

## Model Routing

OrgX classifies tasks for model selection:

| Task Type | Tier | Model |
|---|---|---|
| Architecture, strategy, decisions, RFCs | **opus** | `anthropic/claude-opus-4-6` |
| Implementation, code, features, docs | **sonnet** | `anthropic/claude-sonnet-4` |
| Status checks, formatting, templates | **local** | `ollama/qwen2.5-coder:32b` |

Always call `orgx_spawn_check` before spawning sub-agents to get the right model tier.

## Live Dashboard

The plugin serves a live dashboard at `http://127.0.0.1:18789/orgx/live` showing:
- **Activity Timeline** — Real-time feed of agent work with threaded session views
- **Agents/Chats** — Active sessions grouped by agent
- **Decisions** — Pending approvals with inline approve/reject
- **Initiatives** — Active workstreams and progress

## Entity API

For direct API access:
```
GET  /api/entities?type={type}&status={status}&limit={n}
POST /api/entities
PATCH /api/entities
POST /api/entities/{type}/{id}/{action}
```

Entity types: `initiative`, `workstream`, `task`, `decision`, `milestone`, `artifact`, `agent`, `blocker`

## MCP Server (mcp.useorgx.com)

For environments that support MCP servers directly (Claude Desktop, Cursor, etc.), connect to `mcp.useorgx.com` for the full suite of 26+ OrgX tools including initiative management, decision workflows, and agent orchestration.
