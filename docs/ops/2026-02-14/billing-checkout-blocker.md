# Billing Checkout Blocker (Verified)

Date: 2026-02-13

## Summary

Using a valid user-scoped OrgX API key (`oxk_...`, sourced from the persisted plugin auth store),
`POST /api/client/billing/checkout` is returning `500 Internal Server Error` with an empty body.

`POST /api/client/billing/portal` is working and returns a Stripe billing portal session URL.

This blocks launch verification scenarios that require generating a Stripe checkout URL and completing payment.

## Evidence

- Full logs: `docs/ops/2026-02-14/billing-verify.log`

## Repro (API key required)

1. Ensure `ORGX_API_KEY` is set to a user-scoped key (`oxk_...`).
2. Run:

```bash
npm run verify:billing -- --plan=starter --billing-cycle=monthly
```

Expected:
- status prints
- checkout URL prints (Stripe checkout)
- portal URL prints

Actual:
- status prints
- checkout fails with `500 Internal Server Error`
- portal URL prints

## Additional Notes

- Using `https://useorgx.com` redirects (`307`) to `https://www.useorgx.com` for the checkout endpoint.
- The request body shape `{ planId, billingCycle }` appears to be accepted (other shapes return `400 Invalid request body`),
  but still triggers a `500`.

