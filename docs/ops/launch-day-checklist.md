# Launch Day Checklist (G4)

Date window: **Feb 14, 2026** (local time)

This checklist exists to make the remaining ops tasks verifiable with clean evidence.
Store evidence under `docs/ops/2026-02-14/`.

## Preflight (before Feb 14)

1. **Build + unit checks**
   - `npm run typecheck`
   - `npm run test:hooks`

2. **Clean install verification (pack + install + import)**
   - `npm run verify:clean-install`
   - Save terminal output to `docs/ops/2026-02-14/clean-install.log`.

3. **Billing verification (test mode)**
   - `ORGX_API_KEY=oxk_... npm run verify:billing -- --plan=starter --billing-cycle=monthly`
   - Save terminal output to `docs/ops/2026-02-14/billing-verify.log`.

4. **Dashboard QA evidence (desktop + mobile)**
   - `npm run qa:capture -- --date 2026-02-14`
   - Confirm `docs/qa/2026-02-14/*/index.html` exists.

## Launch Day Execution (Feb 14)

### 1) Final QA Checklist

Goal: One last pass over the full funnel and failure states.

Capture:
- `docs/ops/2026-02-14/final-qa-notes.md`

Suggested coverage:
- Auth: clean state -> connect -> reconnect -> disconnect.
- Onboarding: pairing flow + manual key fallback.
- Dashboard: Activity view + Mission Control, modals, filtering, narrow widths.
- SSE: stream connects + reconnects.
- Billing/paywall: free vs paid behavior, upgrade CTA.

### 2) First Visit -> Paid Conversion (No Manual DB Intervention)

Goal: Validate the full funnel from a fresh browser to a paid user without any manual database edits.

Capture:
- `docs/ops/2026-02-14/paid-conversion.log`
- Screenshot(s) of checkout success and resulting premium gate pass.

Checklist:
- Start from a clean state.
- Reach paywall from a premium-gated action.
- Complete checkout.
- Confirm entitlement is reflected in UI.

### 3) Rollback Drill (Billing/Auth Outage)

Goal: Practice the procedure with a simulated outage and document what would be rolled back and how.

Capture:
- `docs/ops/2026-02-14/rollback-drill.md`

Minimum content:
- Trigger condition (what “outage” looked like)
- Immediate mitigations
- Rollback decision rule
- Exact rollback steps
- Validation steps post-rollback

### 4) Monitor Sign-ups + Payments

Goal: Hourly snapshots during launch window.

Capture:
- `docs/ops/2026-02-14/metrics-snapshots.md`

Include at least:
- signups count delta
- checkout attempts count
- paid conversions count
- error counts (auth, billing, runtime)

### 5) Publish Launch Announcement

Goal: Publish the announcement and preserve a durable reference.

Capture:
- `docs/ops/2026-02-14/announcement-links.md`

Include:
- link(s) to the announcement post(s)
- UTM destinations used

### 6) Community Engagement

Goal: Respond and engage during launch window.

Capture:
- `docs/ops/2026-02-14/community-engagement.md`

Include:
- which channels were monitored
- key threads + responses
- notable feedback

### 7) Post-launch Metrics Review

Goal: End-of-day summary.

Capture:
- `docs/ops/2026-02-14/post-launch-report.md`

Include:
- what worked
- what didn’t
- top funnel numbers
- follow-ups
