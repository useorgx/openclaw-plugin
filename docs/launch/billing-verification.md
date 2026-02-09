# Billing Verification (Stripe)

This launch initiative tracks Stripe billing verification scenarios for the OrgX API-key client surfaces used by the OpenClaw plugin.

## Prereqs

- A user-scoped OrgX API key: `oxk_...`
- OrgX base URL (defaults to `https://www.useorgx.com`)
- Stripe is configured on the OrgX server side (checkout + portal endpoints enabled)

## Quick Checks (Status + URLs)

```bash
export ORGX_API_KEY=oxk_...

npm run verify:billing
```

This prints:
- current billing status (`plan`, `hasSubscription`, `subscriptionStatus`)
- checkout URL (for the requested plan)
- portal URL

## Scenario 06 (Checkout Updates Entitlement Within SLA)

1. Generate a checkout URL:

```bash
export ORGX_API_KEY=oxk_...

npm run verify:billing -- --plan=starter --billing-cycle=monthly --wait-for-plan=starter --timeout-ms=60000
```

2. Open the printed checkout URL and complete the purchase (Stripe test mode is fine).
3. The script polls `/api/client/billing/status` until `plan=starter` (or times out).

Adjust the SLA window via `--timeout-ms`.

## Scenario 07 (Cancellation/Update Downgrades Entitlements)

1. Cancel (or downgrade) via the billing portal URL:

```bash
export ORGX_API_KEY=oxk_...

npm run verify:billing -- --skip-checkout --wait-for-plan=free --timeout-ms=60000
```

2. The script polls billing status until `plan=free`.

Note: depending on Stripe settings, cancellations may take effect at period end. In that case,
this scenario should assert `hasSubscription=false` or `subscription_status=canceled` instead of immediate `plan=free`.

