import test from "node:test";
import assert from "node:assert/strict";

import { createHttpHandler } from "../../dist/http-handler.js";

function createStubResponse() {
  return {
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

function baseConfig() {
  return {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: "0.0.0-test",
  };
}

test("sentinel catalog route returns engineering entries", async () => {
  const config = baseConfig();
  const client = { getBaseUrl: () => config.baseUrl };
  const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

  const res = createStubResponse();
  await handler(
    {
      method: "GET",
      url: "/orgx/api/sentinels/catalog?domain=engineering",
      headers: {},
    },
    res
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body?.domain, "engineering");
  assert.equal(Array.isArray(body?.sentinels), true);
  assert.equal(body.sentinels.length, 3);
  for (const item of body.sentinels) {
    assert.equal(item?.domain, "engineering");
  }
});
