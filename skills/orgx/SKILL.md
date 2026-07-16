---
name: orgx
description: Use when managing work through the OrgX OpenClaw plugin — reporting progress, requesting decisions, registering artifacts, syncing memory, checking quality gates, inspecting agent config policy, or viewing org status. Activates for phrases like "report progress", "request approval", "check orgx", "sync with orgx", or "register artifact".
version: 3.1.0
user-invocable: true
tags:
  - orchestration
  - multi-agent
  - productivity
  - reporting
---

# OrgX Integration

Use this skill when the **OrgX OpenClaw plugin** is installed and connected. This skill describes the **local plugin MCP surface** exposed by `@useorgx/openclaw-plugin`, not the broader hosted OrgX platform.

> Default-safe rule: if you are using a domain-scoped OrgX endpoint or the managed OrgX agent suite, prefer the **reporting contract** (`orgx_emit_activity`, `orgx_request_decision`, `orgx_register_artifact`) unless you know your scope explicitly allows mutation tools.

## Quick Start

```bash
# Install from ClawHub
openclaw plugins install clawhub:@useorgx/openclaw-plugin

# Pair with OrgX
openclaw orgx connect
```

After installing, pair with OrgX via the live dashboard at `http://127.0.0.1:18789/orgx/live` or set `ORGX_API_KEY` in your environment. Managed agent-suite provisioning and MCP client config edits are opt-in.

## Tool Surface

### Default-safe tools

These are the tools you should assume are available in the plugin's domain-scoped OrgX surface:

- `orgx_status`
- `orgx_sync`
- `list_agent_configs`
- `get_agent_config`
- `orgx_emit_activity`
- `orgx_report_progress`
- `update_stream_progress` (legacy alias)
- `orgx_register_artifact`
- `orgx_request_decision`
- `orgx_spawn_check`
- `orgx_quality_score`
- `orgx_proof_status`
- `orgx_record_outcome`
- `orgx_get_outcome_attribution`
- `orgx_verify_completion`

### Mutation and admin tools

These exist in the plugin, but are **not guaranteed** in every domain scope.

Available to operations and/or orchestration flows:

- `update_agent_config`
- `orgx_apply_changeset`
- `orgx_reassign_stream`
- `orgx_reassign_streams`
- `orgx_agent_sessions`
- `orgx_resume_agent_session`
- `orgx_clear_agent_session`

Available on the unscoped `/orgx/mcp` endpoint for power users and debugging:

- `orgx_sentinel_catalog`
- `orgx_delegation_preflight`
- `orgx_run_action`
- `orgx_manage_lifecycle` — use for pause/resume/retry/cancel when hierarchy and runtime state must stay synchronized
- `orgx_checkpoints_list`
- `orgx_checkpoint_restore`
- `orgx_create_entity`
- `orgx_update_entity`
- `orgx_list_entities`

If you explicitly need that elevated surface, use the `orgx-power` skill.

## Reporting Contract

### Progress updates

Use `orgx_emit_activity` as the append-only status feed.

```js
orgx_emit_activity({
  initiative_id: "aa6d16dc-d450-417f-8a17-fd89bd597195",
  message: "Implemented auth middleware and validated redirects",
  phase: "execution",
  progress_pct: 60,
  next_step: "Add integration tests"
})
```

Use `orgx_report_progress` or `update_stream_progress` only when a caller explicitly expects those aliases.

### Human decisions

Use `orgx_request_decision` as the default-safe decision path.

```js
orgx_request_decision({
  initiative_id: "aa6d16dc-d450-417f-8a17-fd89bd597195",
  question: "Approve the SSE rollout plan?",
  context: "Load test passed, but dashboard reconnect behavior still needs manual QA.",
  options: ["Approve rollout", "Hold for QA", "Rework plan"],
  urgency: "medium",
  blocking: true
})
```

If your scope explicitly allows `orgx_apply_changeset`, use it for batched state mutations and idempotent updates.

```js
orgx_apply_changeset({
  initiative_id: "aa6d16dc-d450-417f-8a17-fd89bd597195",
  idempotency_key: "run_abc_turn_7_commit_1",
  operations: [
    { op: "task.update", task_id: "task_uuid", status: "in_progress" },
    { op: "decision.create", title: "Use SSE for live updates", urgency: "medium" }
  ]
})
```

Backward-compatible aliases still exist:

- `orgx_report_progress` delegates to `orgx_emit_activity`
- `update_stream_progress` delegates to `orgx_report_progress`
- `orgx_request_decision` delegates to `orgx_apply_changeset` (`decision.create`)

### Deliverables

Register anything that should show up in OrgX history with `orgx_register_artifact`.

Durable proof rule:

- Always use a durable source for `url`: a GitHub PR URL, commit permalink, blob permalink, published doc URL, or an absolute file path.
- Never use OrgX wrapper pages such as `/live/...`, `/artifacts/...`, or `/console/...` as artifact proof.
- Treat `content` as preview material only. It is helpful for inspection, but it does not replace the durable source.

```js
orgx_register_artifact({
  name: "PR #107: Fix Vercel build size",
  artifact_type: "pr",
  description: "Reduced function size by pruning recursive assets",
  url: "https://github.com/org/repo/pull/107"
})
```

## Common Workflows

### Org status and memory sync

- `orgx_status` for active initiatives, pending decisions, and task state.
- `orgx_sync` to push local memory and receive current org context.

```js
orgx_sync({
  memory: "Contents of MEMORY.md",
  dailyLog: "Today's session summary"
})
```

### Quality and proof

- `orgx_spawn_check` before handing work to another model or agent.
- `orgx_quality_score` after completing a meaningful unit of work.
- `orgx_proof_status`, `orgx_verify_completion`, and `orgx_get_outcome_attribution` for proof ladder checks.

```js
orgx_spawn_check({ domain: "engineering", taskId: "..." })
```

### Agent policy visibility

Use these when you need to inspect the managed OrgX agent behavior policy:

- `list_agent_configs`
- `get_agent_config`

Only orchestration and operations flows should assume `update_agent_config` is available.

## Reporting Protocol

### On task start

Call `orgx_emit_activity` with `phase: "intent"` and a short summary of the intended work.

### At meaningful progress points

Call `orgx_emit_activity` after research, implementation, verification, or handoff milestones. Include `progress_pct` when the state is clear.

### When blocked

1. Call `orgx_emit_activity` with `phase: "blocked"`.
2. If a human decision is required, call `orgx_request_decision`.
3. Only use `orgx_apply_changeset` directly if your scope explicitly allows mutation tools.

### On completion

1. Call `orgx_emit_activity` with `phase: "completed"` and `progress_pct: 100`.
2. Register the artifact if something ship-worthy was produced.
3. Record a quality score when appropriate.

## Live Dashboard

The plugin serves a local dashboard at `http://127.0.0.1:18789/orgx/live` showing:

- activity timeline
- active agent/chat sessions
- pending decisions
- initiative and workstream state

## Hosted OrgX MCP Server

`https://mcp.useorgx.com/mcp` exists as a separate hosted OrgX MCP surface. Treat that as **separate from this plugin skill** unless the user explicitly asks for the hosted, server-side toolset.
