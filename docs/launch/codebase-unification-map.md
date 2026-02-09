# Plugin/Core Unification Map

## Goal
Consolidate shared client, types, and HTTP surface so the OpenClaw plugin and
OrgX core use one canonical contract and one request implementation.

## Current Duplicates
- **Client implementation**
  - Plugin (public entrypoint): `/Users/hopeatina/Code/orgx-openclaw-plugin/src/api.ts`
  - Plugin (canonical implementation): `/Users/hopeatina/Code/orgx-openclaw-plugin/src/contracts/client.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/app/api/client/*` (server endpoints) +
    `/Users/hopeatina/Code/orgx/orgx/lib/client-integration/*` (server helpers)

- **Type contracts**
  - Plugin (public entrypoint): `/Users/hopeatina/Code/orgx-openclaw-plugin/src/types.ts`
  - Plugin (canonical definitions): `/Users/hopeatina/Code/orgx-openclaw-plugin/src/contracts/types.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/types/*` +
    `/Users/hopeatina/Code/orgx/orgx/lib/server/clientLive.ts` (response shaping)

- **HTTP routing / adapter layer**
  - Plugin: `/Users/hopeatina/Code/orgx-openclaw-plugin/src/http-handler.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/app/api/client/*`

## Proposed Shared Packages
1. Shared contracts (pragmatic now)
   - Canonical client+types exported from the already-published plugin package:
   - `@useorgx/openclaw-plugin/api` (client)
   - `@useorgx/openclaw-plugin/types` (contracts)
   - This removes drift immediately without waiting on a new npm scope.

2. Future package split (optional)
   - If we still want a separate scope, split later into:
   - `@orgx/client` and `@orgx/contracts` (types-only)
   - But only once we have a canonical, accessible repo to publish from.

3. `@orgx/http-adapters` (future)
   - Shared request validation helpers and error normalization used by
     plugin HTTP handler and core API handlers.

## Migration Steps (Incremental)
1. Keep plugin contracts in `src/contracts/*`, preserve stable public entrypoints
   (`src/api.ts`, `src/types.ts`) for consumers.
2. Migrate the core package(s) to import from `@useorgx/openclaw-plugin/{api,types}`
   instead of maintaining forked client/types implementations.
3. Validate end-to-end: compile + run the plugin surfaces after migration.

## Open Decisions
- Where to host shared packages (OrgX monorepo `packages/` vs separate repo)?
- Publishing strategy (npm vs workspace linking).
- Versioning cadence (sync with plugin releases or core releases).

## Current Status
Contracts moved under `src/contracts/*` and stable entrypoints preserved.
Core migration to shared imports is next.
