# @useorgx/openclaw-plugin

OrgX plugin for [OpenClaw](https://openclaw.ai) — connect your AI agents to OrgX for orchestration, quality gates, model routing, and a live dashboard.

## 60-Second Onboarding

1. Install the plugin.
2. Open `http://127.0.0.1:18789/orgx/live`.
3. Click **Connect OrgX**.
4. Sign in at [useorgx.com](https://useorgx.com) and approve the connection.
5. Return to OpenClaw. The plugin stores a dedicated credential and runs first sync automatically.

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
          "apiKey": "oxk-your-api-key"
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

## CLI Commands

```bash
# Show org status
openclaw orgx status

# Manual sync
openclaw orgx sync --memory "..." --daily-log "..."
```

## API Endpoints

When the plugin is loaded, these HTTP endpoints are available:

| Endpoint | Description |
|----------|-------------|
| `GET /orgx/live` | Live dashboard SPA |
| `GET /orgx/api/status` | Org status summary |
| `GET /orgx/api/agents` | Agent states |
| `GET /orgx/api/activity` | Activity feed |
| `GET /orgx/api/initiatives` | Initiative data |
| `GET /orgx/api/onboarding` | Config/setup state |
| `POST /orgx/api/onboarding/start` | Start browser pairing flow |
| `GET /orgx/api/onboarding/status` | Poll pairing status / auto-connect |
| `POST /orgx/api/onboarding/manual-key` | Manual key validation and persist |
| `POST /orgx/api/onboarding/disconnect` | Clear local plugin credential |
| `GET /orgx/api/live/sessions` | Live session tree |
| `GET /orgx/api/live/activity` | Live activity feed |
| `GET /orgx/api/live/stream` | Live SSE stream |
| `GET /orgx/api/handoffs` | Handoff summaries |

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
