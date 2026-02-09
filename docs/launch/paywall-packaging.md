# BYOK Agent Launch Paywall Packaging

This doc defines how the OpenClaw plugin paywalls BYOK-powered agent execution.

## What Is Paywalled

The plugin enforces a paid OrgX plan before starting any OpenClaw agent run that:
- routes to a BYOK provider (`openai`, `anthropic`, `openrouter`), or
- uses a model that implies BYOK (model string contains `openai`, `anthropic`, or `openrouter`).

Non-BYOK (OrgX-managed) execution remains available on the free plan.

## Minimum Plan

Minimum required plan for BYOK agent launch: `starter`.

Plan ids used by the plugin:
- `starter` (baseline; $98/mo in `orgx/lib/plans.ts`, historically referenced as "$99/mo")
- `team`
- `enterprise`

The plugin routes upgrades to the existing OrgX billing surfaces:
- Checkout: `POST /orgx/api/billing/checkout` (proxy to `/api/client/billing/checkout`)
- Portal: `POST /orgx/api/billing/portal` (proxy to `/api/client/billing/portal`)
- Pricing: `${ORGX_BASE_URL}/pricing`

## UX Contract

When a free-plan user attempts BYOK launch, the plugin returns HTTP `402` with:
- `code=upgrade_required`
- `requiredPlan=starter`
- `actions.checkout`, `actions.portal`, `actions.pricing`

The dashboard uses this payload to render an upgrade CTA and open checkout/portal in a new tab.

