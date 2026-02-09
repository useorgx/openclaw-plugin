# Unification Evidence (2026-02-09)

This document is evidence for the "Plugin + Core Codebase Unification" workstream tasks.

## Plugin repo (useorgx/openclaw-plugin)

### Contracts refactor

- Contracts moved under `src/contracts/*`.
- Stable public entrypoints preserved:
  - `src/api.ts` (exports from `src/contracts/client.ts`)
  - `src/types.ts` (exports from `src/contracts/types.ts`)

Evidence:
- Merge commit: `164cdb1` (contracts refactor + `rawRequest` helper)

### Validation

- `npm run typecheck`
- `npm run test:hooks` (16 tests pass)

Preflight log:
- `docs/ops/2026-02-09/launch-checklist.log`

## Core repo (hopeatina/orgx)

### @orgx/core package migration

Goal: stop maintaining a forked OrgXClient + contracts in `packages/orgx`, and instead consume the canonical client/types from the plugin package.

Changes:
- `packages/orgx/src/types.ts` now re-exports from `@useorgx/openclaw-plugin/types`.
- `packages/orgx/src/api.ts` now wraps `@useorgx/openclaw-plugin/api` to normalize baseUrl.

Evidence:
- Branch: `codex/unification-contracts`
- Commit: `b021473a`

Validation (ran locally):
- `npm --prefix packages/orgx run typecheck`
- `npm --prefix packages/orgx run build`
