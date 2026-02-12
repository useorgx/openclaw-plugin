# @useorgx/openclaw-plugin

OrgX plugin for [OpenClaw](https://openclaw.ai) — connect your AI agents to OrgX for orchestration, quality gates, model routing, and a live dashboard.

## 60-Second Onboarding

1. Install the plugin.
2. Open `http://127.0.0.1:18789/orgx/live`.
3. Click **Connect OrgX**.
4. Sign in at [useorgx.com](https://useorgx.com) and approve the connection.
5. Return to OpenClaw. The plugin stores a dedicated credential and runs first sync automatically.

If Claude/Cursor/Codex MCP configs are detected on this machine, the pairing flow also installs a local MCP bridge entry (no OAuth) pointing at `http://127.0.0.1:18789/orgx/mcp`. To opt out, set `ORGX_DISABLE_MCP_CLIENT_AUTOCONFIG=1` in your environment.

Manual API key entry is still available as a permanent fallback from the onboarding panel.

## Installation

```bash
openclaw plugins install @useorgx/openclaw-plugin
```

Or manually add to your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["@useorgx/openclaw-plugin"]
    },
    "entries": {
      "orgx": {
        "enabled": true,
        "config": {
          "apiKey": "oxk_..."
        }
      }
    }
  }
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | — | Your OrgX API key (get one at [useorgx.com](https://useorgx.com)) |
| `baseUrl` | string | `https://www.useorgx.com` | OrgX API base URL |
| `dashboardEnabled` | boolean | `true` | Enable the live dashboard at `/orgx/live` |

## Features

### 🛠️ MCP Tools

The plugin registers these tools for your agents:

- **`orgx_status`** — Get current org status (initiatives, agents, tasks, decisions)
- **`orgx_sync`** — Bidirectional memory sync with OrgX
- **`orgx_spawn_check`** — Pre-spawn quality gate + model routing
- **`orgx_quality_score`** — Record quality scores for completed work
- **`orgx_create_entity`** — Create initiatives, tasks, decisions, etc.
- **`orgx_update_entity`** — Update entity status and fields
- **`orgx_list_entities`** — Query entities by type and status

### 📊 Live Dashboard

Access the OrgX command center at `http://127.0.0.1:18789/orgx/live` (or your gateway URL).
The Vite dev server (`http://localhost:5173`) is only for local preview; the installed plugin runs on the OpenClaw port (18789).

Shows:
- Active initiatives with progress
- Agent status and current tasks
- Pending decisions requiring approval
- Activity stream
- Outbox replay visibility for buffered offline events

### 🎯 Model Routing

OrgX automatically routes tasks to the appropriate model tier:

| Task Type | Model Tier | Example Models |
|-----------|------------|----------------|
| Architecture, strategy, RFCs | **opus** | claude-opus-4 |
| Implementation, code, docs | **sonnet** | claude-sonnet-4 |
| Status checks, formatting | **local** | qwen2.5-coder |

### 🚦 Quality Gates

Before spawning sub-agents, check the quality gate:

```
Agent calls orgx_spawn_check(domain: "engineering", taskId: "...")
  ↓
OrgX checks: rate limit, quality score threshold, task assignment
  ↓
Returns: { allowed: true, modelTier: "sonnet" }
  ↓
Agent spawns with recommended model
```

## Feature Matrix

| Capability | Status | Notes |
|-----------|--------|-------|
| Browser pairing onboarding | ✅ | `POST /orgx/api/onboarding/start` + polling flow |
| Manual API key fallback | ✅ | In onboarding gate and `manual-key` endpoint |
| Live sessions + activity + handoffs | ✅ | SSE with local fallback paths |
| Mission Control hierarchy view | ✅ | Initiative → workstream → milestone → task |
| Run control shortcuts | ✅ | Pause/resume/cancel/checkpoint/rollback in Session Detail |
| Outbox buffering + replay | ✅ | Local queue + auto replay on sync |
| Outbox observability in dashboard | ✅ | Pending/replay indicators in header/notifications |
| Plugin diagnostics (`doctor`) | ✅ | CLI + `GET /orgx/api/health` |
| Full-auto codex dispatch | ✅ | `npm run job:dispatch` with retries + rollups |

## CLI Commands

```bash
# Show org status
openclaw orgx status

# Manual sync
openclaw orgx sync --memory "..." --daily-log "..."

# Diagnostics (local + remote probe)
openclaw orgx doctor

# Diagnostics JSON without remote probe
openclaw orgx doctor --json --no-remote
```

## Full-Auto Codex Dispatch Job

Reusable orchestration job to dispatch/monitor parallel `codex --full-auto` workers against OrgX tasks and report progress back through the reporting control plane (`/api/client/live/activity` + `/api/client/live/changesets/apply`).

```bash
export ORGX_API_KEY=oxk_...

npm run job:dispatch -- \
  --initiative_id=aa6d16dc-d450-417f-8a17-fd89bd597195 \
  --plan_file=/Users/hopeatina/Code/orgx-openclaw-plugin/docs/orgx-openclaw-launch-workstreams-plan-2026-02-14.md \
  --codex_args="--full-auto" \
  --concurrency=6
```

Key behavior:
- Pulls tasks from OrgX for selected workstreams
- Runs `orgx_spawn_check` preflight per task before dispatch
- Injects required OrgX skill context (for example `orgx-engineering-agent`) into worker prompts
- Applies the same spawn-guard + skill-policy enforcement to manual launch, restart, and Next Up fallback dispatch paths
- Spawns parallel Codex workers per task
- Retries failures with backoff up to `--max_attempts`
- Emits activity and task status transitions into OrgX DB
- Auto-creates a blocking decision when a task exhausts retries (disable with `--decision_on_block=false`)
- Persists resumable state to `.orgx-codex-jobs/<job-id>/job-state.json`

Resume patterns:
- Resume an existing job run (reuse `--job_id`): add `--resume=true`
- Retry tasks previously blocked in the state file: add `--retry_blocked=true` (requires `--resume=true`)
- Local safety guardrails: `--resource_guard=true` and `--worker_timeout_sec`/`--worker_log_stall_sec` prevent runaway local dispatch

Notes:
- `ORGX_USER_ID` is legacy and only needed with legacy service-key flows.
- User-scoped `oxk_...` API keys should not send `X-Orgx-User-Id`.

Manual dispatch:
- Use `docs/marketing/manual-agent-dispatch-golden-prompt.md` when manually launching a marketing agent for a specific task (non-batched dispatch).

## API Endpoints

When the plugin is loaded, these HTTP endpoints are available:

| Endpoint | Description |
|----------|-------------|
| `GET /orgx/live` | Live dashboard SPA |
| `GET /orgx/api/status` | Org status summary |
| `GET /orgx/api/agents` | Agent states |
| `GET /orgx/api/activity` | Activity feed |
| `GET /orgx/api/initiatives` | Initiative data |
| `GET /orgx/api/health` | Plugin diagnostics + outbox/sync health |
| `GET /orgx/api/onboarding` | Config/setup state |
| `POST /orgx/api/onboarding/start` | Start browser pairing flow |
| `GET /orgx/api/onboarding/status` | Poll pairing status / auto-connect |
| `POST /orgx/api/onboarding/manual-key` | Manual key validation and persist |
| `POST /orgx/api/onboarding/disconnect` | Clear local plugin credential |
| `GET /orgx/api/live/sessions` | Live session tree |
| `GET /orgx/api/live/activity` | Live activity feed |
| `GET /orgx/api/live/stream` | Live SSE stream |
| `GET /orgx/api/handoffs` | Handoff summaries |
| `POST /orgx/mcp` | Local MCP bridge (tools/list, tools/call) |

## Requirements

- OpenClaw 2026.1.0 or later
- Node.js 18+
- OrgX account (browser pairing recommended, API key fallback supported)

## Links

- [OrgX](https://useorgx.com) — AI orchestration platform
- [OpenClaw](https://openclaw.ai) — Personal AI assistant framework
- [OpenClaw Setup Guide](https://orgx.mintlify.site/guides/openclaw-plugin-setup)
- [Documentation](https://docs.useorgx.com)
- [GitHub](https://github.com/useorgx/openclaw-plugin)

## License

MIT
