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
    pluginVersion: "test",
  };
}

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createScopedHarness() {
  const initiatives = [
    {
      id: "init-a",
      title: "Workspace A Initiative",
      status: "active",
      priority: "high",
      command_center_id: "workspace-a",
    },
    {
      id: "init-b",
      title: "Workspace B Initiative",
      status: "active",
      priority: "high",
      command_center_id: "workspace-b",
    },
  ];
  const workstreams = [
    {
      id: "ws-a-1",
      name: "Workspace A Stream",
      status: "active",
      initiative_id: "init-a",
      assigned_agents: [{ id: "agent-a", name: "Agent A", domain: "engineering" }],
    },
    {
      id: "ws-b-1",
      name: "Workspace B Stream",
      status: "active",
      initiative_id: "init-b",
      assigned_agents: [{ id: "agent-b", name: "Agent B", domain: "engineering" }],
    },
  ];
  const tasks = [
    {
      id: "task-a-1",
      title: "Workspace A Task",
      status: "todo",
      initiative_id: "init-a",
      workstream_id: "ws-a-1",
      milestone_id: null,
      priority: "high",
    },
    {
      id: "task-b-1",
      title: "Workspace B Task",
      status: "todo",
      initiative_id: "init-b",
      workstream_id: "ws-b-1",
      milestone_id: null,
      priority: "high",
    },
  ];

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters = {}) => {
      if (type === "initiative") {
        // Simulate upstream ignoring both project_id and command_center_id filters.
        return { data: initiatives, pagination: { total: initiatives.length, has_more: false } };
      }
      if (type === "workstream") {
        const initiativeId = typeof filters.initiative_id === "string" ? filters.initiative_id : null;
        const rows = initiativeId
          ? workstreams.filter((item) => item.initiative_id === initiativeId)
          : workstreams;
        return { data: rows, pagination: { total: rows.length, has_more: false } };
      }
      if (type === "task") {
        const initiativeId = typeof filters.initiative_id === "string" ? filters.initiative_id : null;
        const workstreamId = typeof filters.workstream_id === "string" ? filters.workstream_id : null;
        const rows = tasks.filter((item) => {
          if (initiativeId && item.initiative_id !== initiativeId) return false;
          if (workstreamId && item.workstream_id !== workstreamId) return false;
          return true;
        });
        return { data: rows, pagination: { total: rows.length, has_more: false } };
      }
      if (type === "milestone") {
        return { data: [], pagination: { total: 0, has_more: false } };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    getLiveInitiatives: async () => ({ initiatives, total: initiatives.length }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: [] }),
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async () => ({ decisions: [], total: 0 }),
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    emitActivity: async () => ({ ok: true, run_id: "run_1", event_id: null, reused_run: false }),
    bulkDecideDecisions: async () => [],
    rawRequest: async () => {
      throw new Error("not implemented");
    },
    applyChangeset: async () => ({
      ok: true,
      changeset_id: "cs_1",
      replayed: false,
      run_id: "run_1",
      applied_count: 0,
      results: [],
      event_id: null,
    }),
    createEntity: async () => ({ ok: true, id: "entity_1" }),
    updateEntity: async () => ({ ok: true }),
    checkSpawnGuard: async () => ({
      allowed: true,
      modelTier: "sonnet",
      checks: {
        rateLimit: { passed: true, current: 1, max: 10 },
        qualityGate: { passed: true, score: 5, threshold: 3 },
        taskAssigned: { passed: true, taskId: "task-a-1", status: "todo" },
      },
      blockedReason: null,
    }),
  };

  return { client };
}

