# @useorgx/openclaw-plugin

OrgX plugin for [OpenClaw](https://openclaw.ai) — connect your AI agents to OrgX for orchestration, quality gates, model routing, and a live dashboard.

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

Access the OrgX command center at `http://localhost:18789/orgx/live` (or your gateway URL).

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

## Requirements

- OpenClaw 2026.1.0 or later
- Node.js 18+
- OrgX account with API key

## Links

- [OrgX](https://useorgx.com) — AI orchestration platform
- [OpenClaw](https://openclaw.ai) — Personal AI assistant framework
- [Documentation](https://docs.useorgx.com)
- [GitHub](https://github.com/useorgx/openclaw-plugin)

## License

MIT
