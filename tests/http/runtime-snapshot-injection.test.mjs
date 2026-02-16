import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../../dist/http-handler.js";
import { resolveRuntimeHookToken } from "../../dist/runtime-instance-store.js";

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

test("live/snapshot injects runtime instances as sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const token = resolveRuntimeHookToken();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resHook = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/hooks/runtime",
        headers: { "content-type": "application/json", "x-orgx-hook-token": token },
        body: JSON.stringify({
          source_client: "codex",
          event: "session_start",
          run_id: "run_test_123",
          initiative_id: "init_test_1",
          workstream_id: "ws_test_1",
          task_id: "task_test_1",
          agent_id: "main",
          agent_name: "Engineering Agent",
          phase: "execution",
          progress_pct: 2,
          message: "slice started",
          metadata: { workstream_title: "Test Workstream", initiative_title: "Test Initiative" },
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const injected = body?.sessions?.nodes?.find((n) => n?.runId === "run_test_123") ?? null;
    assert.ok(injected, "expected runtime session injected");
    assert.equal(injected.agentId, "main");
    assert.equal(injected.agentName, "Engineering Agent");
    assert.equal(injected.runtimeProvider, "openai");
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("runtime session fallback identity and blocked reason are derived when agent info is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-fallback-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const token = resolveRuntimeHookToken();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resHook = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/hooks/runtime",
        headers: { "content-type": "application/json", "x-orgx-hook-token": token },
        body: JSON.stringify({
          source_client: "codex",
          event: "session_start",
          run_id: "run_test_blocked",
          phase: "blocked",
          message: "Agent execution failed",
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const injected = body?.sessions?.nodes?.find((n) => n?.runId === "run_test_blocked") ?? null;
    assert.ok(injected, "expected blocked runtime session injected");
    assert.equal(injected.agentId, "runtime:codex");
    assert.equal(injected.agentName, "Codex");
    assert.equal(injected.status, "blocked");
    assert.equal(injected.blockerReason, "Agent execution failed");
    assert.deepEqual(injected.blockers, ["Agent execution failed"]);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("stale runtime instances are not injected as synthetic fresh sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-stale-inject-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const token = resolveRuntimeHookToken();
    const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resHook = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/hooks/runtime",
        headers: { "content-type": "application/json", "x-orgx-hook-token": token },
        body: JSON.stringify({
          source_client: "codex",
          event: "session_start",
          run_id: "run_stale_only",
          initiative_id: "init_test_1",
          workstream_id: "ws_test_1",
          task_id: "task_test_1",
          agent_id: "main",
          agent_name: "Engineering Agent",
          phase: "execution",
          message: "stale test",
          timestamp: staleTimestamp,
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10",
        headers: {},
      },
      resSnapshot
    );
    assert.equal(resSnapshot.status, 200);

    const body = JSON.parse(resSnapshot.body);
    const injected = body?.sessions?.nodes?.find((n) => n?.runId === "run_stale_only") ?? null;
    assert.equal(injected, null, "stale runtime should not appear as a synthetic active session");
    const staleRuntime = body?.runtimeInstances?.find((instance) => instance?.runId === "run_stale_only") ?? null;
    assert.ok(staleRuntime, "expected stale runtime in runtimeInstances");
    assert.equal(staleRuntime?.state, "stale");
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("stale runtime reconciles an existing running session to queued with stale recovery summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-stale-reconcile-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const token = resolveRuntimeHookToken();
    const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-1",
            runId: "run_stale_reconcile",
            title: "Hook Research & Content Strategy",
            status: "running",
            initiativeId: "init_test_1",
            workstreamId: "ws_test_1",
            agentId: "main",
            agentName: "Engineering Agent",
            lastEventSummary: null,
          },
        ],
        edges: [],
        groups: [],
      }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resHook = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/hooks/runtime",
        headers: { "content-type": "application/json", "x-orgx-hook-token": token },
        body: JSON.stringify({
          source_client: "codex",
          event: "session_start",
          run_id: "run_stale_reconcile",
          initiative_id: "init_test_1",
          workstream_id: "ws_test_1",
          task_id: "task_test_1",
          agent_id: "main",
          agent_name: "Engineering Agent",
          phase: "execution",
          message: "slice started",
          timestamp: staleTimestamp,
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10",
        headers: {},
      },
      resSnapshot
    );
    assert.equal(resSnapshot.status, 200);

    const body = JSON.parse(resSnapshot.body);
    const session = body?.sessions?.nodes?.find((node) => node?.id === "sess-1") ?? null;
    assert.ok(session, "expected existing session node");
    assert.equal(session?.status, "queued");
    assert.equal(session?.state, "stale");
    assert.equal(session?.runtimeClient, "codex");
    assert.equal(session?.runtimeProvider, "openai");
    assert.equal(session?.lastEventSummary, "Recovered stale runtime; awaiting next dispatch.");
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});
