import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../../dist/http-handler.js";
import { appendActivityItems } from "../../dist/activity-store.js";

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
  };
}

test("Artifact detail route falls back to local buffered artifact when upstream fetch fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-artifact-fallback-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const artifactId = "11111111-2222-4333-8444-555555555555";
    const now = new Date().toISOString();

    appendActivityItems([
      {
        id: `evt-${Date.now()}`,
        type: "artifact_created",
        title: "Hook strategy report",
        description: "Buffered locally after upstream rejection.",
        agentId: "runtime:openclaw",
        agentName: "OpenClaw",
        runId: "run-fallback-1",
        initiativeId: "init-fallback-1",
        timestamp: now,
        metadata: {
          artifact_id: artifactId,
          event: "autopilot_slice_artifact_buffered",
          artifact_type: "report",
          url: "/tmp/orgx/hook-strategy.json",
          error: "400 Bad Request: Field initiative_id is not valid for entity type artifact.",
          entity_type: "initiative",
          entity_id: "init-fallback-1",
        },
      },
    ]);

    const config = baseConfig();
    const client = {
      getBaseUrl: () => config.baseUrl,
      listEntities: async () => ({ data: [] }),
      rawRequest: async () => {
        throw new Error("502 upstream artifact endpoint unavailable");
      },
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
    const res = createStubResponse();

    await handler(
      {
        method: "GET",
        url: `/orgx/api/artifacts/${artifactId}`,
        headers: {},
      },
      res
    );

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body?.localFallback, true);
    assert.equal(body?.artifact?.id, artifactId);
    assert.equal(body?.artifact?.artifact_type, "report");
    assert.equal(body?.artifact?.entity_type, "initiative");
    assert.equal(body?.artifact?.entity_id, "init-fallback-1");
    assert.equal(
      body?.artifact?.artifact_url,
      "/orgx/api/live/filesystem/open?path=%2Ftmp%2Forgx%2Fhook-strategy.json"
    );
    assert.equal(body?.artifact?.metadata?.local_fallback, true);
    assert.ok(
      typeof body?.warning === "string" && body.warning.includes("upstream artifact endpoint unavailable")
    );
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

