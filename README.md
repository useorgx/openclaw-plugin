# @useorgx/openclaw-plugin

OrgX plugin for [OpenClaw](https://openclaw.ai) — connect your AI agents to OrgX for orchestration, quality gates, model routing, and a live dashboard.

## 60-Second Onboarding

1. Install the plugin.
2. Open `http://127.0.0.1:18789/orgx/live`.
3. Click **Connect OrgX**.
4. Sign in at [useorgx.com](https://useorgx.com) and approve the connection.
5. Return to OpenClaw. The plugin stores a dedicated credential and runs first sync automatically (no key copy/paste).

If Claude/Cursor/Codex MCP configs are detected on this machine, the pairing flow also installs a local MCP bridge entry (no OAuth) pointing at `http://127.0.0.1:18789/orgx/mcp`. To avoid overwriting your hosted `orgx` server entry, the local bridge is installed under the name `orgx-openclaw`. To opt out entirely, set `ORGX_DISABLE_MCP_CLIENT_AUTOCONFIG=1`.

Manual API key entry is still available as a permanent fallback from the onboarding panel.

## Installation

```bash
openclaw plugins install @useorgx/openclaw-plugin
```

## Local MCP Bridge (Claude/Codex/Cursor)

This plugin exposes the same `orgx_*` tools over a local MCP HTTP endpoint served by the OpenClaw gateway:

- URL: `http://127.0.0.1:18789/orgx/mcp` (port follows your OpenClaw gateway config)
- Why: avoids the separate cloud MCP OAuth flow and keeps the `oxk_...` key stored only in the plugin's credential store.

On successful browser pairing, the plugin will attempt to patch:

- `~/.claude/mcp.json` (adds `mcpServers["orgx-openclaw"]` pointing to the local bridge)
- `~/.codex/config.toml` (add/update `[mcp_servers."orgx-openclaw"].url` to the local bridge)
- `~/.cursor/mcp.json` (adds `mcpServers["orgx-openclaw"]` pointing to the local bridge)

Each file is backed up first (only when a change is needed) with a `*.bak.<timestamp>-<rand>` suffix.

Disable auto-config by setting `ORGX_DISABLE_MCP_CLIENT_AUTOCONFIG=1`.

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
| `apiKey` | string | — | Your OrgX API key (optional if you use browser pairing from `/orgx/live`) |
| `baseUrl` | string | `https://www.useorgx.com` | OrgX API base URL |
| `syncIntervalMs` | number | `300000` | Background sync interval (ms) |
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `dashboardEnabled` | boolean | `true` | Enable the live dashboard at `/orgx/live` |

Environment overrides:

- `ORGX_API_KEY` overrides `apiKey`
- `ORGX_BASE_URL` overrides `baseUrl`

## Features

### 🛠️ MCP Tools

The plugin registers these tools for your agents:

- **`orgx_status`** — Get current org status (initiatives, agents, tasks, decisions)
- **`orgx_status_json`** — Get current org status as JSON (for MCP Apps / automation)
- **`orgx_live_app`** — Open the OrgX Live MCP App (interactive widget)
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

### 🔁 Auto-Continue (Scaffold → Agent Execution)

If you scaffold an initiative from chat (for example, "plan X" and then create/scaffold), OrgX can automatically start executing the first workstream via the stream auto-continue pipeline.

Troubleshooting:
- If agents do not start automatically, say: `start agents` to re-trigger dispatch.
- Open the live link (Mission Control) to see stream status (`ready`, `active`, `blocked`) and any upgrade/approval decisions.

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

### 🔑 BYOK (Bring Your Own Keys)

If you use BYOK models (OpenAI, Anthropic, OpenRouter), store your provider keys in OpenClaw. The OrgX plugin reads OpenClaw settings and injects keys when it invokes OpenClaw CLI commands, so you do not need to put provider keys in the OrgX plugin config.

### 🩺 Diagnostics

- `openclaw orgx doctor` runs local checks and can optionally probe the OrgX API.
- `openclaw gateway status --json` shows the OpenClaw gateway port and runtime state.

### 🔁 Gateway Watchdog

The plugin starts a lightweight watchdog daemon that periodically probes the local OpenClaw gateway and restarts it if needed.

- Disable: `ORGX_DISABLE_GATEWAY_WATCHDOG=1`
- Tune: `ORGX_GATEWAY_WATCHDOG_INTERVAL_MS`, `ORGX_GATEWAY_WATCHDOG_FAILURES`, `ORGX_GATEWAY_WATCHDOG_TIMEOUT_MS`

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

## SEO Automation (Keywords Everywhere + DataForSEO)

This repo also includes a repo-local SEO pipeline runner (scripts only; not shipped in the plugin package) under `scripts/seo/`.

- Apply an OrgX initiative plan for SEO automation: `npm run seo:plan`
- Run the pipeline:
  - Dry run (no API calls): `npm run seo:run -- --config=docs/seo/seo.config.example.json --mode=all --dry-run=true`
  - Live run: `npm run seo:run -- --config=docs/seo/seo.config.example.json --mode=all`

Details: `scripts/seo/README.md`

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

## Maintainers: Release to NPM

This repo publishes on GitHub Release via `.github/workflows/publish.yml`.

1. Update versions
   - `package.json` version (NPM version)
   - `openclaw.plugin.json` version (what `openclaw plugins list` displays)
   - `CHANGELOG.md`
2. Verify
   - `npm run typecheck`
   - `npm run test:hooks`
   - `npm run build`
   - Optional: `npm run verify:clean-install`
3. Publish
   - Create a GitHub release for the tag (workflow publishes with provenance)
4. Smoke test
   - `openclaw plugins install @useorgx/openclaw-plugin@<version>`
   - Verify `http://127.0.0.1:18789/orgx/live` pairing and `http://127.0.0.1:18789/orgx/mcp` MCP bridge

## Links

- [OrgX](https://useorgx.com) — AI orchestration platform
- [OpenClaw](https://openclaw.ai) — Personal AI assistant framework
- [OpenClaw Setup Guide](https://orgx.mintlify.site/guides/openclaw-plugin-setup)
- [Documentation](https://docs.useorgx.com)
- [GitHub](https://github.com/useorgx/openclaw-plugin)

## License

MIT