function createProjectFallbackHarness() {
  const initiatives = [
    {
      id: "init-project-only",
      title: "Project-only Initiative",
      status: "active",
      priority: "high",
      project_id: "workspace-a",
      command_center_id: null,
    },
    {
      id: "init-b",
      title: "Workspace B Initiative",
      status: "active",
      priority: "high",
      project_id: null,
      command_center_id: "workspace-b",
    },
  ];
  const workstreams = [
    {
      id: "ws-project-only",
      name: "Project-only Workstream",
      status: "active",
      initiative_id: "init-project-only",
      assigned_agents: [{ id: "agent-a", name: "Agent A", domain: "engineering" }],
    },
  ];
  const tasks = [
    {
      id: "task-project-only",
      title: "Project-only Task",
      status: "todo",
      initiative_id: "init-project-only",
      workstream_id: "ws-project-only",
      milestone_id: null,
      priority: "high",
    },
  ];

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters = {}) => {
      if (type === "command_center") {
        return {
          data: [
            { id: "workspace-a", title: "Workspace A", status: "active" },
            { id: "workspace-b", title: "Workspace B", status: "active" },
          ],
          pagination: { total: 2, has_more: false },
        };
      }
      if (type === "initiative") {
        // Simulate upstream ignoring filters; the plugin must enforce workspace isolation.
        return { data: initiatives, pagination: { total: initiatives.length, has_more: false } };
      }
      if (type === "workstream") {
        const initiativeId = typeof filters.initiative_id === "string" ? filters.initiative_id : null;
        const rows = initiativeId
          ? workstreams.filter((item) => item.initiative_id === initiativeId)
          : workstreams;
        return { data: rows, pagination: { total: rows.length, has_more: false } };
      }
      if (type === "task") {
        const initiativeId = typeof filters.initiative_id === "string" ? filters.initiative_id : null;
        const rows = initiativeId
          ? tasks.filter((item) => item.initiative_id === initiativeId)
          : tasks;
        return { data: rows, pagination: { total: rows.length, has_more: false } };
      }
      if (type === "milestone") {
        return { data: [], pagination: { total: 0, has_more: false } };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    getLiveInitiatives: async () => ({ initiatives, total: initiatives.length }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: [] }),
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async () => ({ decisions: [], total: 0 }),
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    emitActivity: async () => ({ ok: true, run_id: "run_1", event_id: null, reused_run: false }),
    bulkDecideDecisions: async () => [],
    rawRequest: async () => {
      throw new Error("not implemented");
    },
    applyChangeset: async () => ({
      ok: true,
      changeset_id: "cs_1",
      replayed: false,
      run_id: "run_1",
      applied_count: 0,
      results: [],
      event_id: null,
    }),
    createEntity: async () => ({ ok: true, id: "entity_1" }),
    updateEntity: async () => ({ ok: true }),
    checkSpawnGuard: async () => ({
      allowed: true,
      modelTier: "sonnet",
      checks: {
        rateLimit: { passed: true, current: 1, max: 10 },
        qualityGate: { passed: true, score: 5, threshold: 3 },
        taskAssigned: { passed: true, taskId: "task-project-only", status: "todo" },
      },
      blockedReason: null,
    }),
  };

  return { client };
}

function createPagedWorkspaceHarness() {
  const workspaceAInitiatives = Array.from({ length: 130 }, (_, index) => ({
    id: `init-a-${String(index + 1).padStart(3, "0")}`,
    title: `Workspace A Initiative ${index + 1}`,
    status: "active",
    priority: "high",
    command_center_id: "workspace-a",
  }));
  const workspaceBInitiatives = Array.from({ length: 12 }, (_, index) => ({
    id: `init-b-${String(index + 1).padStart(3, "0")}`,
    title: `Workspace B Initiative ${index + 1}`,
    status: "active",
    priority: "high",
    command_center_id: "workspace-b",
  }));
  const initiatives = [...workspaceAInitiatives, ...workspaceBInitiatives];

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters = {}) => {
      if (type === "command_center") {
        return {
          data: [
            { id: "workspace-a", title: "Workspace A", status: "active" },
            { id: "workspace-b", title: "Workspace B", status: "active" },
          ],
          pagination: { total: 2, has_more: false },
        };
      }
      if (type === "initiative") {
        const limit = Number.isFinite(Number(filters.limit))
          ? Math.max(1, Math.floor(Number(filters.limit)))
          : 100;
        const offset = Number.isFinite(Number(filters.offset))
          ? Math.max(0, Math.floor(Number(filters.offset)))
          : 0;
        const page = initiatives.slice(offset, offset + limit);
        return {
          data: page,
          pagination: {
            total: initiatives.length,
            has_more: offset + page.length < initiatives.length,
          },
        };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    getLiveInitiatives: async () => ({ initiatives, total: initiatives.length }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: [] }),
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async () => ({ decisions: [], total: 0 }),
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    emitActivity: async () => ({ ok: true, run_id: "run_1", event_id: null, reused_run: false }),
    bulkDecideDecisions: async () => [],
    rawRequest: async () => {
      throw new Error("not implemented");
    },
    applyChangeset: async () => ({
      ok: true,
      changeset_id: "cs_1",
      replayed: false,
      run_id: "run_1",
      applied_count: 0,
      results: [],
      event_id: null,
    }),
    createEntity: async () => ({ ok: true, id: "entity_1" }),
    updateEntity: async () => ({ ok: true }),
    checkSpawnGuard: async () => ({
      allowed: true,
      modelTier: "sonnet",
      checks: {
        rateLimit: { passed: true, current: 1, max: 10 },
        qualityGate: { passed: true, score: 5, threshold: 3 },
        taskAssigned: { passed: true, taskId: "task-a-1", status: "todo" },
      },
      blockedReason: null,
    }),
  };

  return { client };
}

