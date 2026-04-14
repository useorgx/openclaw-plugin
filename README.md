# OrgX for OpenClaw

**Your agents are capable. They just can't remember yesterday.**

OpenClaw agents are powerful. They write code, manage files, browse the web, and execute complex tasks. But every session starts from zero. Your agents do not know what the other agents decided. They do not know what you approved last Tuesday. They cannot build on work from three days ago without you manually pasting context back in.

You are the one holding it all together. You are the human API.

**OrgX fixes this.** It gives your OpenClaw agents persistent organizational memory, shared structure, and coordinated execution so they stop working like strangers and start working like a team.

---

## See it

<p align="center">
  <img src="./orgx-live-mission-control-0.7.15-check.png" alt="OrgX Mission Control showing coordinated initiatives, workstreams, and execution state inside OpenClaw" width="48%" />
  <img src="./orgx-live-activity-0.7.15-check.png" alt="OrgX Activity view showing live agent updates, decisions, and shared execution history inside OpenClaw" width="48%" />
</p>

<p align="center">
  <em>Mission Control for shared execution state. Activity for the live history your agents can build on.</em>
</p>

---

## What changes after you install this

| Before OrgX | After OrgX |
|---|---|
| Each agent starts every session with amnesia | Agents query decisions, context, and history from prior sessions |
| You manually stitch context between agents | Agents read and write to a shared entity graph: initiatives, milestones, decisions, tasks |
| "What was I working on?" requires you to remember | The morning brief tells your agents, and you, exactly where things stand |
| Running 5+ agents means 5+ unsyncable contexts | One coordination layer across all agents and sessions |
| Heartbeat files and markdown workarounds | Typed organizational structure with semantic relationships |

---

## Install

```bash
# From your OpenClaw workspace
openclaw plugins install clawhub:@useorgx/openclaw-plugin

# npm also works if you prefer the package directly
openclaw plugins install @useorgx/openclaw-plugin
```

Then open the OrgX dashboard in your OpenClaw gateway, click **Connect OrgX**, and approve the browser pairing flow. First sync runs automatically after connect.

Agent-suite provisioning is **opt-in**. MCP client config edits are also **opt-in**. You can review and apply the managed suite later from **Settings -> Agent Suite** in the dashboard, and you can explicitly enable MCP client auto-configuration in plugin config if you want that behavior.

**Manual key setup** is still available if you prefer it. Use the onboarding panel and choose **Manual API key**.

---

## What you get

### Persistent Organizational Memory
Your agents can query what happened in past sessions. Decisions persist. Context accumulates. An agent spawned today can ask, "What did we decide about the API design last week?" and get an answer.

### Optional Agent Suite Provisioning
OrgX can create managed agent workspaces, install coordinated configurations, and preserve your local overrides when you explicitly apply the suite. Your existing setup does not get clobbered. It gets enhanced.

### Shared Entity Graph
Initiatives, workstreams, milestones, decisions, and tasks: all structured, all queryable, all shared across your agents. This is not a flat to-do list. It is a model of how your work actually connects.

### Live Dashboard
See what your agents are doing, what decisions are pending, and what is blocked. One view across your entire agent operation.

### Local MCP Bridge
OrgX connects through MCP, so the coordination layer can live wherever your agents work. The plugin exposes a local bridge at `/orgx/mcp`. If you want Claude, Cursor, or Codex wired to that bridge automatically, you can explicitly enable that behavior in plugin config.

---

## How it works with your existing setup

OrgX does not replace your OpenClaw agents or change how they work. It adds a shared memory and coordination layer underneath them.

```text
┌─────────────────────────────────────────┐
│           Your OpenClaw Agents          │
│  (coding, research, marketing, ops...)  │
└──────────────┬──────────────────────────┘
               │ read/write
┌──────────────▼──────────────────────────┐
│          OrgX Entity Graph              │
│  decisions · initiatives · milestones   │
│  tasks · memory · agent trust levels    │
└──────────────┬──────────────────────────┘
               │ persists across
┌──────────────▼──────────────────────────┐
│     Every session. Every agent.         │
│     Every tool. Forever.                │
└─────────────────────────────────────────┘
```

