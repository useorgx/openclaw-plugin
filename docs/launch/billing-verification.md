# Billing Verification (OpenClaw Plugin)

This checklist covers launch verification scenarios 06, 07, 08, and 08b for
the OpenClaw plugin billing + paywall integration.

## Prerequisites
- User-scoped OrgX API key (`ORGX_API_KEY=oxk_...`)
- Optional: `ORGX_BASE_URL` (defaults to `https://www.useorgx.com`)
- Build the plugin core once: `npm run build:core`
- Stripe configured in the OrgX environment for full end-to-end verification

Helper script:
```
ORGX_API_KEY=oxk_... npm run verify:billing -- --plan=starter
```

If the checkout URL contains `checkout=mock`, Stripe is not configured in the
current environment. You can still validate endpoint shapes, but entitlement
changes will not occur until Stripe webhooks are wired.

## Scenario 06: Stripe checkout success updates entitlement within SLA
1. Run the helper script to fetch a checkout URL:
   ```
   ORGX_API_KEY=oxk_... npm run verify:billing -- --plan=starter
   ```
2. Open the checkout URL and complete payment.
3. Re-run the helper script with assertions:
   ```
   ORGX_API_KEY=oxk_... npm run verify:billing -- --expect-plan=starter --assert-paid
   ```
4. Confirm `hasSubscription=true` and record the time between checkout and
   the status update to validate the SLA.

## Scenario 07: Stripe cancellation and update events downgrade entitlements
1. Open the billing portal URL from the helper script.
2. Cancel the subscription or downgrade to free.
3. Re-run with assertions:
   ```
   ORGX_API_KEY=oxk_... npm run verify:billing -- --expect-plan=free
   ```
4. Confirm `hasSubscription=false` and `subscriptionStatus=canceled`.

## Scenario 08: Premium gating blocks free and allows paid users
1. Ensure the user is on the free plan.
2. Attempt a BYOK agent launch through OpenClaw:
   - POST `http://127.0.0.1:18789/orgx/api/agents/launch`
   - Include a BYOK provider or model in the payload.
3. Expect a `402 upgrade_required` response with checkout/portal links.
4. Upgrade (Scenario 06) and retry the launch; it should succeed.

## Scenario 08b: Paid BYOK user can launch agents while unpaid user is blocked
1. Use two API keys: one paid, one free.
2. Repeat Scenario 08 with each key and confirm behavior matches the plan.

## Troubleshooting
- If `checkout=mock` is returned, configure Stripe env vars and ensure
  webhooks are reachable.
- If `Unauthorized` is returned, confirm the API key is user-scoped (`oxk_...`)
  and belongs to an active OrgX user.
