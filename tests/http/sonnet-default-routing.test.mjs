import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("Agent launch dry-run auto-selects sonnet-capable provider from OpenClaw settings", async () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;

  const home = mkdtempSync(join(tmpdir(), "orgx-sonnet-default-"));
  const openclawHome = join(home, ".openclaw");
  mkdirSync(openclawHome, { recursive: true });

  writeFileSync(
    join(openclawHome, "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-5": { alias: "opus" },
              "openrouter/anthropic/claude-sonnet-4.5": { alias: "sonnet" },
            },
          },
        },
      },
      null,
      2
    )
  );

  process.env.HOME = home;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
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
      createNoopOnboarding(),
      undefined,
      {
        openclaw: {
          listAgents: async () => [{ id: "agent-1", model: null }],
        },
      }
    );

    const res = createStubResponse();
    const req = {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&dryRun=true",
      headers: {},
    };

    await handler(req, res);

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed?.ok, true);
    assert.equal(parsed?.dryRun, true);
    assert.equal(parsed?.provider, "openrouter");
    assert.equal(parsed?.requiresPremiumLaunch, true);
  } finally {
    process.env.HOME = originalHome;
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
});
