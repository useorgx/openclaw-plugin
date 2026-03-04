# QA Output Convention

All QA evidence should be written under:

`docs/qa/<YYYY-MM-DD>/<suite>/<run-id>/`

Examples:
- `docs/qa/2026-03-04/live-ui-p0-audit/2026-03-04T12-30-39-127Z/`
- `docs/qa/2026-03-04/live-autopilot-audit/2026-03-04T12-30-39-238Z/`
- `docs/qa/2026-03-04/visual-verify/2026-03-04T12-30-39-127Z/`

Notes:
- `scripts/capture-qa-evidence.mjs` intentionally writes to `docs/qa/<date>/activity-view` and `docs/qa/<date>/mission-control`.
- Component QA runs are generated at `docs/qa/components/runs/<run-id>/` but are git-ignored by default because they are large and ephemeral.
- Promote only curated evidence into a date-scoped suite folder when it is needed for release notes or review.
- Avoid root-level screenshots/videos; `npm run verify:repo-hygiene` enforces this.
