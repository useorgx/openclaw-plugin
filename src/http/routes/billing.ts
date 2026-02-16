import type { BillingCheckoutRequest } from "../../types.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type BillingClientLike = {
  getBaseUrl: () => string;
  getBillingStatus: () => Promise<unknown>;
  createBillingCheckout: (input: BillingCheckoutRequest) => Promise<{
    url?: string | null;
    checkout_url?: string | null;
  }>;
  createBillingPortal: () => Promise<{ url?: string | null }>;
};

type RegisterBillingRoutesDeps<TReq, TRes> = {
  client: BillingClientLike;
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: JsonRecord, keys: string[]) => string | null;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerBillingRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterBillingRoutesDeps<TReq, TRes>
): void {
  router.add(
    "GET",
    "billing/status",
    async ({ res }) => {
      try {
        const status = await deps.client.getBillingStatus();
        deps.sendJson(res, 200, { ok: true, data: status });
      } catch (err: unknown) {
        deps.sendJson(res, 200, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Get billing plan/status"
  );

  router.add(
    "POST",
    "billing/checkout",
    async ({ req, res }) => {
      const basePricingUrl = `${deps.client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
      try {
        const payload = await deps.parseJsonRequest(req);
        const planIdRaw = (
          deps.pickString(payload, ["planId", "plan_id", "plan"]) ?? "starter"
        )
          .trim()
          .toLowerCase();
        const billingCycleRaw = (
          deps.pickString(payload, ["billingCycle", "billing_cycle"]) ?? "monthly"
        )
          .trim()
          .toLowerCase();

        const planId =
          planIdRaw === "team" || planIdRaw === "enterprise" ? planIdRaw : "starter";
        const billingCycle = billingCycleRaw === "annual" ? "annual" : "monthly";

        const result = await deps.client.createBillingCheckout({
          planId,
          billingCycle,
        } satisfies BillingCheckoutRequest);

        const url = result?.url ?? result?.checkout_url ?? null;
        deps.sendJson(res, 200, { ok: true, data: { url: url ?? basePricingUrl } });
      } catch {
        // If remote billing endpoints are unavailable, degrade gracefully.
        deps.sendJson(res, 200, { ok: true, data: { url: basePricingUrl } });
      }
    },
    "Create billing checkout session"
  );

  router.add(
    "POST",
    "billing/portal",
    async ({ res }) => {
      const basePricingUrl = `${deps.client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
      try {
        const result = await deps.client.createBillingPortal();
        const url = result?.url ?? null;
        deps.sendJson(res, 200, { ok: true, data: { url: url ?? basePricingUrl } });
      } catch {
        deps.sendJson(res, 200, { ok: true, data: { url: basePricingUrl } });
      }
    },
    "Create billing portal session"
  );

  router.add(
    "*",
    "billing/status",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for billing/status"
  );
  router.add(
    "*",
    "billing/checkout",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for billing/checkout"
  );
  router.add(
    "*",
    "billing/portal",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for billing/portal"
  );
}
