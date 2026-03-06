# Live Dashboard Hardening Phases

This file tracks the lifecycle hardening program derived from the architecture/UX audit.

## Goal

Make `Next Up -> In Progress -> Needs Attention -> Completed` truthful, fast, and semantically consistent across:

- `openclaw-plugin` dashboard
- `orgx/live-dashboard` parity client
- mission-control HTTP contracts

## Phase Status

### Phase 1: Lifecycle Correctness

Status: `done`

Scope:
- unify shell counts with canonical live-data totals
- merge uncovered live sessions into In Progress instead of dropping them
- anchor Start / Auto / Play to returned run/session ids
- remove synthetic queue reconstruction from slices
- fix reconnect/pairing continuity
- fix destructive pause fallback
- correct fallback initiative focus and health math

Verification:
- plugin: `npm run typecheck`
- plugin: `npm run build`
- plugin: targeted HTTP tests for mission-control + autopilot
- orgx: `npm run type-check`
- orgx: `npm run build`
- orgx: targeted route tests for mission-control + pairing

Merged:
- plugin `main` via PR `#245`
- orgx live-dashboard parity via PR `hopeatina/orgx#246`

### Phase 2: Shell Metrics And Surface Truth

Status: `done`

Audit items:
- [x] 14. remove dead Next Up display-state logic
- [x] 15. make “Done today” actually mean today
- [x] 16. keep notification attention count actionable-only
- [x] 17. stop treating missing agent timestamps as “active now”
- [x] 18. scope workspace-options query with OrgX headers and better cache keys
- [x] 19. harden fallback task/blocked math against duplicate task projections

Acceptance criteria:
- no unreachable queue-state branches in `NextUpPanel`
- agent freshness degrades to `unknown/stale`, never `fresh` by default
- workspace selector refetches correctly across auth/embed/scope changes
- fallback mission-control health cannot double-count the same logical task

### Phase 3: Transport And Activity Performance

Status: `done`

Audit items:
- [x] 20. collapse activity detail + headline into one request path
- [x] 21. ensure activity detail/headline requests carry OrgX headers + scope
- [x] 22. stop clustering real lifecycle transitions as noise
- [x] 23. isolate elapsed-time ticking so detail view does not rerender whole timeline
- [x] 24. reduce linear filter cost across large activity feeds
- [x] 25. avoid duplicate initial hydration when SSE already provides a snapshot
- [x] 26. pause polling when tab is hidden/offline or SSE is healthy

Acceptance criteria:
- activity detail opens with one scoped request
- large feeds stay responsive under active filtering
- hidden tabs do not continue burning snapshot traffic

### Phase 4: Shared Models And DRY Cleanup

Status: `done`

Audit items:
- [x] 27. centralize mission-control query invalidation behavior
- [x] 28. consolidate workspace-scope handling per runtime boundary
- [x] 29. consolidate status normalization into one canonical model
- [x] 30. remove duplicated local helpers/constants that drift

Acceptance criteria:
- one invalidation utility per client runtime
- one status taxonomy used by shell, panels, and routes
- no duplicate workspace-scope query/header ad hoc logic in touched surfaces

### Phase 5: Runtime Lifecycle And Verification Hardening

Status: `in_progress`

Audit items:
- [x] 31. move bootstrap timers behind explicit lifecycle start/stop
- [ ] strengthen live UI audit to assert API/UI semantic agreement under non-empty runtime
- [ ] add regression coverage for reconnect continuity, queue fallback, optimistic autopilot, scoped activity detail

Acceptance criteria:
- background loops can be started/stopped deterministically
- the audit fails on semantic drift, not just missing controls

Verified:
- `tests/onboarding-state-merge.test.mjs`
- `tests/http/live-activity-detail-route.test.mjs`
- `tests/http/autopilot-slice-lifecycle.test.mjs`
- `tests/http/mission-control-next-up-actions.test.mjs`
- `npm run typecheck`
- `npm run build`

Remaining blockers:
- canonical `next-up` summary is now recomputed from the full scoped canonical queue instead of the returned page slice, fixing `Next Up` semantic drift in the runtime contract
- shell attention summary now derives blocked pressure from canonical `needsInputTotal`, so the live shell can express `running + blocked + decisions` truthfully
- the remaining open issue is verifier stability: `scripts/agent-browser-live-ui-p0-audit.mjs` still intermittently captures a blank shell from the local live gateway even after readiness waits and one reload retry, so Phase 5 stays open until the semantic audit passes on a stable mounted runtime

## Notes

- Phase order is strict: correctness first, then shell truth, then performance, then DRY cleanup, then lifecycle/test hardening.
- Parity changes in `orgx/live-dashboard` should mirror user-facing lifecycle fixes from the plugin whenever the surface exists in both repos.
