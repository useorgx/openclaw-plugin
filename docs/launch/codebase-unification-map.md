# Plugin/Core Unification Map

## Goal
Consolidate shared client, types, and HTTP surface so the OpenClaw plugin and
OrgX core use one canonical contract and one request implementation.

## Current Duplicates
- **Client implementation**
  - Plugin: `/Users/hopeatina/Code/orgx-openclaw-plugin/src/api.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/app/api/client/*` (server endpoints) +
    `/Users/hopeatina/Code/orgx/orgx/lib/client-integration/*` (server helpers)

- **Type contracts**
  - Plugin: `/Users/hopeatina/Code/orgx-openclaw-plugin/src/types.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/types/*` +
    `/Users/hopeatina/Code/orgx/orgx/lib/server/clientLive.ts` (response shaping)

- **HTTP routing / adapter layer**
  - Plugin: `/Users/hopeatina/Code/orgx-openclaw-plugin/src/http-handler.ts`
  - Core: `/Users/hopeatina/Code/orgx/orgx/app/api/client/*`

## Proposed Shared Packages
1. `@orgx/client`
   - `OrgXClient` class, request helpers, billing + live endpoints.
   - Exported from a shared package consumed by plugin + any scripts.

2. `@orgx/contracts`
   - Shared types for live sessions, initiatives, billing, entities.
   - Generated from core types (or hand-maintained) and versioned.

3. `@orgx/http-adapters`
   - Shared request validation helpers and error normalization used by
     plugin HTTP handler and core API handlers.

## Migration Steps (Incremental)
1. Extract shared types from plugin `src/types.ts` into `@orgx/contracts`.
2. Update plugin `src/api.ts` to import from `@orgx/contracts`.
3. Extract `OrgXClient` into `@orgx/client`.
4. Update plugin `src/index.ts` + scripts to import `OrgXClient` from `@orgx/client`.
5. For core, reuse `@orgx/contracts` in `/app/api/client/*` response shaping.

## Open Decisions
- Where to host shared packages (OrgX monorepo `packages/` vs separate repo)?
- Publishing strategy (npm vs workspace linking).
- Versioning cadence (sync with plugin releases or core releases).

## Current Status
Mapping complete; extraction + migration not yet started.
