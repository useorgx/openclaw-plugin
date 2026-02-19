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

async function call(handler, req) {
  const res = createStubResponse();
  await handler(req, res);
  return res;
}

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function createClientHarness({ blockedQueueForWs1 = false } = {}) {
  const calls = {
    listEntities: [],
    updateEntity: [],
    emitActivity: [],
  };

  const tasks = new Map([
    [
      "task-ws1-primary",
      {
        id: "task-ws1-primary",
        title: "Primary WS1 task",
        status: "todo",
        initiative_id: "init-1",
        workstream_id: "ws-1",
        milestone_id: null,
        priority: "high",
        dependency_ids: blockedQueueForWs1 ? ["task-ws1-dependency"] : [],
      },
    ],
    [
      "task-ws1-dependency",
      {
        id: "task-ws1-dependency",
        title: "Dependency WS1 task",
        status: blockedQueueForWs1 ? "todo" : "done",
        initiative_id: "init-1",
        workstream_id: "ws-1",
        milestone_id: null,
        priority: "high",
      },
    ],
    [
      "task-ws1-running",
      {
        id: "task-ws1-running",
        title: "Running WS1 task",
        status: "in_progress",
        initiative_id: "init-1",
        workstream_id: "ws-1",
        milestone_id: null,
        priority: "high",
      },
    ],
    [
      "task-ws1-blocked",
      {
        id: "task-ws1-blocked",
        title: "Blocked WS1 task",
        status: "blocked",
        initiative_id: "init-1",
        workstream_id: "ws-1",
        milestone_id: null,
        priority: "medium",
      },
    ],
    [
      "task-ws2-primary",
      {
        id: "task-ws2-primary",
        title: "Primary WS2 task",
        status: "todo",
        initiative_id: "init-1",
        workstream_id: "ws-2",
        milestone_id: null,
        priority: "low",
      },
    ],
  ]);

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters = {}) => {
      calls.listEntities.push({ type, filters });
      if (type === "initiative") {
        return {
          data: [{ id: "init-1", title: "Initiative 1", status: "active", priority: "high" }],
          pagination: { total: 1, has_more: false },
        };
      }
      if (type === "workstream") {
        return {
          data: [
            {
              id: "ws-1",
              name: "Workstream 1",
              status: "active",
              initiative_id: "init-1",
              assigned_agents: [{ id: "agent-1", name: "Agent One", domain: "engineering" }],
            },
            {
              id: "ws-2",
              name: "Workstream 2",
              status: "active",
              initiative_id: "init-1",
              assigned_agents: [{ id: "agent-2", name: "Agent Two", domain: "engineering" }],
            },
          ],
          pagination: { total: 2, has_more: false },
        };
      }
      if (type === "milestone") {
        return { data: [], pagination: { total: 0, has_more: false } };
      }
      if (type === "task") {
        const initiativeId = typeof filters.initiative_id === "string" ? filters.initiative_id : null;
        const workstreamId = typeof filters.workstream_id === "string" ? filters.workstream_id : null;
        const rows = Array.from(tasks.values()).filter((task) => {
          if (initiativeId && task.initiative_id !== initiativeId) return false;
          if (workstreamId && task.workstream_id !== workstreamId) return false;
          return true;
        });
        return { data: rows, pagination: { total: rows.length, has_more: false } };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      if (type === "task" && tasks.has(id)) {
        tasks.set(id, { ...tasks.get(id), ...updates });
      }
      return { ok: true, id };
    },
    emitActivity: async (payload) => {
      calls.emitActivity.push(payload);
      return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
    },
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: [] }),
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async () => ({ decisions: [] }),
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
    createEntity: async () => ({ ok: true, id: "ent_1" }),
    checkSpawnGuard: async () => ({
      allowed: true,
      modelTier: "sonnet",
      checks: {
        rateLimit: { passed: true, current: 1, max: 10 },
        qualityGate: { passed: true, score: 5, threshold: 3 },
        taskAssigned: { passed: true, taskId: "task-ws1-primary", status: "todo" },
      },
      blockedReason: null,
    }),
  };

  return { client, calls, tasks };
}

async function createHandler(opts = {}) {
  const config = baseConfig();
  const harness = createClientHarness(opts);
  const handler = createHttpHandler(config, harness.client, () => null, createNoopOnboarding(), undefined, {
    openclaw: {
      listAgents: async () => [
        { id: "agent-1", name: "Agent One" },
        { id: "agent-2", name: "Agent Two" },
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
  return { ...harness, handler };
}

async function readNextUp(handler) {
  const res = await call(handler, {
    method: "GET",
    url: "/orgx/api/mission-control/next-up?initiative_id=init-1",
    headers: {},
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  return body;
}

test("mission-control next-up move reorders queue to top/bottom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-move-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();

      let queue = await readNextUp(handler);
      const beforeOrder = queue.items.map((item) => item.workstreamId);
      assert.ok(beforeOrder.includes("ws-1"));
      assert.ok(beforeOrder.includes("ws-2"));

      const resBottom = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/move",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          placement: "bottom",
        }),
      });
      assert.equal(resBottom.status, 200);

      queue = await readNextUp(handler);
      const afterBottom = queue.items.map((item) => item.workstreamId);
      assert.equal(afterBottom[afterBottom.length - 1], "ws-1");

      const resTop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/move",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          placement: "top",
        }),
      });
      assert.equal(resTop.status, 200);

      queue = await readNextUp(handler);
      const afterTop = queue.items.map((item) => item.workstreamId);
      assert.equal(afterTop[0], "ws-1");
    }
  );
});

test("mission-control triage stop validates required ids and can reset tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-triage-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
    },
    async () => {
      const { handler, tasks } = await createHandler();

      const resInvalid = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/triage/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resInvalid.status, 400);

      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          agentId: "agent-1",
          workstreamIds: ["ws-1"],
        }),
      });
      assert.equal(resStart.status, 200);

      const resStop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/triage/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          placement: "top",
          resetToTodo: true,
        }),
      });
      assert.equal(resStop.status, 200);
      const stopBody = JSON.parse(resStop.body);
      assert.equal(stopBody.ok, true);
      assert.equal(stopBody.placement, "top");
      assert.equal(stopBody.resetToTodo, true);
      assert.ok(typeof stopBody.resetTaskCount === "number");

      assert.equal(tasks.get("task-ws1-running")?.status, "todo");
      assert.equal(tasks.get("task-ws1-blocked")?.status, "todo");
    }
  );
});

test("mission-control clear resets blocked/in-progress task state and persists queue order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-clear-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler, tasks } = await createHandler({ blockedQueueForWs1: true });

      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          agentId: "agent-1",
          workstreamIds: ["ws-1"],
        }),
      });
      assert.equal(resStart.status, 200);

      const resClear = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/clear",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          states: ["running", "blocked"],
          placement: "bottom",
        }),
      });
      assert.equal(resClear.status, 200);
      const body = JSON.parse(resClear.body);
      assert.equal(body.ok, true);
      assert.equal(body.placement, "bottom");
      assert.ok(body.queueItemsCleared >= 1);
      assert.ok(body.tasksReset >= 1);

      assert.equal(tasks.get("task-ws1-running")?.status, "todo");
      assert.equal(tasks.get("task-ws1-blocked")?.status, "todo");
    }
  );
});
