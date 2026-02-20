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
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-injection",
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

test("live/snapshot-v2 excludes runtime reporting slices from in-progress work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-v2-"));
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
          source_client: "openclaw",
          event: "session_update",
          run_id: "reporting_runtime_1",
          phase: "execution",
          progress_pct: 5,
          message: "Reporting telemetry heartbeat",
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot-v2?sessionsLimit=10&activityLimit=10&decisionsLimit=10",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const projections = Array.isArray(body?.projections) ? body.projections : [];
    const reporting = projections.find((entry) => entry?.sliceRunId === "reporting_runtime_1");
    assert.ok(reporting, "expected reporting projection in snapshot-v2");
    assert.equal(reporting.sliceKind, "runtime_reporting");
    const inProgress = Array.isArray(body?.inProgress) ? body.inProgress : [];
    assert.equal(
      inProgress.some((entry) => entry?.sliceRunId === "reporting_runtime_1"),
      false,
      "runtime reporting run should not appear in in-progress work slices"
    );
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
          initiative_id: "init_test_1",
          workstream_id: "ws_test_1",
          task_id: "task_test_1",
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
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-fallback-blocked",
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

test("runtime entries without execution scope are not injected as synthetic sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-unscope-inject-"));
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
          source_client: "openclaw",
          event: "progress",
          run_id: "run_unscoped_reporting",
          phase: "execution",
          message: "Hook event: post_tool_use",
          metadata: { source: "hook_runtime_relay", hook_event: "post_tool_use" },
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-unscoped-not-injected",
        headers: {},
      },
      resSnapshot
    );
    assert.equal(resSnapshot.status, 200);

    const body = JSON.parse(resSnapshot.body);
    const injected = body?.sessions?.nodes?.find((n) => n?.runId === "run_unscoped_reporting") ?? null;
    assert.equal(injected, null, "unscoped telemetry runtime should not appear as an active session");
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
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-stale-not-injected",
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
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-stale-reconcile",
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

