#!/usr/bin/env node

import process from "node:process";

const DEFAULT_BASE_URL = "https://www.useorgx.com";

function usage() {
  return [
    "Usage: node scripts/verify-billing-scenarios.mjs [options]",
    "",
    "Required (env):",
    "  ORGX_API_KEY=oxk_...        User-scoped OrgX API key",
    "",
    "Options:",
    "  --base-url=<url>            OrgX API base (default: https://www.useorgx.com)",
    "  --plan=<starter|team|enterprise>  Plan to request checkout (default: starter)",
    "  --billing-cycle=<monthly|annual>  Billing cycle (default: monthly)",
    "  --expect-plan=<plan>        Fail if billing status plan differs",
    "  --assert-paid               Fail if plan=free or hasSubscription=false",
    "  --skip-checkout             Skip checkout URL request",
    "  --skip-portal               Skip portal URL request",
    "  -h, --help                  Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    plan: "starter",
    billingCycle: "monthly",
    expectPlan: null,
    assertPaid: false,
    skipCheckout: false,
    skipPortal: false,
    help: false,
  };

  for (const raw of argv) {
    if (raw === "-h" || raw === "--help") {
      args.help = true;
      continue;
    }
    if (raw === "--assert-paid") {
      args.assertPaid = true;
      continue;
    }
    if (raw === "--skip-checkout") {
      args.skipCheckout = true;
      continue;
    }
    if (raw === "--skip-portal") {
      args.skipPortal = true;
      continue;
    }
    const [key, value] = raw.split("=");
    if (!value) continue;
    switch (key) {
      case "--base-url":
        args.baseUrl = value;
        break;
      case "--plan":
        args.plan = value;
        break;
      case "--billing-cycle":
        args.billingCycle = value;
        break;
      case "--expect-plan":
        args.expectPlan = value;
        break;
      default:
        break;
    }
  }

  return args;
}

async function loadOrgXClient() {
  try {
    const mod = await import(new URL("../dist/api.js", import.meta.url).href);
    if (!mod?.OrgXClient) {
      throw new Error("dist/api.js does not export OrgXClient");
    }
    return mod.OrgXClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load OrgXClient. Run \"npm run build:core\" first. (${message})`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const apiKey = process.env.ORGX_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("[billing] Missing ORGX_API_KEY (user-scoped oxk_...)");
    console.error(usage());
    process.exit(1);
  }
  if (!apiKey.startsWith("oxk_")) {
    console.warn(
      "[billing] Warning: ORGX_API_KEY does not look user-scoped (oxk_...)."
    );
  }

  const OrgXClient = await loadOrgXClient();
  const client = new OrgXClient(apiKey, args.baseUrl, "");

  console.log(`[billing] baseUrl=${client.getBaseUrl()}`);

  const status = await client.getBillingStatus();
  console.log(
    `[billing] status plan=${status.plan} hasSubscription=${status.hasSubscription} subscriptionStatus=${status.subscriptionStatus ?? "null"}`
  );

  if (args.expectPlan && status.plan !== args.expectPlan) {
    throw new Error(
      `Expected plan ${args.expectPlan}, got ${status.plan}.`
    );
  }

  if (args.assertPaid) {
    if (status.plan === "free" || !status.hasSubscription) {
      throw new Error(
        `Expected paid plan, got plan=${status.plan} hasSubscription=${status.hasSubscription}.`
      );
    }
  }

  if (!args.skipCheckout) {
    const checkout = await client.createBillingCheckout({
      planId:
        args.plan === "team" || args.plan === "enterprise"
          ? args.plan
          : "starter",
      billingCycle: args.billingCycle === "annual" ? "annual" : "monthly",
    });
    const checkoutUrl = checkout?.url ?? checkout?.checkout_url ?? null;
    console.log(`[billing] checkout url=${checkoutUrl ?? "null"}`);
    if (checkoutUrl && checkoutUrl.includes("checkout=mock")) {
      console.log(
        "[billing] Stripe not configured in this environment (mock checkout returned)."
      );
    }
  }

  if (!args.skipPortal) {
    const portal = await client.createBillingPortal();
    const portalUrl = portal?.url ?? portal?.checkout_url ?? null;
    console.log(`[billing] portal url=${portalUrl ?? "null"}`);
  }

  console.log("[billing] verification script completed");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[billing] failed: ${message}`);
  process.exit(1);
});
