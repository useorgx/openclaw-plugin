# WS1 Targeted HTTP Verification — 2026-03-04

## Scope
Validated recent HTTP helper and entity-route behavior changes around:
- pagination forwarding (`offset` handling)
- initiative search + scoped filtering forwarding
- initiative active/paused reconciliation logic
- integer parsing helpers used by those routes

## Command
```bash
npm run test:file -- tests/http/value-utils.test.mjs tests/http/initiative-search-pagination-forwarding.test.mjs
```

## Result
- Status: PASS
- Total tests: 12
- Passed: 12
- Failed: 0
- Duration: ~150ms (node test runtime)

## Evidence Highlights
- `GET /orgx/api/entities` forwards `search`, `ids`, and `offset` correctly.
- `GET /orgx/api/live/initiatives` returns a pagination envelope and forwards `offset`.
- Initiative state reconciliation remains active when scoped workstreams are in progress and pauses when they are idle.
- `parsePositiveInt` preserves `offset=0` semantics while enforcing limit minimums.
