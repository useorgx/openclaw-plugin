import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHttpHandler } from "../../dist/http-handler.js";

function baseConfig() {
  return {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: false,
    pluginVersion: "0.0.0-test",
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

function createStubResponse() {
  return {
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
}

async function call(handler, { method = "GET", url, headers = {}, body } = {}) {
  const res = createStubResponse();
  await handler({ method, url, headers, body }, res);
  return {
    status: res.status ?? 0,
    headers: res.headers ?? {},
    body: res.body.toString("utf8"),
  };
}

test("deprecated summary and legacy live endpoints return 410 with replacements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-deprecated-endpoints-"));
  const previousDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const client = {
      getBaseUrl: () => "https://www.useorgx.com",
      listEntities: async () => ({ data: [], pagination: { total: 0, has_more: false } }),
      rawRequest: async () => {
        throw new Error("not implemented");
      },
    };
    const handler = createHttpHandler(baseConfig(), client, () => null, createNoopOnboarding());

    const agentsRes = await call(handler, {
      method: "GET",
      url: "/orgx/api/agents",
      headers: {},
    });
    assert.equal(agentsRes.status, 410);
    assert.match(agentsRes.body, /deprecated/i);
    assert.match(agentsRes.body, /live\/agents/i);

    const sessionsRes = await call(handler, {
      method: "GET",
      url: "/orgx/api/live/sessions?workspace_id=workspace-a",
      headers: {},
    });
    assert.equal(sessionsRes.status, 410);
    assert.match(sessionsRes.body, /deprecated/i);
    assert.match(sessionsRes.body, /live\/snapshot/i);
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});

