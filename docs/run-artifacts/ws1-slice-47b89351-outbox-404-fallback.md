## WS1 Slice 47b89351: Outbox replay 404 fallback hardening

### Scope
- Workstream: `ws-1`
- Slice run: `47b89351-296c-4033-a945-97b4b7b69515`
- Focus: ensure progress replay fallback triggers for HTTP-prefixed 404 run-not-found errors.

### Code change
- Updated `src/sync/outbox-replay.ts` to broaden the 404 matcher from start-of-string only (`/^404\b/`) to token-aware matching (`/(?:^|\b)404\b/`).
- This allows fallback to correlation-based reporting when upstream errors include a transport prefix like `"HTTP 404 Not Found: run not found"`.

### Test coverage
- Added case in `tests/outbox-replay-progress-runid.test.mjs`:
  - `"progress replay fallback also handles HTTP-prefixed 404 run-not-found errors"`
- The new test verifies:
  - first send uses `run_id`
  - retry strips `run_id`
  - retry uses deterministic `correlation_id`

### Verification
1. `npm run build:core`
2. `npm run test:file -- tests/outbox-replay-progress-runid.test.mjs`
3. Expected: 3 passing tests, 0 failures.
