import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
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
  };
}

test("Entity comments POST falls back locally when upstream save fails (and does not send commentType upstream)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-comments-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const calls = { rawRequest: [] };

    const client = {
      getBaseUrl: () => config.baseUrl,
      listEntities: async () => ({ data: [] }),
      rawRequest: async (method, path, body) => {
        calls.rawRequest.push({ method, path, body });
        if (method === "POST") {
          throw new Error("500 Internal Server Error: Unable to save comment.");
        }
        throw new Error("upstream unavailable");
      },
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const res1 = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/entities/initiative/init-1/comments",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Hi there",
          commentType: "note",
          severity: "info",
          tags: [],
        }),
      },
      res1
    );

    assert.equal(res1.status, 200);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1?.status, "success");
    assert.equal(body1?.localFallback, true);
    assert.ok(body1?.comment?.id?.startsWith("local_"));
    assert.equal(body1?.comment?.body, "Hi there");

    const upstreamPost = calls.rawRequest.find((c) => c.method === "POST");
    assert.ok(upstreamPost, "expected upstream POST attempt");
    assert.equal(upstreamPost.path, "/api/entities/initiative/init-1/comments");
    assert.ok(upstreamPost.body && typeof upstreamPost.body === "object");
    assert.ok(!("commentType" in upstreamPost.body), "should not send commentType upstream");
    assert.equal(upstreamPost.body.comment_type, "note");

    const res2 = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/entities/initiative/init-1/comments",
        headers: {},
      },
      res2
    );

    assert.equal(res2.status, 200);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2?.status, "success");
    assert.ok(Array.isArray(body2?.comments));
    assert.ok(
      body2.comments.some((c) => c?.body === "Hi there"),
      "expected local comment in GET response"
    );
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

