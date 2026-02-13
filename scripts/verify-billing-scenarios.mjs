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
    "  --wait-for-plan=<plan>      Poll billing status until plan matches (ex: starter, free)",
    "  --timeout-ms=<ms>           Max time to wait when polling (default: 60000)",
    "  --poll-interval-ms=<ms>     Poll interval when waiting for plan (default: 2000)",
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
    waitForPlan: null,
    timeoutMs: 60_000,
    pollIntervalMs: 2_000,
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
      case "--wait-for-plan":
        args.waitForPlan = value;
        break;
      case "--timeout-ms": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) args.timeoutMs = Math.floor(parsed);
        break;
      }
      case "--poll-interval-ms": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) args.pollIntervalMs = Math.floor(parsed);
        break;
      }
      default:
        break;
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  let checkoutError = null;
  let portalError = null;

  if (!args.skipCheckout) {
    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checkoutError = message;
      console.error(`[billing] checkout failed: ${message}`);
    }
  }

  if (!args.skipPortal) {
    try {
      const portal = await client.createBillingPortal();
      const portalUrl = portal?.url ?? portal?.checkout_url ?? null;
      console.log(`[billing] portal url=${portalUrl ?? "null"}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      portalError = message;
      console.error(`[billing] portal failed: ${message}`);
    }
  }

  if (args.waitForPlan) {
    const expected = String(args.waitForPlan).trim().toLowerCase();
    if (!expected) {
      throw new Error("--wait-for-plan value is required.");
    }

    console.log(
      `[billing] waiting for plan=${expected} (timeout=${args.timeoutMs}ms interval=${args.pollIntervalMs}ms)`
    );
    const startedAt = Date.now();
    while (Date.now() - startedAt < args.timeoutMs) {
      const nextStatus = await client.getBillingStatus();
      const okPlan = nextStatus.plan === expected;
      const okSubscription =
        expected === "free" ? true : Boolean(nextStatus.hasSubscription);
      if (okPlan && okSubscription) {
        console.log(
          `[billing] plan reached: plan=${nextStatus.plan} hasSubscription=${nextStatus.hasSubscription} (${Date.now() - startedAt}ms)`
        );
        console.log("[billing] verification script completed");
        return;
      }
      await sleep(args.pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for plan=${expected} after ${args.timeoutMs}ms.`
    );
  }

  if (checkoutError || portalError) {
    const parts = [];
    if (checkoutError) parts.push(`checkout: ${checkoutError}`);
    if (portalError) parts.push(`portal: ${portalError}`);
    throw new Error(parts.join(" | "));
  }

  console.log("[billing] verification script completed");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[billing] failed: ${message}`);
  process.exit(1);
});
