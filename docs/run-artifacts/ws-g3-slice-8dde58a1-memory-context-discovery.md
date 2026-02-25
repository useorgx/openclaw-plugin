# WS3 Slice Discovery: Org Memory & Context Survival

- Slice run: `8dde58a1-0a9f-4443-aadf-59ccff5cb308`
- Initiative: `aa6d16dc-d450-417f-8a17-fd89bd597195`
- Workstream: `17181dc5-6d05-4552-85a8-cb60d00f6a82` (Org Memory & Context Survival)
- Date: `2026-02-24`

## Scope

Read-only implementation discovery for:

- G3.1: Org Memory Returns Real Data
- G3.2: Cross-Session Context Survival

## Findings

1. Memory sync contracts support continuity data, but runtime sync currently sends only agent telemetry.
- `SyncPayload` supports `memory`, `dailyLog`, `workspaceState`, and `memoryCursor` for continuity (`src/contracts/types.ts:298-317`).
- Periodic runtime sync in `doSync` currently calls `client.syncMemory({ agents: localAgents })` and does not include `workspaceState` or `memoryCursor` (`src/index.ts:1188-1195`).
- Impact: continuity fields exist in contract but are not populated by automatic sync path, so cross-session state can be underutilized.

2. No MCP tool exists to query Org Memory directly in current core tool registry.
- Registered tool names include `orgx_status`, `orgx_sync`, entity/changeset/progress tools, but no `orgx_query_org_memory` entry (`src/tools/core-tools.ts:120-2396`, sampled name declarations).
- Impact: operators/agents can push memory via `orgx_sync` but cannot explicitly retrieve/search memory through the plugin tool surface.

3. Context survival for launches is partially implemented through Kickoff Context and local fallbacks.
- Launch/autonomous paths fetch kickoff context and render it into prompts, preserving acceptance criteria/constraints context (`src/http/routes/agent-control.ts:236-252`, `src/http/helpers/auto-continue-engine.ts:2849-2881`).
- Live snapshot route merges remote sessions/activity with local OpenClaw snapshots and outbox-buffered activity, improving survival during degraded connectivity (`src/http/routes/live-snapshot.ts:650-755`).
- Impact: prompt-time context and activity continuity are robust, but memory sync continuity is incomplete (Finding 1).

## Recommended Next Implementation Slice

1. Extend periodic `doSync` memory payload construction to include:
- `workspaceState` (git branch/head/dirty files + handoff state)
- incremental `memoryCursor` persisted locally between syncs

2. Add a dedicated read/query memory MCP tool (for example `orgx_query_org_memory`) backed by an existing OrgX endpoint, with strict schema and structured JSON response.

3. Add targeted tests:
- `doSync` sends continuity payload keys when available.
- new memory query tool registration + response shape contract.

## Verification

Discovery evidence was gathered from source reads and symbol searches:

```bash
rg -n "name:\s*\"orgx_" src/tools/core-tools.ts
nl -ba src/index.ts | sed -n '1170,1215p'
nl -ba src/contracts/types.ts | sed -n '295,360p'
nl -ba src/http/routes/agent-control.ts | sed -n '230,320p'
nl -ba src/http/helpers/auto-continue-engine.ts | sed -n '2838,2905p'
nl -ba src/http/routes/live-snapshot.ts | sed -n '650,760p'
```