Your agents keep their skills, configurations, and autonomy. They just gain the ability to remember, coordinate, and build on each other's work.

---

## vs. heartbeat files, Paperclip, and manual context

| Approach | Memory | Structure | Cross-agent coordination |
|---|---|---|---|
| Heartbeat `.md` files | File-based, fragile | Flat task lists | Manual |
| Paperclip | File-based + schedules | Org chart + tickets | Delegation via hierarchy |
| **OrgX** | **Typed entity graph** | **Semantic: initiatives -> workstreams -> milestones -> decisions -> tasks** | **Shared memory + trust architecture + autonomous coordination** |

Heartbeat files are a workaround. Paperclip organizes the workaround. OrgX removes the need for the workaround entirely.

---

## Quick start: scaffold your first initiative

After connecting, try this in any OpenClaw agent session:

```text
Scaffold an initiative called "MVP Launch" with workstreams for engineering, marketing, and operations.
```

OrgX creates the structure, and every agent in your setup can query and contribute to it. When your engineering agent finishes a task, your marketing agent can operate against the same shared context.

---

## Need help setting this up for your specific workflow?

OrgX Amplify is our guided setup service for founders and teams running serious agent operations. We configure OrgX for your exact stack, migrate your existing context, and get you operational in a week.

-> [Book an Amplify call](https://useorgx.com/amplify)

---

## Security and transparency

OrgX is designed for developers who want to know what a plugin changes before they install it.

### Local files the plugin may write

The plugin stores its own auth and local state under:

- `~/.config/useorgx/openclaw-plugin/auth.json`
- `~/.config/useorgx/openclaw-plugin/installation.json`
- `~/.config/useorgx/openclaw-plugin/snapshot.json`
- `~/.openclaw/orgx-outbox/`

If you explicitly enable MCP client auto-configuration, the plugin may update supported client config files and create timestamped backups before writing:

- `~/.claude/mcp.json`
- `~/.codex/config.toml`
- `~/.cursor/mcp.json`

If you choose to apply the managed OrgX agent suite, the plugin may also create or update managed OpenClaw workspace files. Conflict detection is used to avoid silently overwriting out-of-band edits.

### Credentials

Browser pairing and manual API-key setup both store credentials locally on your machine. Auth files are written with restricted filesystem permissions. The current credential store is file-based rather than OS-keychain-backed. The README and plugin UI intentionally avoid printing full key values.

### Network calls

The plugin talks to OrgX services for pairing, sync, MCP, and dashboard-backed workflows:

- `https://www.useorgx.com`
- `https://mcp.useorgx.com/mcp`

### Telemetry

Product telemetry is **off by default**. PostHog events are only sent if you explicitly enable telemetry with environment variables such as `ORGX_TELEMETRY_ENABLED`. Telemetry can also be disabled via `ORGX_TELEMETRY_DISABLED`, `OPENCLAW_TELEMETRY_DISABLED`, or `POSTHOG_DISABLED`.

### Background processes and local execution

The plugin runs a background sync service as part of normal operation. It can also start a local gateway watchdog process to keep the OpenClaw gateway reachable; if you do not want that behavior, set `ORGX_DISABLE_GATEWAY_WATCHDOG=1`.

Agent turns, terminal opens, and other `openclaw` CLI child-process actions are only triggered by explicit runtime or dashboard actions. They are not part of the passive install path.

### What the plugin does not do by default

- It does not auto-install the managed OrgX agent suite unless you enable that behavior.
- It does not patch Claude, Cursor, or Codex MCP config files unless you enable that behavior.
- It does not send product telemetry unless you explicitly enable it.

---

## Links

- [OrgX Platform](https://useorgx.com)
- [OrgX MCP Server](https://mcp.useorgx.com/mcp)
- [Documentation](https://docs.useorgx.com)
- [Discord](https://discord.gg/orgx)
- [GitHub](https://github.com/useorgx)

**Built by [Hope](https://twitter.com/hopeatogun)** - solo founder, bioengineering background, self-taught engineer. Building the coordination layer for the agent era since a 2016 ML thesis on directed network evolution.

---

## Technical reference

## What's New (0.7.x)

- Mission Control lifecycle UX now cleanly separates `Next Up` queue intent from `In Progress` runtime state, with stronger task/workstream hierarchy rendering and queue controls (`Play`, `Pin`, `Reorder`, `Move`, `Bulk`, `Clear`).
- Autopilot and manual `Play` now share the same lifecycle contract and spawn-guard behavior, including deterministic blocked/needs-decision handling surfaced in triage and activity.
- Workspace-scoped reads/writes were hardened across Mission Control graph, Next Up, slices, and snapshot surfaces to avoid cross-workspace leakage.
- Activity and session detail surfaces were upgraded with clearer run outcome metadata, safer error messaging, and improved context labels.
- Dashboard build output was stabilized by fixing chunk-splitting behavior and eliminating circular-chunk warnings in production builds.

## Architecture Overview

```
                         ┌──────────────────────────────┐
                         │       OrgX Cloud API         │
                         │   (useorgx.com)              │
                         │                              │
                         │  Snapshots, Decisions,       │
                         │  Activity, Entity CRUD,      │
                         │  Quality Gates, Model Routing │
                         └──────────────┬───────────────┘
                                        │
                              Authenticated OrgX session
                                        │
┌───────────────────────────────────────┼───────────────────────────────────────┐
│  OpenClaw Gateway (localhost:18789)   │                                       │
│  ┌────────────────────────────────────┴──────────────────────────────────┐    │
│  │                     OrgX Plugin (this repo)                          │    │
│  │                                                                      │    │
│  │  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────┐  │    │
│  │  │  OrgXClient   │   │   Outbox      │   │   State Stores          │  │    │
│  │  │              │   │              │   │                         │  │    │
│  │  │  API calls   │   │  Offline     │   │  auth-store    (creds) │  │    │
│  │  │  to cloud    │◄──│  event queue │   │  snapshot-store (cache) │  │    │
│  │  │              │   │  + replay    │   │  activity-store (feed)  │  │    │
│  │  └──────┬───────┘   └──────────────┘   │  agent-run-store       │  │    │
│  │         │                               │  next-up-queue-store   │  │    │
│  │         │                               └─────────────────────────┘  │    │
│  │         │                                                            │    │
│  │  ┌──────┴──────────────────────────────────────────────────────────┐ │    │
│  │  │                    HTTP Handler                                 │ │    │
│  │  │                                                                 │ │    │
│  │  │  /orgx/live          → Dashboard SPA (Vite-built React app)    │ │    │
│  │  │  /orgx/api/*         → Modular REST routes                    │ │    │
│  │  │  /orgx/mcp           → MCP bridge (tools/list, tools/call)     │ │    │
│  │  │  /orgx/api/live/*    → Polling + SSE for real-time data        │ │    │
│  │  └────────────────────────────────┬────────────────────────────────┘ │    │
│  │                                   │                                  │    │
│  │  ┌────────────────────────────────┼─────────────────────────────┐   │    │
│  │  │  Background Services           │                             │   │    │
│  │  │                                │                             │   │    │
│  │  │  Sync service (every 5min)     │  Gateway watchdog           │   │    │
│  │  │  Agent suite provisioning      │  MCP client auto-config     │   │    │
│  │  │  Auto-continue pipeline        │  Worker supervisor          │   │    │
│  │  └────────────────────────────────┘─────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│  ┌───────────────────────────────────┴──────────────────────────────────┐    │
│  │  MCP Tools (exposed to agents)                                       │    │
│  │                                                                      │    │
│  │  orgx_status         orgx_spawn_check      orgx_create_entity       │    │
│  │  orgx_sync           orgx_quality_score     orgx_update_entity       │    │
│  │  orgx_emit_activity  orgx_request_decision  orgx_list_entities       │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
                                        │
                            SSE primary + polling fallback
                                        │
                         ┌──────────────┴───────────────┐
                         │     React Dashboard          │
                         │     /orgx/live                │
                         │                              │
                         │  Mission Control (hierarchy) │
                         │  Activity Timeline           │
                         │  Decision Queue (approve/    │
                         │    reject with notes)        │
                         │  Session Inspector           │
                         │  Agent Provisioning          │
                         └──────────────────────────────┘
```

### Data Flow

```
Agent calls MCP tool (e.g. orgx_emit_activity)
  → Plugin validates + forwards to OrgX Cloud
  → Cloud persists, returns updated state
  → Plugin caches snapshot locally
  → Dashboard subscribes to /orgx/api/live/stream (SSE)
  → Falls back to /orgx/api/live/snapshot-v2 polling when needed
  → useLiveData hook merges + renders

If cloud is unreachable:
  → Plugin queues event in Outbox (~/.orgx/plugin/outbox/)
  → Dashboard reads from cached snapshot + outbox replay
  → On reconnect, outbox auto-replays with backoff
```

## Installation

```bash
openclaw plugins install @useorgx/openclaw-plugin
```

## Local MCP Bridge (Claude/Codex/Cursor)

This plugin exposes the same `orgx_*` tools over a local MCP HTTP endpoint served by the OpenClaw gateway:

- URL: `http://127.0.0.1:18789/orgx/mcp` (port follows your OpenClaw gateway config)
- Why: avoids the separate cloud MCP OAuth flow and keeps your OrgX credential in the plugin's local credential store.

If you explicitly enable MCP client auto-configuration, the plugin can patch:

- `~/.claude/mcp.json` (adds `mcpServers["orgx-openclaw"]` pointing to the local bridge)
- `~/.codex/config.toml` (add/update `[mcp_servers."orgx-openclaw"].url` to the local bridge)
- `~/.cursor/mcp.json` (adds `mcpServers["orgx-openclaw"]` pointing to the local bridge)

Each file is backed up first (only when a change is needed) with a `*.bak.<timestamp>-<rand>` suffix.

You can also force-disable this path with `ORGX_DISABLE_MCP_CLIENT_AUTOCONFIG=1`.

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
          "apiKey": "<orgx-api-key>"
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
| `autoInstallAgentSuiteOnConnect` | boolean | `false` | Automatically apply the managed OrgX agent suite after connect/sync |
| `autoConfigureMcpClientsOnConnect` | boolean | `false` | Automatically patch detected Claude, Cursor, and Codex MCP client configs after browser pairing |
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `dashboardEnabled` | boolean | `true` | Enable the live dashboard at `/orgx/live` |

Environment overrides:

- `ORGX_API_KEY` overrides `apiKey`
- `ORGX_BASE_URL` overrides `baseUrl`

## Features

### MCP Tools

The plugin currently registers **30 MCP tools** from `src/tools/core-tools.ts`.

Core sync/reporting:
- `orgx_status`
- `orgx_sync`
- `orgx_emit_activity`
- `orgx_report_progress`
- `orgx_register_artifact`

Delegation, checkpoints, run control:
- `orgx_delegation_preflight`
- `orgx_spawn_check`
- `orgx_run_action`
- `orgx_checkpoints_list`
- `orgx_checkpoint_restore`

Quality, proof, and outcomes:
- `orgx_quality_score`
- `orgx_proof_status`
- `orgx_verify_completion`
- `orgx_record_outcome`
- `orgx_get_outcome_attribution`

Entity and stream management:
- `orgx_create_entity`
- `orgx_update_entity`
- `orgx_list_entities`
- `orgx_reassign_stream`
- `orgx_reassign_streams`
- `orgx_apply_changeset`
- `update_stream_progress`

Decision and config/policy:
- `orgx_request_decision`
- `orgx_sentinel_catalog`
- `list_agent_configs`
- `get_agent_config`
- `update_agent_config`

Session continuity:
- `orgx_agent_sessions`
- `orgx_resume_agent_session`
- `orgx_clear_agent_session`

The local MCP bridge endpoints are:
- `/orgx/mcp` (full tool surface)
- `/orgx/mcp/{domain}` (domain-scoped subset)

### Live Dashboard

Access the OrgX command center at `http://127.0.0.1:18789/orgx/live` (or your gateway URL).
The Vite dev server (`http://localhost:5173`) is only for local preview; the installed plugin runs on the OpenClaw port (18789).

Shows:
- Mission Control hierarchy (initiative -> workstream -> milestone -> task)
- `Next Up` queue controls (play/pin/reorder/move/bulk/clear)
- `In Progress` runtime lane for active slices and agents
- Activity feed + detail modal with decision/review context
- Triage queue for blocked and needs-decision work
- Outbox replay visibility for buffered offline events

### Auto-Continue (Scaffold to Agent Execution)

If you scaffold an initiative from chat (for example, "plan X" then create/scaffold), OrgX can automatically execute queued slices through the auto-continue pipeline.

Execution behavior:
- `Play` on a `Next Up` card executes the same guarded lifecycle used by autopilot.
- `manual` automation level blocks auto-dispatch unless explicitly triggered.
- `supervised` automation level executes one slice then pauses.
- `active` automation level continues dispatch until completion, block, or explicit stop.

Troubleshooting:
- If agents do not start automatically, say: `start agents` to re-trigger dispatch.
- Open Mission Control to inspect `auto-continue` status (`ready`, `active`, `blocked`) and any upgrade/approval decisions.

### Model Routing

OrgX automatically routes tasks to the appropriate model tier:

| Task Type | Model Tier | Example Models |
|-----------|------------|----------------|
| Architecture, strategy, RFCs | **opus** | claude-opus-4 |
| Implementation, code, docs | **sonnet** | claude-sonnet-4 |
| Status checks, formatting | **local** | qwen2.5-coder |

### Quality Gates

Before spawning sub-agents, check the quality gate:

```
Agent calls orgx_spawn_check(domain: "engineering", taskId: "...")
  -> OrgX checks: rate limit, quality score threshold, task assignment
  -> Returns: { allowed: true, modelTier: "sonnet" }
  -> Agent spawns with recommended model
```

### BYOK (Bring Your Own Keys)

If you use BYOK models (OpenAI, Anthropic, OpenRouter), store your provider keys in OpenClaw. The OrgX plugin reads OpenClaw settings and injects keys when it invokes OpenClaw CLI commands, so you do not need to put provider keys in the OrgX plugin config.

### Diagnostics

- `openclaw orgx doctor` runs local checks and can optionally probe the OrgX API.
- `openclaw gateway status --json` shows the OpenClaw gateway port and runtime state.

### Gateway Watchdog

The plugin starts a lightweight watchdog daemon that periodically probes the local OpenClaw gateway and restarts it if needed.

- Disable: `ORGX_DISABLE_GATEWAY_WATCHDOG=1`
- Tune: `ORGX_GATEWAY_WATCHDOG_INTERVAL_MS`, `ORGX_GATEWAY_WATCHDOG_FAILURES`, `ORGX_GATEWAY_WATCHDOG_TIMEOUT_MS`

## Feature Matrix

| Capability | Status | Notes |
|-----------|--------|-------|
| Browser pairing onboarding | Done | `POST /orgx/api/onboarding/start` + polling flow |
| Manual API key fallback | Done | In onboarding gate and `manual-key` endpoint |
| Live sessions + activity + handoffs | Done | SSE-first transport with snapshot fallback |
| Mission Control hierarchy view | Done | Initiative -> workstream -> milestone -> task |
| Next Up -> In Progress lifecycle lanes | Done | Queue intent separated from active runtime state |
| Play + Autopilot unified contract | Done | Shared spawn-guard + decision semantics |
| Workspace-scoped mission control reads | Done | Scope-safe graph/queue/slice retrieval |
| Run control shortcuts | Done | Pause/resume/cancel/checkpoint/rollback in Session Detail |
| Outbox buffering + replay | Done | Local queue + auto replay on sync |
| Outbox observability in dashboard | Done | Pending/replay indicators in header/notifications |
| Triage queue actions | Done | `GET/POST /orgx/api/live/triage*` for blocked/review items |
| Plugin diagnostics (`doctor`) | Done | CLI + `GET /orgx/api/health` |
| Full-auto codex dispatch | Done | `npm run job:dispatch` with retries + rollups |

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
export ORGX_API_KEY="<orgx-api-key>"

npm run job:dispatch -- \
  --initiative_id=aa6d16dc-d450-417f-8a17-fd89bd597195 \
  --plan_file=docs/orgx-openclaw-launch-workstreams-plan-2026-02-14.md \
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
- User-scoped API keys should not send `X-Orgx-User-Id`.

Manual dispatch:
- Use `docs/marketing/manual-agent-dispatch-golden-prompt.md` when manually launching a marketing agent for a specific task (non-batched dispatch).

## Version Harness E2E (Real Queue + Play + Auto)

Use this when you need a real end-to-end validation of queue execution in a live plugin session:
- seeds an isolated initiative with workstreams/milestones/tasks across domains
- moves the harness workstream to top of Next Up
- executes one manual `Play`
- executes auto-continue for the remaining slices (default target is 5, auto-raised if needed to cover all seeded domains)
- validates completed slices, run isolation (unique run IDs), skill/domain coverage, progress evidence, task/artifact updates, and exact output file contents
- tears down seeded entities and restores queue order
- writes a JSON report to `artifacts/harness-runs/`

Safety gate (required):

```bash
export ORGX_E2E_ALLOW_WRITE=1
```

Run:

```bash
npm run verify:version-harness
```

Useful options:
- `ORGX_HARNESS_BASE_URL` (default `http://127.0.0.1:18789`)
- `ORGX_HARNESS_TARGET_COMPLETED_SLICES` (default `5`)
- `ORGX_HARNESS_REQUEST_TIMEOUT_MS` (default `30000`; per-request API timeout)
- `ORGX_HARNESS_DOMAINS` (default `engineering,product,design,marketing,operations,sales`)
- `ORGX_HARNESS_REQUIRE_REAL_WORKER=1` (default true; fails if worker is `mock`)
- `ORGX_HARNESS_KEEP=1` (skip teardown)
- `ORGX_HARNESS_SEED_ONLY=1` (seed + queue-top only)

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
| `GET /orgx/api/status` | Health/status probe summary |
| `GET /orgx/api/health` | Plugin diagnostics + outbox/sync health |
| `GET /orgx/api/onboarding` | Legacy onboarding state |
| `POST /orgx/api/onboarding/start` | Start browser pairing flow |
| `GET /orgx/api/onboarding/status` | Poll pairing status / auto-connect |
| `POST /orgx/api/onboarding/manual-key` | Manual key validation and persist |
| `POST /orgx/api/onboarding/disconnect` | Clear local plugin credential |
| `GET /orgx/api/live/snapshot-v2` | Canonical live snapshot for dashboard state |
| `GET /orgx/api/live/stream` | Live SSE stream |
| `GET /orgx/api/live/triage` | Blocked/review queue items |
| `POST /orgx/api/live/triage/action` | Resolve triage items (approve/reject/stop) |
| `POST /orgx/api/live/decisions/approve` | Approve/reject decisions |
| `GET /orgx/api/mission-control/graph` | Mission Control hierarchy graph |
| `GET /orgx/api/mission-control/next-up` | Next Up queue |
| `GET /orgx/api/mission-control/slices` | Slice list for mission control |
| `GET /orgx/api/mission-control/auto-continue/status` | Auto-continue runtime status |
| `POST /orgx/mcp` | Local MCP bridge (tools/list, tools/call) |

Legacy compatibility endpoints such as `/orgx/api/agents`, `/orgx/api/activity`, and `/orgx/api/initiatives` return `410` with replacement routes.

## Contributing

### Prerequisites

- Node.js 18+
- npm 9+
- An OrgX account (free tier works for development)

### Dev Setup

```bash
git clone https://github.com/useorgx/openclaw-plugin.git
cd openclaw-plugin

# Install root dependencies (plugin core)
npm install

# Install dashboard dependencies
cd dashboard && npm install && cd ..

# Build everything
npm run build

# Run tests
npm run test:hooks
```

### Development Workflow

```bash
# Type-check (must pass before any commit)
npm run typecheck

# Run tests (must pass before any commit)
npm run test:hooks

# Build core only (TypeScript -> dist/)
npm run build:core

# Build dashboard only (Vite)
npm run build:dashboard

# Dashboard dev server (hot reload at localhost:5173)
cd dashboard && npm run dev

# Full build (core + dashboard)
npm run build

# Dev mode from main: always fetch/update origin/main, build it, and copy dist outputs here
npm run dev:main
```

### Repository Structure

```
src/                              # Plugin core (TypeScript, ES modules)
  index.ts                        # Plugin bootstrap + tool registration
  http/
    index.ts                      # HTTP surface composition under /orgx/api/*
    router.ts                     # Lightweight dependency-free router
    routes/                       # Route modules (mission control, snapshot, onboarding, etc.)
    helpers/                      # Shared mission-control/autopilot/runtime helpers
  tools/core-tools.ts             # MCP tool registrations (30 tools)
  mcp-http-handler.ts             # Local MCP bridge at /orgx/mcp
  mcp-client-setup.ts             # Auto-config for Claude/Codex/Cursor
  outbox.ts                       # Offline queue + replay
  snapshot-store.ts               # Cached snapshot fallback
  activity-store.ts               # Activity persistence
  next-up-queue-store.ts          # Queue ordering + pin state
  runtime-instance-store.ts       # Runtime process tracking
  skill-pack-state.ts             # Skill pack/policy state

dashboard/                        # React SPA (served at /orgx/live)
  src/
    App.tsx                       # Root shell and view routing
    components/
      mission-control/            # Queue + hierarchy + slice views
      activity/                   # Activity feed and detail
      sessions/                   # Session inspector + agent context
      decisions/                  # Decision and triage actions
      onboarding/                 # Browser pairing gate
      settings/                   # Connection, BYOK, agent suite panels
    hooks/
      useLiveData.ts              # SSE-first data transport + polling fallback
      useMissionControlGraph.ts   # Hierarchy graph state
      useNextUpQueue.ts           # Queue operations and optimistic updates
    lib/tokens.ts                 # Design tokens (shared UI language)

scripts/                          # Orchestration and QA (not shipped in package)
  run-codex-dispatch-job.mjs      # Full-auto agent dispatch
  capture-qa-evidence.mjs         # Playwright QA screenshots
  ship.mjs                        # Commit, PR, auto-merge

skills/                           # Agent skill packs (9 domains)
tests/                            # Node test suites
docs/                             # ADRs, ops guides, launch plans
```

### Architecture Notes

- The HTTP surface is route-modularized under `src/http/routes/*` with a lightweight in-repo router (`src/http/router.ts`).
- Live transport is SSE-first (`/orgx/api/live/stream`) with resilient polling fallback (`/orgx/api/live/snapshot-v2`).
- The plugin still keeps zero production dependencies and uses file-backed local state for portability in OpenClaw environments.
- Mission Control queue/run state is split intentionally: `Next Up` models intent and scheduling, while runtime projections drive `In Progress`.
- Local MCP bridge + client auto-configuration is now a first-class flow for Claude/Codex/Cursor (`orgx-openclaw` server entry).

### Known Architecture Debt

Resolved in the recent 0.7.x cycle:
- Route decomposition is complete (moved from monolithic handler flow to `src/http/routes/*`).
- Live transport is now SSE-first with explicit snapshot fallback, instead of polling-only assumptions.
- Dashboard/server contract drift around core live entities (`LiveDecision`, `LiveActivityItem`, `SessionTree*`) is reduced via shared imports from `src/contracts/shared-types.ts`.

Next highest-priority debt (in order):
1. `dashboard/src/components/activity/ActivityTimeline.tsx` is still oversized (6k+ lines) and should be split into feature modules (timeline list, detail orchestration, artifact preview, triage actions).
2. `src/http/index.ts` and `src/index.ts` remain large composition roots and should be further sliced into bootstrap modules (routing assembly, background services, tool registration, and compatibility shims).
3. Route response shapes are still assembled manually in multiple places; add a single contract-normalization layer for live snapshot/mission-control/triage payloads.
4. Local store behavior is standardized, but domain stores still duplicate reconciliation logic; centralize replay/merge semantics for outbox, activity, and runtime projections.
5. Add deeper integration tests around SSE reconnect + snapshot fallback and workspace-scoped mission-control queues to prevent regressions in queue/run separation.

### Design Decisions (Why Things Are This Way)

Not all of the above is accidental. Some context for why the architecture looks the way it does:

- **Zero production dependencies**: The plugin ships with no npm runtime deps. This means no Express, no Fastify, no routing library. The HTTP handler is hand-rolled because adding a router would be the first external dependency. The tradeoff is clear: easy distribution vs. maintainability.

- **File-based state over SQLite**: The plugin runs inside OpenClaw's process. Using SQLite would add a native dependency (build complexity, platform issues). JSON files are portable and inspectable with `cat`. The tradeoff: no queries, no transactions, more code for corruption recovery.

- **Monolithic bootstrap**: `index.ts` does everything at startup because OpenClaw plugins have a single entry point. There's no lifecycle hook for "register tools in phase 1, start services in phase 2." Everything happens in `register()`.

### What Makes a Good Contribution

- **Keep route contracts explicit** — update route modules and their tests together (especially mission-control and snapshot responses).
- **Improve queue/run UX clarity** — preserve the `Next Up` vs `In Progress` separation and keep triage/activity states actionable.
- **Strengthen shared contracts** — when changing response shapes, update both server and dashboard type usage in the same PR.
- **Dashboard polish with restraint** — follow `dashboard/src/lib/tokens.ts` and existing interaction patterns.

### Code Conventions

- **TypeScript strict mode** — no `any`, no implicit returns, no unused variables
- **ES modules only** — all imports use `import`, no `require()`
- **Zero production dependencies** — if you need a library, implement the subset you need
- **Node test runner** — tests use `node --test`, not Jest. Test files end in `.test.mjs`
- **Dashboard design tokens** — use values from `dashboard/src/lib/tokens.ts`, not raw hex colors
- **Read AGENTS.md** — it has guardrails for AI agents working on this repo, but the conventions apply to humans too

## Requirements

- OpenClaw 2026.1.0 or later
- Node.js 18+
- OrgX account (browser pairing recommended, API key fallback supported)

## Maintainers: Release to NPM

This repo publishes on GitHub Release via `.github/workflows/publish.yml`.
The npm package must have trusted publishing configured for this repository and workflow so the Node 24 release job can publish through GitHub OIDC without `NPM_TOKEN`.

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
   - Create a GitHub release for the tag (the workflow publishes through npm trusted publishing)
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
