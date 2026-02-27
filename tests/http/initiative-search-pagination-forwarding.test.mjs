import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function call(handler, req) {
  const res = createStubResponse();
  await handler(req, res);
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

test("GET /orgx/api/entities forwards search + ids + offset for initiative list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-entities-search-"));
  const previousDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const calls = [];
    const client = {
      getBaseUrl: () => "https://www.useorgx.com",
      listEntities: async (type, filters = {}) => {
        calls.push({ type, filters });
        return {
          data: [
            {
              id: "init-red-dot",
              title: "Red Dot Pipeline",
              summary: "ICP Discovery and enrichment engine",
              status: "active",
              command_center_id: "workspace-a",
            },
            {
              id: "init-other",
              title: "Other Initiative",
              summary: "Unrelated",
              status: "active",
              command_center_id: "workspace-a",
            },
          ],
          pagination: { total: 2, has_more: false },
        };
      },
      rawRequest: async () => {
        throw new Error("not implemented");
      },
    };

    const handler = createHttpHandler(baseConfig(), client, () => null, createNoopOnboarding());
    const res = await call(handler, {
      method: "GET",
      url: "/orgx/api/entities?type=initiative&search=red%20dot&ids=init-red-dot,init-zed&offset=20&limit=10",
      headers: {},
    });

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(Array.isArray(payload.data), true);
    assert.deepEqual(payload.data.map((row) => row.id), ["init-red-dot"]);

    const initiativeCall = calls.find((entry) => entry.type === "initiative");
    assert.ok(initiativeCall, "expected listEntities initiative call");
    assert.equal(initiativeCall.filters.search, "red dot");
    assert.equal(initiativeCall.filters.offset, 20);
    assert.equal(initiativeCall.filters.limit, 10);
    assert.deepEqual(initiativeCall.filters.ids, ["init-red-dot", "init-zed"]);
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});

test("GET /orgx/api/entities accepts workspace_id alias, forwards canonical scope, and filters rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-entities-workspace-scope-"));
  const previousDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const calls = [];
    const client = {
      getBaseUrl: () => "https://www.useorgx.com",
      listEntities: async (type, filters = {}) => {
        calls.push({ type, filters });
        return {
          data: [
            {
              id: "init-a",
              title: "Workspace A Initiative",
              summary: "Scoped to workspace A",
              status: "active",
              workspace_id: "workspace-a",
            },
            {
              id: "init-b",
              title: "Workspace B Initiative",
              summary: "Scoped to workspace B",
              status: "active",
              command_center_id: "workspace-b",
            },
          ],
          pagination: { total: 2, has_more: false },
        };
      },
      rawRequest: async () => {
        throw new Error("not implemented");
      },
    };

    const handler = createHttpHandler(baseConfig(), client, () => null, createNoopOnboarding());
    const res = await call(handler, {
      method: "GET",
      url: "/orgx/api/entities?type=initiative&workspace_id=workspace-a&limit=10",
      headers: {},
    });

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.data.map((row) => row.id), ["init-a"]);

    const initiativeCall = calls.find((entry) => entry.type === "initiative");
    assert.ok(initiativeCall, "expected listEntities initiative call");
    assert.equal(initiativeCall.filters.workspace_id, "workspace-a");
    assert.equal(initiativeCall.filters.command_center_id, "workspace-a");
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});

test("GET /orgx/api/entities rejects project_id-only workspace scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-entities-project-scope-reject-"));
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
    const res = await call(handler, {
      method: "GET",
      url: "/orgx/api/entities?type=initiative&project_id=workspace-a&limit=10",
      headers: {},
    });

    assert.equal(res.status, 400);
    const payload = JSON.parse(res.body);
    assert.match(
      String(payload.error ?? ""),
      /project_id is no longer accepted/i
    );
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});

test("GET /orgx/api/entities falls back to empty command_center list when upstream fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-command-center-fallback-"));
  const previousDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const client = {
      getBaseUrl: () => "https://www.useorgx.com",
      listEntities: async (type) => {
        if (type === "command_center") {
          throw new Error("500 Internal Server Error: relation does not exist");
        }
        return { data: [], pagination: { total: 0, has_more: false } };
      },
      rawRequest: async () => {
        throw new Error("not implemented");
      },
    };

    const handler = createHttpHandler(
      baseConfig(),
      client,
      () => null,
      createNoopOnboarding()
    );
    const res = await call(handler, {
      method: "GET",
      url: "/orgx/api/entities?type=command_center&limit=50",
      headers: {},
    });

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(Array.isArray(payload?.data), true);
    assert.equal(payload?.data?.length, 0);
    assert.equal(payload?.localFallback, true);
    assert.match(String(payload?.warning ?? ""), /relation does not exist/i);
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});

test("GET /orgx/api/live/initiatives forwards offset and returns pagination envelope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-live-initiatives-pagination-"));
  const previousDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const liveCalls = [];
    const client = {
      getBaseUrl: () => "https://www.useorgx.com",
      listEntities: async () => ({ data: [], pagination: { total: 0, has_more: false } }),
      getLiveInitiatives: async (input = {}) => {
        liveCalls.push(input);
        return {
          initiatives: [
            { id: "init-3", title: "Gamma", status: "active" },
            { id: "init-4", title: "Delta", status: "active" },
          ],
          total: 12,
          pagination: {
            limit: 2,
            offset: 2,
            has_more: true,
          },
        };
      },
      rawRequest: async () => {
        throw new Error("not implemented");
      },
    };

    const handler = createHttpHandler(baseConfig(), client, () => null, createNoopOnboarding());
    const res = await call(handler, {
      method: "GET",
      url: "/orgx/api/live/initiatives?limit=2&offset=2",
      headers: {},
    });

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(Array.isArray(payload.initiatives), true);
    assert.equal(payload.initiatives.length, 2);
    assert.equal(payload.pagination.has_more, true);
    assert.equal(payload.pagination.limit, 2);
    assert.equal(payload.pagination.offset, 2);

    assert.equal(liveCalls.length, 1);
    assert.equal(liveCalls[0].limit, 2);
    assert.equal(liveCalls[0].offset, 2);
  } finally {
    if (previousDir == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previousDir;
  }
});
