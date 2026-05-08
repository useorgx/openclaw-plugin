# Org Memory & Context Survival Discovery (G3.1 / G3.2)

Date: 2026-02-25
Initiative: `aa6d16dc-d450-417f-8a17-fd89bd597195`
Workstream: `17181dc5-6d05-4552-85a8-cb60d00f6a82`
Slice run: `dc63b974-16cd-4c42-8c1b-3793b80ca7ab`

## Scope

Discovery-only slice to verify whether Org Memory returns real data today and whether cross-session context state survives restarts.

## What exists now

1. `orgx_sync` tool sends optional `memory`, `dailyLog`, and `agents`, then returns raw sync response from `/api/client/sync`.
2. Background `doSync()` path in plugin bootstrap periodically calls `client.getOrgSnapshot()` and separately calls `client.syncMemory({ agents })`.
3. Live dashboard snapshot (`/orgx/api/live/snapshot`) merges upstream sessions/activity/decisions/agents with local fallback data and outbox-buffered activity.
4. Local stores exist for `snapshot.json`, `activity-store.json`, `team-context.json`, agent/run context, runtime instances, and chat threads.

## Verified gaps

### G3.1 (Org Memory Returns Real Data)

1. There is no dedicated MCP tool for querying org memory/history (for example `orgx_search`) in current tool registration; memory visibility is indirect through `orgx_sync` and live snapshot endpoints.
2. `orgx_sync` currently acts as a thin pass-through and does not enrich or expose a normalized memory-focused view for operators.
3. The background sync loop only sends local `agents` telemetry in `syncMemory` calls, so text memory/daily logs are not auto-refreshed unless explicitly pushed by a caller.

### G3.2 (Cross-Session Context Survival)

1. `SyncPayload`/`SyncResponse` include `workspaceState` and `memoryCursor`, but plugin runtime does not persist these sync cursors locally for next boot.
2. Persisted snapshot currently stores only `OrgSnapshot` summary fields (initiatives/agents/tasks/decisions/syncedAt), not sync cursor continuity data.
3. Result: after restart, continuity relies on server-side state and ad-hoc local stores, but there is no explicit local handoff cursor lifecycle.

## Evidence map

- `src/tools/core-tools.ts` (`orgx_sync` registration and execute path)
- `src/index.ts` (`doSync()` calling `client.getOrgSnapshot()` and `client.syncMemory({ agents: localAgents })`)
- `src/contracts/types.ts` (`SyncPayload.workspaceState`, `SyncPayload.memoryCursor`, `SyncResponse.workspaceState`, `SyncResponse.memoryCursor`)
- `src/snapshot-store.ts` (persisted shape contains only `snapshot` + `updatedAt`)
- `src/http/routes/live-snapshot.ts` (real-data merge path + outbox/local fallbacks)

## Minimal implementation plan

1. Add a small persisted sync-state store (`sync-state.json`) for `memoryCursor` + `workspaceState` with bounded schema and corrupt-file recovery.
2. Extend `doSync()` to send last persisted cursor/state in `client.syncMemory(...)` and persist returned cursor/state after successful sync.
3. Add a read-only MCP tool `orgx_query_org_memory` (or equivalent) that returns normalized recent memory context from the sync/state layer.
4. Add targeted tests for:
   - sync-state persistence round-trip
   - startup hydration of cursor/state
   - `doSync()` payload includes prior cursor/state
   - response writes updated cursor/state

## Proposed verification steps for follow-up slice

1. Unit test: seed sync-state file, run hydrate path, assert outgoing `syncMemory` payload includes seeded cursor.
2. Unit test: mock `/api/client/sync` with returned `memoryCursor`/`workspaceState`, assert persisted file updates.
3. Manual: restart plugin and confirm `sync-state.json` survives and is reused.
4. Manual: call memory query tool and verify non-empty structured payload when server returns memory data.
