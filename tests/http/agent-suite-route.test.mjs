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

test("Agent suite status + install endpoints return structured plan (dry-run)", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-suite-http-"));
  const prevOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const workspacesDir = join(openclawHome, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });

    const openclawConfigPath = join(openclawHome, "openclaw.json");
    writeFileSync(
      openclawConfigPath,
      JSON.stringify(
        {
          agents: {
            list: [{ id: "orgx", name: "OrgX", workspace: join(workspacesDir, "orgx") }],
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const config = baseConfig();
    const client = { getBaseUrl: () => config.baseUrl };
    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const statusRes = createStubResponse();
    await handler(
      { method: "GET", url: "/orgx/api/agent-suite/status", headers: {} },
      statusRes
    );
    assert.equal(statusRes.status, 200);
    const statusBody = JSON.parse(statusRes.body);
    assert.equal(statusBody?.ok, true);
    assert.equal(statusBody?.data?.packId, "orgx-agent-suite");
    assert.equal(statusBody?.data?.openclawConfigPath, openclawConfigPath);

    const installRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/agent-suite/install",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      },
      installRes
    );
    assert.equal(installRes.status, 200);
    const installBody = JSON.parse(installRes.body);
    assert.equal(installBody?.ok, true);
    assert.equal(installBody?.dryRun, true);
    assert.equal(installBody?.applied, false);
    assert.equal(installBody?.data?.packId, "orgx-agent-suite");
  } finally {
    if (prevOpenclawHome == null) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = prevOpenclawHome;
    }
  }
});