test("completed runtime reconciles stale blocked session to completed and clears blockers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-completed-reconcile-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const token = resolveRuntimeHookToken();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-completed-1",
            runId: "run_completed_reconcile",
            title: "Version harness session",
            status: "blocked",
            initiativeId: "init_test_1",
            workstreamId: "ws_test_1",
            agentId: "main",
            agentName: "Engineering Agent",
            blockers: ["waiting on stale blocker"],
            blockerReason: "waiting on stale blocker",
            lastEventSummary: "autopilot blocked",
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
          event: "session_stop",
          run_id: "run_completed_reconcile",
          initiative_id: "init_test_1",
          workstream_id: "ws_test_1",
          task_id: "task_test_1",
          agent_id: "main",
          agent_name: "Engineering Agent",
          phase: "completed",
          message: "session completed cleanly",
        }),
      },
      resHook
    );
    assert.equal(resHook.status, 200);

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=runtime-completed-reconcile",
        headers: {},
      },
      resSnapshot
    );
    assert.equal(resSnapshot.status, 200);

    const body = JSON.parse(resSnapshot.body);
    const session = body?.sessions?.nodes?.find((node) => node?.id === "sess-completed-1") ?? null;
    assert.ok(session, "expected existing session node");
    assert.equal(session?.status, "completed");
    assert.deepEqual(session?.blockers ?? [], []);
    assert.equal(session?.blockerReason, null);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("live/snapshot reclassifies stale reporting-only blocked sessions to completed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-reporting-reclassify-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const staleUpdatedAt = new Date(Date.now() - 45 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-reporting-1",
            runId: "run_reporting_reclassify",
            title: "Reporting · codex",
            status: "blocked",
            phase: "blocked",
            state: "blocked",
            initiativeId: "init_test_1",
            workstreamId: null,
            agentId: null,
            agentName: null,
            blockers: [],
            blockerReason: null,
            lastEventSummary: null,
            startedAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            lastEventAt: staleUpdatedAt,
            parentId: null,
            progress: null,
            groupId: "init_test_1",
            groupLabel: "Init Test",
          },
        ],
        edges: [],
        groups: [{ id: "init_test_1", label: "Init Test", status: "blocked" }],
      }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=reporting-reclassify",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const session = body?.sessions?.nodes?.find((node) => node?.id === "sess-reporting-1") ?? null;
    assert.ok(session, "expected reporting session node");
    assert.equal(session?.status, "completed");
    assert.equal(session?.phase, "completed");
    assert.equal(session?.state, "completed");
    assert.equal(session?.blockerReason, null);
    assert.deepEqual(session?.blockers ?? [], []);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("live/snapshot reclassifies stale reporting sessions with generic recovery blockers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-reporting-generic-recovery-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const staleUpdatedAt = new Date(Date.now() - 45 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-reporting-generic-1",
            runId: "run_reporting_generic_recovery",
            title: "Reporting · codex",
            status: "blocked",
            phase: "blocked",
            state: "blocked",
            initiativeId: "init_test_1",
            workstreamId: null,
            agentId: null,
            agentName: null,
            blockers: ["Agent execution failed"],
            blockerReason: "Agent execution failed",
            lastEventSummary: "Agent execution failed",
            startedAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            lastEventAt: staleUpdatedAt,
            parentId: null,
            progress: null,
            groupId: "init_test_1",
            groupLabel: "Init Test",
          },
        ],
        edges: [],
        groups: [{ id: "init_test_1", label: "Init Test", status: "blocked" }],
      }),
      getLiveActivity: async () => ({
        activities: [
          {
            id: "evt-generic-recovery-1",
            type: "blocker_created",
            title: "Agent execution failed",
            description: "Agent execution failed",
            summary: "Agent execution failed",
            runId: "run_reporting_generic_recovery",
            initiativeId: "init_test_1",
            timestamp: new Date(Date.now() - 44 * 60_000).toISOString(),
            metadata: {
              source: "console_worker",
              errorCode: "STATE_ERROR",
              errorCategory: "state_error",
              description:
                "Run was stuck in running state for 58m. Automatically recovered.",
              suggestedActions: ["Open session inspector", "Resume if needed"],
            },
          },
        ],
      }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=reporting-generic-recovery",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const session =
      body?.sessions?.nodes?.find((node) => node?.id === "sess-reporting-generic-1") ?? null;
    assert.ok(session, "expected reporting session node");
    assert.equal(session?.status, "completed");
    assert.equal(session?.phase, "completed");
    assert.equal(session?.state, "completed");
    assert.equal(session?.blockerReason, null);
    assert.deepEqual(session?.blockers ?? [], []);
    assert.equal(session?.blockerDiagnostics ?? null, null);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("live/snapshot enriches blocked reporting sessions with actionable diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-reporting-diagnostics-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const activeUpdatedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const eventTimestamp = new Date(Date.now() - 90_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-reporting-diagnostics-1",
            runId: "run_reporting_diagnostics",
            title: "Reporting · openclaw",
            status: "blocked",
            phase: "blocked",
            state: "blocked",
            initiativeId: "init_test_1",
            workstreamId: null,
            agentId: null,
            agentName: null,
            blockers: [],
            blockerReason: null,
            lastEventSummary: null,
            startedAt: activeUpdatedAt,
            updatedAt: activeUpdatedAt,
            lastEventAt: activeUpdatedAt,
            parentId: null,
            progress: null,
            groupId: "init_test_1",
            groupLabel: "Init Test",
          },
        ],
        edges: [],
        groups: [{ id: "init_test_1", label: "Init Test", status: "blocked" }],
      }),
      getLiveActivity: async () => ({
        activities: [
          {
            id: "evt-reporting-diagnostics-context",
            type: "run_started",
            title: "Autopilot slice started",
            description: "slice started",
            summary: "slice started",
            runId: "run_reporting_diagnostics",
            initiativeId: "init_test_1",
            timestamp: new Date(Date.now() - 100_000).toISOString(),
            metadata: {
              workstream_id: "ws_sage",
              workstream_title: "Sage",
              slice_run_id: "slice_123",
              task_ids: ["task_a", "task_b"],
              milestone_ids: ["ms_1"],
              parallel_mode: "iwmt",
              log_path: "/tmp/autopilot/slice_123.log",
              output_path: "/tmp/autopilot/slice_123.output.json",
            },
          },
          {
            id: "evt-reporting-diagnostics-blocker",
            type: "run_failed",
            title: "Autopilot slice failed",
            description: "Slice exited without valid output contract",
            summary: "Autopilot slice failed",
            runId: "run_reporting_diagnostics",
            initiativeId: "init_test_1",
            timestamp: eventTimestamp,
            metadata: {
              source: "autopilot",
              errorCode: "SLICE_EXIT_INVALID",
              errorCategory: "execution_failure",
              retryable: false,
              suggestedActions: [
                "Open evidence log",
                "Approve retry with narrower scope",
              ],
            },
          },
        ],
      }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=20&decisionsLimit=10&testCase=reporting-diagnostics",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const session =
      body?.sessions?.nodes?.find((node) => node?.id === "sess-reporting-diagnostics-1") ?? null;
    assert.ok(session, "expected reporting session node");
    assert.equal(session?.status, "blocked");
    assert.equal(session?.blockerReason, "Autopilot slice failed");
    assert.deepEqual(session?.blockers ?? [], ["Autopilot slice failed"]);
    assert.ok(session?.blockerDiagnostics, "expected blocker diagnostics");
    assert.equal(session?.blockerDiagnostics?.errorCode, "SLICE_EXIT_INVALID");
    assert.equal(session?.blockerDiagnostics?.errorCategory, "execution_failure");
    assert.equal(session?.blockerDiagnostics?.source, "autopilot");
    assert.equal(session?.blockerDiagnostics?.retryable, false);
    assert.deepEqual(session?.blockerDiagnostics?.suggestedActions ?? [], [
      "Open evidence log",
      "Approve retry with narrower scope",
    ]);
    assert.equal(session?.blockerDiagnostics?.context?.workstreamId, "ws_sage");
    assert.equal(session?.blockerDiagnostics?.context?.workstreamTitle, "Sage");
    assert.equal(session?.blockerDiagnostics?.context?.sliceRunId, "slice_123");
    assert.equal(session?.blockerDiagnostics?.context?.parallelMode, "iwmt");
    assert.deepEqual(session?.blockerDiagnostics?.context?.taskIds ?? [], ["task_a", "task_b"]);
    assert.deepEqual(session?.blockerDiagnostics?.context?.milestoneIds ?? [], ["ms_1"]);
    assert.equal(session?.blockerDiagnostics?.context?.logPath, "/tmp/autopilot/slice_123.log");
    assert.equal(
      session?.blockerDiagnostics?.context?.outputPath,
      "/tmp/autopilot/slice_123.output.json"
    );
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("live/snapshot keeps reporting blocked sessions blocked when blocker evidence exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-runtime-reporting-blocked-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const staleUpdatedAt = new Date(Date.now() - 45 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-reporting-2",
            runId: "run_reporting_should_stay_blocked",
            title: "Reporting · openclaw",
            status: "blocked",
            phase: "blocked",
            state: "blocked",
            initiativeId: "init_test_1",
            workstreamId: null,
            agentId: null,
            agentName: null,
            blockers: ["Waiting on decision"],
            blockerReason: "Waiting on decision",
            lastEventSummary: null,
            startedAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            lastEventAt: staleUpdatedAt,
            parentId: null,
            progress: null,
            groupId: "init_test_1",
            groupLabel: "Init Test",
          },
        ],
        edges: [],
        groups: [{ id: "init_test_1", label: "Init Test", status: "blocked" }],
      }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=reporting-stays-blocked",
        headers: {},
      },
      resSnapshot
    );

    assert.equal(resSnapshot.status, 200);
    const body = JSON.parse(resSnapshot.body);
    const session = body?.sessions?.nodes?.find((node) => node?.id === "sess-reporting-2") ?? null;
    assert.ok(session, "expected reporting session node");
    assert.equal(session?.status, "blocked");
    assert.equal(session?.phase, "blocked");
    assert.equal(session?.state, "blocked");
    assert.equal(session?.blockerReason, "Waiting on decision");
    assert.deepEqual(session?.blockers ?? [], ["Waiting on decision"]);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("run action complete marks a blocked session as completed in live snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-run-complete-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const config = baseConfig();
    const staleUpdatedAt = new Date(Date.now() - 30 * 60_000).toISOString();

    const client = {
      getBaseUrl: () => config.baseUrl,
      getLiveSessions: async () => ({
        nodes: [
          {
            id: "sess-manual-complete-1",
            runId: "run_manual_complete",
            title: "Reporting · codex",
            status: "blocked",
            phase: "blocked",
            state: "blocked",
            initiativeId: "init_test_1",
            workstreamId: null,
            agentId: null,
            agentName: null,
            blockers: ["stuck"],
            blockerReason: "stuck",
            lastEventSummary: null,
            startedAt: staleUpdatedAt,
            updatedAt: staleUpdatedAt,
            lastEventAt: staleUpdatedAt,
            parentId: null,
            progress: null,
            groupId: "init_test_1",
            groupLabel: "Init Test",
          },
        ],
        edges: [],
        groups: [{ id: "init_test_1", label: "Init Test", status: "blocked" }],
      }),
      getLiveActivity: async () => ({ activities: [] }),
      getHandoffs: async () => ({ handoffs: [] }),
      getLiveDecisions: async () => ({ decisions: [] }),
      getLiveAgents: async () => ({ agents: [] }),
      listEntities: async () => ({ data: [] }),
      runAction: async () => ({ ok: true }),
      listRunCheckpoints: async () => ({ ok: true, data: [] }),
      createRunCheckpoint: async () => ({ ok: true, data: { id: "cp-1" } }),
      restoreRunCheckpoint: async () => ({ ok: true }),
    };

    const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

    const resComplete = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/runs/run_manual_complete/actions/complete",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "bulk_complete_test" }),
      },
      resComplete
    );
    assert.equal(resComplete.status, 200);
    const completeBody = JSON.parse(resComplete.body);
    assert.equal(completeBody?.data?.action, "complete");
    assert.equal(completeBody?.data?.status, "completed");

    const resSnapshot = createStubResponse();
    await handler(
      {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=10&activityLimit=10&decisionsLimit=10&testCase=run-action-complete",
        headers: {},
      },
      resSnapshot
    );
    assert.equal(resSnapshot.status, 200);

    const body = JSON.parse(resSnapshot.body);
    const session = body?.sessions?.nodes?.find((node) => node?.id === "sess-manual-complete-1") ?? null;
    assert.ok(session, "expected session node");
    assert.equal(session?.status, "completed");
    assert.deepEqual(session?.blockers ?? [], []);
    assert.equal(session?.blockerReason, null);
  } finally {
    if (prevPluginDir == null) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});
