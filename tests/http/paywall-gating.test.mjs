import test from "node:test";
import assert from "node:assert/strict";

import { createHttpHandler } from "../../dist/http-handler.js";

function createStubResponse() {
  const res = {
    status: null,
    headers: null,
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      if (body) {
        this.body += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      }
      this.writableEnded = true;
    },
  };
  return res;
}

function createNoopOnboarding() {
  return {
    getState: () => ({
      status: "idle",
      hasApiKey: false,
      connectionVerified: false,
      workspaceName: null,
      lastError: null,
      nextAction: "connect",
      docsUrl: "https://example.com",
      keySource: "none",
      installationId: null,
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }),
    startPairing: async () => {
      throw new Error("not implemented");
    },
    getStatus: async () => {
      throw new Error("not implemented");
    },
    submitManualKey: async () => {
      throw new Error("not implemented");
    },
    disconnect: async () => {
      throw new Error("not implemented");
    },
  };
}

test("Premium gating blocks free plan BYOK launch (402 upgrade_required)", async () => {
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    getBillingStatus: async () => ({
      plan: "free",
      hasSubscription: false,
      subscriptionStatus: null,
      subscriptionCurrentPeriodEnd: null,
    }),
  };

  const handler = createHttpHandler(
    config,
    client,
    () => null,
    createNoopOnboarding()
  );

  const res = createStubResponse();
  const req = {
    method: "POST",
    url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&model=openai&dryRun=true",
    headers: {},
  };

  await handler(req, res);
  assert.equal(res.status, 402);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.code, "upgrade_required");
  assert.equal(parsed?.requiredPlan, "starter");
});

test("Premium gating allows paid plan BYOK launch in dry-run mode", async () => {
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    getBillingStatus: async () => ({
      plan: "starter",
      hasSubscription: true,
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: null,
    }),
  };

  const handler = createHttpHandler(
    config,
    client,
    () => null,
    createNoopOnboarding()
  );

  const res = createStubResponse();
  const req = {
    method: "POST",
    url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&model=openai&dryRun=true",
    headers: {},
  };

  await handler(req, res);
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.dryRun, true);
  assert.equal(parsed?.requiresPremiumLaunch, true);
});

