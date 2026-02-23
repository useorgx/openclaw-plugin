import test from "node:test";
import assert from "node:assert/strict";

import { createHttpHandler } from "../../dist/http-handler.js";

function createStubResponse() {
  const res = {
    status: null,
    headers: null,
    body: Buffer.alloc(0),
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      if (body) {
        const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
        this.body = Buffer.concat([this.body, chunk]);
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

test("legacy /workspace-hub deep links redirect to /orgx/live", async () => {
  const config = baseConfig();
  const client = { getBaseUrl: () => config.baseUrl };
  const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

  const res = createStubResponse();
  const handled = await handler(
    {
      method: "GET",
      url: "/workspace-hub?center=2577519c-d0bf-4682-a7ec-e9ab28d19822&view=activity",
      headers: {},
    },
    res
  );

  assert.equal(handled, true);
  assert.equal(res.status, 302);
  assert.equal(
    res.headers?.Location,
    "/orgx/live?center=2577519c-d0bf-4682-a7ec-e9ab28d19822&view=activity"
  );
});
