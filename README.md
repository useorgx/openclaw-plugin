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
                              Bearer token (oxk_...)
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
│  │  │  /orgx/api/*         → 33+ REST endpoints                     │ │    │
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
                              Polling (every 8s)
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
  → Dashboard polls /orgx/api/live/sessions every 8s
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

### MCP Tools

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

### Live Dashboard

Access the OrgX command center at `http://127.0.0.1:18789/orgx/live` (or your gateway URL).
The Vite dev server (`http://localhost:5173`) is only for local preview; the installed plugin runs on the OpenClaw port (18789).

Shows:
- Active initiatives with progress
- Agent status and current tasks
- Pending decisions requiring approval
- Activity stream
- Outbox replay visibility for buffered offline events

### Auto-Continue (Scaffold to Agent Execution)

If you scaffold an initiative from chat (for example, "plan X" and then create/scaffold), OrgX can automatically start executing the first workstream via the stream auto-continue pipeline.

Troubleshooting:
- If agents do not start automatically, say: `start agents` to re-trigger dispatch.
- Open the live link (Mission Control) to see stream status (`ready`, `active`, `blocked`) and any upgrade/approval decisions.

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
| Live sessions + activity + handoffs | Done | SSE with local fallback paths |
| Mission Control hierarchy view | Done | Initiative -> workstream -> milestone -> task |
| Run control shortcuts | Done | Pause/resume/cancel/checkpoint/rollback in Session Detail |
| Outbox buffering + replay | Done | Local queue + auto replay on sync |
| Outbox observability in dashboard | Done | Pending/replay indicators in header/notifications |
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
export ORGX_API_KEY=oxk_...

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
```

### Repository Structure

```
src/                              # Plugin core (TypeScript, ES modules)
  index.ts                        # Entry point: config resolution, tool registration,
                                  #   background sync, CLI commands (4.4k lines)
  http-handler.ts                 # HTTP API: 33+ routes, dashboard serving,
                                  #   MCP bridge, SSE streaming (12.3k lines)
  contracts/
    client.ts                     # OrgXClient — all cloud API calls
    types.ts                      # Shared type contracts
  auth-store.ts                   # Credential persistence (~/.orgx/plugin/auth.json)
  snapshot-store.ts               # Cached org snapshot for offline fallback
  outbox.ts                       # Offline event queue + auto-replay
  activity-store.ts               # Paginated activity timeline persistence
  agent-suite.ts                  # Agent provisioning (profiles, skills, managed files)
  agent-run-store.ts              # Spawned agent run records
  agent-context-store.ts          # Launch context for agent runs
  mcp-http-handler.ts             # Local MCP bridge at /orgx/mcp
  mcp-client-setup.ts             # Auto-config for Claude/Codex/Cursor
  gateway-watchdog.ts             # Local gateway health monitor
  local-openclaw.ts               # Fallback: read OpenClaw local state when cloud down
  byok-store.ts                   # Provider key management (OpenAI, Anthropic, etc.)
  runtime-instance-store.ts       # Runtime process tracking
  next-up-queue-store.ts          # Task ordering for auto-dispatch
  worker-supervisor.ts            # Detect failed agent handshakes
  skill-pack-state.ts             # Skill pack download/install tracking
  fs-utils.ts                     # Atomic file writes, corruption recovery
  paths.ts                        # Config directory paths (~/.orgx/plugin/)

dashboard/                        # React SPA (served at /orgx/live)
  src/
    App.tsx                       # Root component, view routing (2.3k lines)
    components/
      activity/                   # ActivityTimeline (live feed, 4.3k lines)
      mission-control/            # Hierarchy view: initiative -> workstream -> task
      sessions/                   # Session inspector, agent chats
      decisions/                  # Decision queue (approve/reject with notes)
      initiatives/                # Initiative detail + list
      artifacts/                  # Artifact viewer modal
      agents/                     # Agent panel, status indicators
      handoffs/                   # Handoff list
      onboarding/                 # Browser pairing gate
      settings/                   # Connection, BYOK, agent suite panels
      shared/                     # Modal, Badge, EntityIcon, MarkdownText
    hooks/                        # 17 custom hooks
      useLiveData.ts              # Core data hook (polling, state merge)
      useConnection.ts            # Connection status
      useOnboarding.ts            # Pairing flow
      useMissionControlGraph.ts   # Hierarchy visualization
      useEntityMutations.ts       # Entity CRUD operations
    lib/
      tokens.ts                   # Design tokens (lime, teal, background, etc.)

scripts/                          # Orchestration and QA (not shipped in package)
  run-codex-dispatch-job.mjs      # Full-auto agent dispatch
  capture-qa-evidence.mjs         # Playwright QA screenshots
  ship.mjs                        # Commit, PR, auto-merge

skills/                           # Agent skill packs (9 domains)
tests/                            # 26 test suites (Node test runner)
docs/                             # ADRs, ops guides, launch plans
```

### Known Architecture Debt

This is an honest accounting of where the codebase is messy. If you're looking for high-impact contributions, these are the places that need the most love.

**1. God files**

Three files account for most of the complexity:

| File | Lines | Problem |
|------|------:|---------|
| `src/http-handler.ts` | 12,253 | 33 routes in one `if/else` chain inside a single 8,700-line closure. No router, no middleware, no controller separation. Business logic (auto-continue orchestration, LLM headline summarization, spawn guard enforcement) lives inline with route dispatch. |
| `src/index.ts` | 4,355 | Plugin bootstrap, tool registration, config resolution, sync logic, and CLI commands all in one file. |
| `dashboard/src/components/activity/ActivityTimeline.tsx` | 4,326 | Rendering, data transformation, outcome classification, and interaction logic in one component. |

The HTTP handler is the worst offender. Every new endpoint means modifying a 12k-line file. A 25-line negated boolean guard (listing every known route) must be manually updated each time a route is added.

**Ideal decomposition for `http-handler.ts`:**
- `routes/onboarding.ts` — pairing, manual key, disconnect
- `routes/live.ts` — sessions, activity, SSE streaming
- `routes/entities.ts` — CRUD, comments, artifacts
- `routes/mission-control.ts` — graph, next-up, auto-continue
- `routes/decisions.ts` — approval queue, mutations
- `routes/agents.ts` — launch, stop, suite provisioning
- `routes/dashboard.ts` — SPA serving, asset caching
- A thin router with route registration instead of the `if/else` cascade.

**2. State store sprawl**

Eight separate file-based stores under `~/.orgx/plugin/`:

```
auth-store.ts           → auth.json
snapshot-store.ts        → snapshot.json
activity-store.ts        → activity pages
outbox.ts               → outbox/<session>.json
agent-run-store.ts      → agent run records
agent-context-store.ts  → launch context
next-up-queue-store.ts  → task ordering
skill-pack-state.ts     → skill checksums
```

Each has its own read/write/corruption-recovery logic. Some overlap (outbox events become activity items; agent-run and agent-context track the same runs from different angles). A unified local store with a single persistence layer would reduce duplication.

**3. Type duplication**

Two separate `types.ts` files that can desync:
- `src/contracts/types.ts` — cloud API contract types
- `dashboard/src/types.ts` — dashboard-specific types

The `LiveDecision` interface exists in the dashboard types but has no shared definition with the server. The HTTP handler manually shapes responses to match what the dashboard expects, with no compile-time guarantee they agree.

**4. No routing abstraction**

The HTTP handler uses raw `if (method === "POST" && route === "...")` checks. Adding a new route requires:
1. Adding a boolean variable to the route-matching block
2. Adding it to the 25-line negated guard for unknown routes
3. Adding the handler body somewhere in the 8,700-line function
4. Hoping you don't accidentally shadow another route

**5. Dashboard polls by default**

SSE streaming exists (`/orgx/api/live/stream`) but the dashboard defaults to polling every 8 seconds. This works but means decisions and activity can feel delayed. The SSE path exists but isn't the primary code path.

### Design Decisions (Why Things Are This Way)

Not all of the above is accidental. Some context for why the architecture looks the way it does:

- **Zero production dependencies**: The plugin ships with no npm runtime deps. This means no Express, no Fastify, no routing library. The HTTP handler is hand-rolled because adding a router would be the first external dependency. The tradeoff is clear: easy distribution vs. maintainability.

- **File-based state over SQLite**: The plugin runs inside OpenClaw's process. Using SQLite would add a native dependency (build complexity, platform issues). JSON files are portable and inspectable with `cat`. The tradeoff: no queries, no transactions, more code for corruption recovery.

- **Monolithic bootstrap**: `index.ts` does everything at startup because OpenClaw plugins have a single entry point. There's no lifecycle hook for "register tools in phase 1, start services in phase 2." Everything happens in `register()`.

### What Makes a Good Contribution

- **Splitting `http-handler.ts`** into route modules would be the single highest-impact refactor. Even extracting one domain (e.g., onboarding routes) into its own file would be a great start.
- **Dashboard component extraction** — breaking `ActivityTimeline.tsx` into smaller components (OutcomeCard, ActivityItem, FilterBar) would make it approachable.
- **Shared types** — creating a shared `types/` directory that both `src/` and `dashboard/src/` import from would catch desync bugs at compile time.
- **Bug fixes and UX improvements** to the dashboard are always welcome. The design language is in `dashboard/src/lib/tokens.ts`.

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