async function createHandler(harnessFactory = createScopedHarness) {
  const harness = harnessFactory();
  const config = baseConfig();
  const handler = createHttpHandler(config, harness.client, () => null, createNoopOnboarding(), undefined, {
    openclaw: {
      listAgents: async () => [
        { id: "agent-a", name: "Agent A" },
        { id: "agent-b", name: "Agent B" },
      ],
      spawnAgentTurn: async () => ({
        ok: true,
        pid: 1234,
        runId: "run_1",
        command: ["codex"],
        warnings: [],
      }),
      stopDetachedProcess: async () => ({ ok: true }),
      isPidAlive: async () => false,
    },
  });
  return handler;
}

test("workspace scope filters live initiatives and next-up queue even when upstream ignores filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-workspace-scope-surfaces-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const handler = await createHandler();

      const initiativesRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/live/initiatives?project_id=workspace-a&limit=50",
        headers: {},
      });
      assert.equal(initiativesRes.status, 200);
      const initiativesBody = JSON.parse(initiativesRes.body);
      assert.deepEqual(
        (initiativesBody.initiatives ?? []).map((item) => item.id),
        ["init-a"]
      );

      const nextUpRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?project_id=workspace-a",
        headers: {},
      });
      assert.equal(nextUpRes.status, 200);
      const nextUpBody = JSON.parse(nextUpRes.body);
      assert.equal(nextUpBody.ok, true);
      assert.ok(Array.isArray(nextUpBody.items));
      assert.ok(nextUpBody.items.length > 0);
      assert.ok(
        nextUpBody.items.every((item) => item.initiativeId === "init-a"),
        "next-up should only include workspace-a initiatives"
      );
    }
  );
});

test("workspace scope filters mission-control slices and accepts level alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-workspace-slices-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const handler = await createHandler();

      const slicesRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/slices?project_id=workspace-a&level=initiative",
        headers: {},
      });
      assert.equal(slicesRes.status, 200);
      const slicesBody = JSON.parse(slicesRes.body);
      assert.equal(slicesBody.ok, true);
      assert.equal(slicesBody.level, "initiative");
      assert.equal(slicesBody.scope, "initiative");
      assert.ok(Array.isArray(slicesBody.items));
      assert.ok(slicesBody.items.length > 0);
      assert.ok(
        slicesBody.items.every((item) => item.initiativeId === "init-a"),
        "slices should only include workspace-a initiatives"
      );
    }
  );
});

test("workspace scope falls back to project_id initiatives when command center links are missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-workspace-scope-project-fallback-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const handler = await createHandler(createProjectFallbackHarness);

      const initiativesRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/live/initiatives?project_id=workspace-a&limit=50",
        headers: {},
      });
      assert.equal(initiativesRes.status, 200);
      const initiativesBody = JSON.parse(initiativesRes.body);
      assert.deepEqual(
        (initiativesBody.initiatives ?? []).map((item) => item.id),
        ["init-project-only"]
      );

      const nextUpRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?project_id=workspace-a",
        headers: {},
      });
      assert.equal(nextUpRes.status, 200);
      const nextUpBody = JSON.parse(nextUpRes.body);
      assert.equal(nextUpBody.ok, true);
      assert.equal(Array.isArray(nextUpBody.items), true);
      assert.ok(nextUpBody.items.length > 0);
      assert.ok(
        nextUpBody.items.every((item) => item.initiativeId === "init-project-only"),
        "next-up should stay scoped to workspace-a fallback initiatives"
      );
    }
  );
});

test("workspace initiative discovery paginates beyond first 100 initiatives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-workspace-pagination-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_PROJECT_SCOPE_MAX_INITIATIVE_PAGES: "6",
    },
    async () => {
      const handler = await createHandler(createPagedWorkspaceHarness);

      const initiativesRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/live/initiatives?project_id=workspace-a&limit=200",
        headers: {},
      });
      assert.equal(initiativesRes.status, 200);
      const initiativesBody = JSON.parse(initiativesRes.body);
      assert.equal(initiativesBody.total, 130);
      assert.equal(initiativesBody.initiatives.length, 130);
      assert.ok(
        initiativesBody.initiatives.every(
          (item) => item.command_center_id === "workspace-a"
        ),
        "all returned initiatives should belong to workspace-a"
      );
    }
  );
});
