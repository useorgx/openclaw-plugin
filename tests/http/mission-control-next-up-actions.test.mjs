import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupAutopilotChildren() {
  try {
    const listing = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    const processes = [];
    for (const line of listing.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3] ?? "",
      });
    }

    const descendantPids = new Set([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const processInfo of processes) {
        if (
          descendantPids.has(processInfo.ppid) &&
          !descendantPids.has(processInfo.pid)
        ) {
          descendantPids.add(processInfo.pid);
          changed = true;
        }
      }
    }

    for (const { pid, command } of processes) {
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
      if (!descendantPids.has(pid)) continue;
      if (
        !command.includes("autopilot-logs/") &&
        !command.includes("mock-autopilot-slice-worker")
      ) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

test.afterEach(() => {
  cleanupAutopilotChildren();
});

test.after(async () => {
  await sleep(3_000);
  cleanupAutopilotChildren();
});

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

function createClientHarness({
  blockedQueueForWs1 = false,
  dependencyBlockedForWs1 = false,
  taskDependencyOverrides = null,
  listEntitiesImpl = null,
  rawRequestImpl = null,
} = {}) {
  const calls = {
    listEntities: [],
    updateEntity: [],
    emitActivity: [],
    rawRequest: [],
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
        status: dependencyBlockedForWs1 ? "blocked" : blockedQueueForWs1 ? "todo" : "done",
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

  if (taskDependencyOverrides && typeof taskDependencyOverrides === "object") {
    for (const [taskId, dependencyIds] of Object.entries(taskDependencyOverrides)) {
      if (!tasks.has(taskId)) continue;
      const normalizedDeps = Array.isArray(dependencyIds)
        ? dependencyIds.filter((entry) => typeof entry === "string")
        : [];
      tasks.set(taskId, {
        ...tasks.get(taskId),
        dependency_ids: normalizedDeps,
      });
    }
  }

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters = {}) => {
      calls.listEntities.push({ type, filters });
      if (typeof listEntitiesImpl === "function") {
        return await listEntitiesImpl(type, filters);
      }
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
    rawRequest: async (...args) => {
      calls.rawRequest.push(args);
      if (typeof rawRequestImpl === "function") {
        return await rawRequestImpl(...args);
      }
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

test("mission-control sentinels catalog exposes built-in engineering sentinels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-sentinels-catalog-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/sentinels?domain=engineering",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.total, 3);
      assert.deepEqual(
        body.items.map((item) => item.signal).sort(),
        ["ci_failure", "dependency_scan", "error_log"]
      );
    }
  );
});

test("mission-control sentinels catalog filters by signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-sentinels-filter-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/sentinels?domain=engineering&signal=ci_failure",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.total, 1);
      assert.equal(body.items[0]?.id, "eng.ci-failure-streak");
      assert.equal(body.items[0]?.signal, "ci_failure");
    }
  );
});

test("mission-control sentinels catalog exposes built-in sales sentinels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-sentinels-sales-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/sentinels?domain=sales",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.total, 2);
      assert.deepEqual(
        body.items.map((item) => item.id).sort(),
        ["sales.deal-stagnation", "sales.lead-response-lag"]
      );
    }
  );
});

test("mission-control sentinels catalog exposes built-in marketing sentinels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-sentinels-marketing-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/sentinels?domain=marketing",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.total, 2);
      assert.deepEqual(
        body.items.map((item) => item.id).sort(),
        ["marketing.budget-monitor", "marketing.content-performance-drop"]
      );
    }
  );
});

test("mission-control sentinels catalog exposes built-in product sentinels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-sentinels-product-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/sentinels?domain=product",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.total, 1);
      assert.deepEqual(body.items.map((item) => item.id), ["product.accessibility-audit"]);
      assert.equal(body.items[0]?.signal, "accessibility_audit");
    }
  );
});

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

test("mission-control next-up honors workspace scope aliases and never falls back to global queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-project-scope-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const baseline = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up",
        headers: {},
      });
      assert.equal(baseline.status, 200);
      const baselineBody = JSON.parse(baseline.body);
      assert.equal(baselineBody.ok, true);
      assert.ok(Array.isArray(baselineBody.items));
      assert.ok(baselineBody.items.length > 0);

      const rejectedScope = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?project_id=workspace-crane",
        headers: {},
      });
      assert.equal(rejectedScope.status, 400);

      const scopedQueries = [
        "workspace_id=workspace-crane",
        "command_center_id=workspace-crane",
        "center=workspace-crane",
      ];

      for (const query of scopedQueries) {
        const scoped = await call(handler, {
          method: "GET",
          url: `/orgx/api/mission-control/next-up?${query}`,
          headers: {},
        });
        assert.equal(scoped.status, 200);
        const scopedBody = JSON.parse(scoped.body);
        assert.equal(scopedBody.ok, true);
        assert.equal(scopedBody.total, 0);
        assert.deepEqual(scopedBody.items, []);
        assert.ok(
          Array.isArray(scopedBody.degraded) &&
            scopedBody.degraded.some((entry) =>
              String(entry).includes(
                "workspace initiative scope lookup returned no rows; local queue may be incomplete."
              )
            )
        );
      }
    }
  );
});

test("mission-control next-up re-paginates canonical payloads that ignore limit/offset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-canonical-page-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const canonicalItems = Array.from({ length: 60 }, (_, idx) => ({
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        initiativeStatus: "active",
        workstreamId: `ws-${idx + 1}`,
        workstreamTitle: `Workstream ${idx + 1}`,
        workstreamStatus: "active",
        nextTaskId: `task-${idx + 1}`,
        nextTaskTitle: `Task ${idx + 1}`,
        nextTaskPriority: idx + 1,
        nextTaskDueAt: null,
        queueState: "queued",
      }));

      const { handler, calls } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: canonicalItems.length,
            items: canonicalItems,
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=24&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.total, 60);
      assert.equal(Array.isArray(body.items), true);
      assert.equal(body.items.length, 24);
      assert.equal(body.items[0]?.workstreamId, "ws-25");
      assert.equal(body.items[23]?.workstreamId, "ws-48");
      assert.equal(body.pagination?.offset, 24);
      assert.equal(body.pagination?.limit, 24);
      assert.equal(body.pagination?.total, 60);
      assert.equal(body.pagination?.nextCursor, "48");
      assert.equal(body.pagination?.hasMore, true);
      assert.ok(calls.rawRequest.length >= 1);
    }
  );
});

test("mission-control next-up recomputes full summary totals when canonical pages under-report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-canonical-summary-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const visibleItems = Array.from({ length: 87 }, (_, idx) => ({
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        initiativeStatus: "active",
        workstreamId: `ws-visible-${idx + 1}`,
        workstreamTitle: `Visible ${idx + 1}`,
        workstreamStatus: "active",
        nextTaskId: `task-visible-${idx + 1}`,
        nextTaskTitle: `Visible task ${idx + 1}`,
        nextTaskPriority: idx + 1,
        nextTaskDueAt: null,
        queueState: "queued",
      }));
      const runningItems = Array.from({ length: 76 }, (_, idx) => ({
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        initiativeStatus: "active",
        workstreamId: `ws-running-${idx + 1}`,
        workstreamTitle: `Running ${idx + 1}`,
        workstreamStatus: "active",
        nextTaskId: `task-running-${idx + 1}`,
        nextTaskTitle: `Running task ${idx + 1}`,
        nextTaskPriority: idx + 11,
        nextTaskDueAt: null,
        queueState: "running",
      }));
      const allItems = visibleItems.concat(runningItems);
      const partialPage = allItems.slice(0, 24);
      const rawRequestPaths = [];

      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          rawRequestPaths.push(path);
          const parsed = new URL(path, "https://example.com");
          const limit = Number(parsed.searchParams.get("limit") ?? "24");
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 163,
            items: limit >= 163 ? allItems : partialPage,
            summary: {
              visibleTotal: 7,
              stateCounts: {
                queued: 7,
                running: 17,
                blocked: 0,
                idle: 0,
                completed: 0,
              },
            },
            pagination: {
              offset: 0,
              limit: 24,
              total: 163,
              hasMore: true,
              nextCursor: "24",
            },
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items.length, 24);
      assert.equal(body.summary?.visibleTotal, 87);
      assert.deepEqual(body.summary?.stateCounts, {
        queued: 87,
        running: 76,
        blocked: 0,
        idle: 0,
        completed: 0,
      });
      assert.ok(rawRequestPaths.some((entry) => entry.includes("limit=163")));
    }
  );
});

test("mission-control next-up applies noise threshold and blocked dedup controls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-noise-controls-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const generatedAt = new Date().toISOString();
      const canonicalItems = [
        {
          initiativeId: "init-1",
          initiativeTitle: "Initiative 1",
          initiativeStatus: "active",
          workstreamId: "ws-running",
          workstreamTitle: "Running WS",
          workstreamStatus: "active",
          nextTaskId: "task-running",
          nextTaskTitle: "Run now",
          nextTaskPriority: 3,
          queueState: "queued",
          updatedAt: "2026-02-27T11:00:00.000Z",
        },
        {
          initiativeId: "init-1",
          initiativeTitle: "Initiative 1",
          initiativeStatus: "active",
          workstreamId: "ws-blocked-low-1",
          workstreamTitle: "Blocked Low 1",
          workstreamStatus: "active",
          nextTaskId: "task-blocked-low-1",
          nextTaskTitle: "Blocked task 1",
          nextTaskPriority: 6,
          queueState: "blocked",
          blockReason: "Waiting on upstream review",
          updatedAt: "2026-02-27T11:00:00.000Z",
        },
        {
          initiativeId: "init-1",
          initiativeTitle: "Initiative 1",
          initiativeStatus: "active",
          workstreamId: "ws-blocked-low-2",
          workstreamTitle: "Blocked Low 2",
          workstreamStatus: "active",
          nextTaskId: "task-blocked-low-2",
          nextTaskTitle: "Blocked task 2",
          nextTaskPriority: 7,
          queueState: "blocked",
          blockReason: "Waiting on upstream review",
          updatedAt: "2026-02-27T11:00:30.000Z",
        },
        {
          initiativeId: "init-1",
          initiativeTitle: "Initiative 1",
          initiativeStatus: "active",
          workstreamId: "ws-blocked-high",
          workstreamTitle: "Blocked High",
          workstreamStatus: "active",
          nextTaskId: "task-blocked-high",
          nextTaskTitle: "Blocked high",
          nextTaskPriority: 1,
          queueState: "blocked",
          blockReason: "P1 incident mitigation",
          updatedAt: "2026-02-27T11:01:00.000Z",
        },
        {
          initiativeId: "init-1",
          initiativeTitle: "Initiative 1",
          initiativeStatus: "active",
          workstreamId: "ws-idle-low",
          workstreamTitle: "Idle Low",
          workstreamStatus: "active",
          nextTaskId: "task-idle-low",
          nextTaskTitle: "Idle low",
          nextTaskPriority: 8,
          queueState: "idle",
          updatedAt: "2026-02-27T11:01:30.000Z",
        },
      ];

      const { handler, calls } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt,
            total: canonicalItems.length,
            items: canonicalItems,
          };
        },
      });

      const mediumRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&noise_threshold=medium",
        headers: {},
      });
      assert.equal(mediumRes.status, 200);
      const mediumBody = JSON.parse(mediumRes.body);
      assert.equal(mediumBody.ok, true);
      assert.equal(mediumBody.source, "canonical");
      assert.deepEqual(
        mediumBody.items.map((item) => item.workstreamId),
        ["ws-running", "ws-blocked-high"]
      );

      const lowRes = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&noiseThreshold=low&dedupWindow=60000",
        headers: {},
      });
      assert.equal(lowRes.status, 200);
      const lowBody = JSON.parse(lowRes.body);
      assert.equal(lowBody.ok, true);
      assert.equal(lowBody.source, "canonical");
      assert.deepEqual(
        lowBody.items.map((item) => item.workstreamId),
        ["ws-running", "ws-blocked-high", "ws-blocked-low-1", "ws-idle-low"]
      );
      assert.ok(calls.rawRequest.length >= 2);
      const requestPaths = calls.rawRequest.map((entry) => String(entry?.[1] ?? ""));
      assert.ok(requestPaths.some((path) => path.includes("noise_threshold=low")));
      assert.ok(requestPaths.some((path) => path.includes("dedup_window=60000")));
    }
  );
});

test("mission-control next-up preserves canonical snake_case cursor pagination metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-pagination-snake-case-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const canonicalItems = Array.from({ length: 24 }, (_, idx) => ({
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        initiativeStatus: "active",
        workstreamId: `ws-${idx + 1}`,
        workstreamTitle: `Workstream ${idx + 1}`,
        workstreamStatus: "active",
        nextTaskId: `task-${idx + 1}`,
        nextTaskTitle: `Task ${idx + 1}`,
        nextTaskPriority: idx + 1,
        queueState: "queued",
      }));

      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: canonicalItems.length,
            items: canonicalItems,
            pagination: {
              offset: 0,
              limit: 24,
              total: 24,
              next_cursor: "cursor-24",
              has_more: true,
            },
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.pagination?.offset, 0);
      assert.equal(body.pagination?.limit, 24);
      assert.equal(body.pagination?.total, 24);
      assert.equal(body.pagination?.nextCursor, "cursor-24");
      assert.equal(body.pagination?.hasMore, true);
    }
  );
});

test("mission-control next-up canonical payload normalizes runner placeholders and dedupes agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-runner-normalization-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 2,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-placeholder",
                workstreamTitle: "Placeholder Runner WS",
                workstreamStatus: "active",
                nextTaskId: "task-placeholder",
                nextTaskTitle: "Placeholder Task",
                nextTaskPriority: 1,
                nextTaskDueAt: null,
                queueState: "queued",
                runnerAgentId: "none",
                runnerAgentName: "-",
                runnerAgents: [{ id: "default", name: "N/A" }],
                runnerSource: "inferred",
              },
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-dedupe",
                workstreamTitle: "Dedupe Runner WS",
                workstreamStatus: "active",
                nextTaskId: "task-dedupe",
                nextTaskTitle: "Dedupe Task",
                nextTaskPriority: 2,
                nextTaskDueAt: null,
                queueState: "queued",
                runnerAgentId: "agent-9",
                runnerAgentName: "Agent Nine",
                runnerAgents: [
                  { id: "agent-9", name: "Agent Nine" },
                  { id: "AGENT-9", name: "Agent Nine Duplicate" },
                  { name: "Agent Ten" },
                ],
                runnerSource: "assigned",
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");

      const placeholder = body.items.find((item) => item.workstreamId === "ws-placeholder");
      assert.ok(placeholder);
      assert.equal(placeholder.runnerAgentId, null);
      assert.equal(placeholder.runnerAgentName, "Unassigned");
      assert.deepEqual(placeholder.runnerAgents, []);
      assert.equal(placeholder.runnerSource, "fallback");

      const dedupe = body.items.find((item) => item.workstreamId === "ws-dedupe");
      assert.ok(dedupe);
      assert.equal(dedupe.runnerAgentId, "agent-9");
      assert.equal(dedupe.runnerAgentName, "Agent Nine");
      assert.deepEqual(dedupe.runnerAgents, [
        { id: "agent-9", name: "Agent Nine" },
        { id: "Agent Ten", name: "Agent Ten" },
      ]);
      assert.equal(dedupe.runnerSource, "assigned");
    }
  );
});

test("mission-control next-up normalizes canonical snake_case runner fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-runner-snake-case-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-1",
                workstreamTitle: "Workstream 1",
                workstreamStatus: "active",
                nextTaskId: "task-1",
                nextTaskTitle: "Task 1",
                nextTaskPriority: 1,
                nextTaskDueAt: null,
                queueState: "queued",
                runner_agent_id: "agent-1",
                runner_agent_name: "Agent One",
                runner_source: "assigned",
                runner_agents: [{ id: "agent-1", name: "Agent One" }],
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.runnerAgentId, "agent-1");
      assert.equal(body.items[0]?.runnerAgentName, "Agent One");
      assert.equal(body.items[0]?.runnerSource, "assigned");
      assert.deepEqual(body.items[0]?.runnerAgents, [{ id: "agent-1", name: "Agent One" }]);
    }
  );
});

test("mission-control next-up normalizes snake_case runner placeholders and falls back to unassigned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-runner-snake-case-placeholders-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                initiative_status: "active",
                workstream_id: "ws-placeholder-snake",
                workstream_title: "Workstream Placeholder Snake",
                workstream_status: "active",
                next_task_id: "task-1",
                next_task_title: "Task 1",
                next_task_priority: 1,
                queue_state: "queued",
                runner_agent_id: "main",
                runner_agent_name: "default",
                runner_source: "unknown",
                runner_agents: [{ id: "N/A", name: "none" }],
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-placeholder-snake&offset=0&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.runnerAgentId, null);
      assert.equal(body.items[0]?.runnerAgentName, "Unassigned");
      assert.equal(body.items[0]?.runnerSource, "fallback");
      assert.deepEqual(body.items[0]?.runnerAgents, []);
    }
  );
});

test("mission-control next-up parses JSON string arrays for runner and slice task fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-runner-json-strings-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-1",
                workstreamTitle: "Workstream 1",
                workstreamStatus: "active",
                nextTaskId: "task-1",
                nextTaskTitle: "Task 1",
                queueState: "queued",
                runner_agents: JSON.stringify([{ id: "agent-1", name: "Agent One" }]),
                slice_task_ids: JSON.stringify(["task-1", "task-2"]),
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.runnerAgentId, "agent-1");
      assert.equal(body.items[0]?.runnerAgentName, "Agent One");
      assert.equal(body.items[0]?.runnerSource, "inferred");
      assert.deepEqual(body.items[0]?.runnerAgents, [{ id: "agent-1", name: "Agent One" }]);
      assert.deepEqual(body.items[0]?.sliceTaskIds, ["task-1", "task-2"]);
    }
  );
});

test("mission-control next-up parses JSON string object for runner fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-runner-json-object-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-1",
                workstreamTitle: "Workstream 1",
                workstreamStatus: "active",
                nextTaskId: "task-1",
                nextTaskTitle: "Task 1",
                queueState: "queued",
                runner_agents: JSON.stringify({ id: "agent-1", name: "Agent One" }),
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.items[0]?.runnerAgentId, "agent-1");
      assert.equal(body.items[0]?.runnerAgentName, "Agent One");
      assert.equal(body.items[0]?.runnerSource, "inferred");
      assert.deepEqual(body.items[0]?.runnerAgents, [{ id: "agent-1", name: "Agent One" }]);
    }
  );
});

test("mission-control next-up normalizes canonical snake_case queue fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-queue-snake-case-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                initiative_status: "active",
                initiative_priority: "high",
                initiative_priority_num: 10,
                workstream_id: "ws-1",
                workstream_title: "Workstream 1",
                workstream_status: "active",
                next_task_id: "task-1",
                next_task_title: "Task 1",
                next_task_priority: 1,
                next_task_due_at: "2026-02-24T12:00:00.000Z",
                next_task_milestone_id: "ms-1",
                queue_state: "blocked",
                block_reason: "Waiting on dependency task-2",
                slice_scope: "TASK",
                slice_task_ids: ["task-1", "task-2"],
                slice_task_count: 2,
                slice_milestone_id: "ms-1",
                is_pinned: true,
                pinned_rank: 1,
                composite_score: 0.92,
                scoring_tier: "urgent",
                updated_at: "2026-02-24T12:30:00.000Z",
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]?.initiativeId, "init-1");
      assert.equal(body.items[0]?.workstreamId, "ws-1");
      assert.equal(body.items[0]?.nextTaskId, "task-1");
      assert.equal(body.items[0]?.queueState, "blocked");
      assert.equal(body.items[0]?.blockReason, "Waiting on dependency task-2");
      assert.equal(body.items[0]?.sliceScope, "task");
      assert.deepEqual(body.items[0]?.sliceTaskIds, ["task-1", "task-2"]);
      assert.equal(body.items[0]?.sliceTaskCount, 2);
      assert.equal(body.items[0]?.isPinned, true);
      assert.equal(body.items[0]?.pinnedRank, 1);
      assert.equal(body.items[0]?.scoringTier, "urgent");
      assert.equal(body.items[0]?.updatedAt, "2026-02-24T12:30:00.000Z");
    }
  );
});

test("mission-control next-up normalizes in_progress canonical queue state to running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-queue-state-in-progress-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                workstream_id: "ws-1",
                workstream_title: "Workstream 1",
                next_task_id: "task-1",
                next_task_title: "Task 1",
                queue_state: "in_progress",
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.queueState, "running");
    }
  );
});

test("mission-control next-up normalizes waiting_dependency canonical queue state to blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-queue-state-waiting-dependency-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                workstream_id: "ws-1",
                workstream_title: "Workstream 1",
                next_task_id: "task-1",
                next_task_title: "Task 1",
                queue_state: "waiting_dependency",
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.queueState, "blocked");
    }
  );
});

test("mission-control next-up normalizes blocked_by_dependency canonical queue state to blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-queue-state-blocked-by-dependency-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                workstream_id: "ws-1",
                workstream_title: "Workstream 1",
                next_task_id: "task-1",
                next_task_title: "Task 1",
                queue_state: "blocked_by_dependency",
              },
            ],
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items[0]?.queueState, "blocked");
    }
  );
});

test("mission-control next-up falls back to local queue when canonical next-up is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-slices-bridge-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler, calls } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          if (path.startsWith("/api/client/mission-control/next-up?")) {
            throw new Error("canonical next-up unavailable");
          }
          throw new Error(`unexpected canonical path: ${path}`);
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "local_fallback");
      assert.ok(Array.isArray(body.items));
      assert.ok(body.items.every((item) => item.queueState !== "completed"));
      assert.ok(Array.isArray(body.degraded));
      assert.ok(
        body.degraded.some((entry) =>
          String(entry).includes("canonical next-up unavailable")
        )
      );
      assert.ok(
        calls.rawRequest.every(
          ([, requestPath]) =>
            typeof requestPath === "string" &&
            !requestPath.startsWith("/api/client/mission-control/slices?")
        )
      );
    }
  );
});

test("mission-control next-up surfaces local queue failure when canonical next-up is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-slices-bridge-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler, calls } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          if (path.startsWith("/api/client/mission-control/next-up?")) {
            throw new Error("401 unauthorized");
          }
          throw new Error(`unexpected canonical path: ${path}`);
        },
        listEntitiesImpl: async () => {
          throw new Error("local queue unavailable");
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "local_fallback");
      assert.equal(body.total, 0);
      assert.deepEqual(body.items, []);
      assert.ok(Array.isArray(body.degraded));
      assert.ok(body.degraded.length > 0);
      assert.ok(
        calls.rawRequest.some(
          ([, requestPath]) =>
            typeof requestPath === "string" &&
            requestPath.startsWith("/api/client/mission-control/next-up?")
        )
      );
      assert.ok(
        calls.rawRequest.every(
          ([, requestPath]) =>
            typeof requestPath === "string" &&
            !requestPath.startsWith("/api/client/mission-control/slices?")
        )
      );
    }
  );
});

test("mission-control next-up serves stale canonical cache on transient canonical failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-next-up-stale-cache-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      let failCanonical = false;
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          if (!path.startsWith("/api/client/mission-control/next-up?")) {
            throw new Error("unexpected canonical path");
          }
          if (failCanonical) throw new Error("upstream timeout");
          return {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: 1,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-1",
                workstreamTitle: "Workstream 1",
                workstreamStatus: "active",
                nextTaskId: "task-1",
                nextTaskTitle: "Task 1",
                nextTaskPriority: 1,
                nextTaskDueAt: null,
                queueState: "queued",
              },
            ],
            pagination: {
              offset: 0,
              limit: 24,
              total: 1,
              hasMore: false,
              nextCursor: null,
            },
          };
        },
      });

      const first = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
        headers: {},
      });
      assert.equal(first.status, 200);
      const firstBody = JSON.parse(first.body);
      assert.equal(firstBody.source, "canonical");
      assert.equal(firstBody.items.length, 1);

      failCanonical = true;
      const realNow = Date.now;
      const advancedNow = realNow() + 31_000;
      Date.now = () => advancedNow;

      try {
        const second = await call(handler, {
          method: "GET",
          url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha&offset=0&limit=24",
          headers: {},
        });
        assert.equal(second.status, 200);
        const secondBody = JSON.parse(second.body);
        assert.equal(secondBody.source, "canonical_cache_stale");
        assert.equal(secondBody.items.length, 1);
        assert.ok(Array.isArray(secondBody.degraded));
        assert.ok(
          secondBody.degraded.some((entry) =>
            String(entry).toLowerCase().includes("cached canonical queue")
          )
        );
      } finally {
        Date.now = realNow;
      }
    }
  );
});

test("mission-control next-up bulk reorders and removes queue entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-bulk-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();

      let queue = await readNextUp(handler);
      assert.ok(queue.items.length >= 2);

      const resMoveTop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/bulk",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "move_top",
          items: [{ initiativeId: "init-1", workstreamId: "ws-2" }],
        }),
      });
      assert.equal(resMoveTop.status, 200);
      const moveBody = JSON.parse(resMoveTop.body);
      assert.equal(moveBody.ok, true);
      assert.equal(moveBody.updated, 1);
      assert.equal(moveBody.failed, 0);

      queue = await readNextUp(handler);
      assert.equal(queue.items[0]?.workstreamId, "ws-2");

      const resRemove = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/bulk",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          items: [
            { initiativeId: "init-1", workstreamId: "ws-2" },
            { initiativeId: "init-1", workstreamId: "ws-missing" },
          ],
        }),
      });
      assert.equal(resRemove.status, 200);
      const removeBody = JSON.parse(resRemove.body);
      assert.equal(removeBody.ok, true);
      assert.equal(removeBody.requested, 2);
      assert.equal(removeBody.updated, 1);
      assert.equal(removeBody.failed, 1);

      queue = await readNextUp(handler);
      assert.ok(!queue.items.some((item) => item.workstreamId === "ws-2"));

      const resRequeue = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/move",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-2",
          placement: "top",
        }),
      });
      assert.equal(resRequeue.status, 200);

      queue = await readNextUp(handler);
      assert.equal(queue.items[0]?.workstreamId, "ws-2");
    }
  );
});

test("mission-control next-up marks blocked workstreams with a human block reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-blocked-translation-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        blockedQueueForWs1: true,
        dependencyBlockedForWs1: true,
      });
      const queue = await readNextUp(handler);
      const blocked = queue.items.find((item) => item.workstreamId === "ws-1");
      assert.ok(blocked, "expected ws-1 queue item");
      assert.equal(blocked.queueState, "blocked");
      assert.match(String(blocked.blockReason ?? ""), /waiting on dependency ws1 task/i);
    }
  );
});

test("mission-control next-up treats needs-decision queue state as blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-needs-decision-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          return {
            ok: true,
            total: 1,
            items: [
              {
                initiative_id: "init-1",
                initiative_title: "Initiative 1",
                initiative_status: "active",
                workstream_id: "ws-1",
                workstream_title: "Workstream 1",
                workstream_status: "active",
                next_task_id: "task-ws1-running",
                next_task_title: "Running WS1 task",
                queue_state: "needs_decision",
                block_reason: "Human decision required for production incident",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        },
      });
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?workspace_id=workspace-alpha",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]?.workstreamId, "ws-1");
      assert.equal(body.items[0]?.queueState, "blocked");
      assert.equal(body.items[0]?.blockReason, "Human decision required for production incident");
    }
  );
});

test("mission-control next-up filters high-severity blockers and dedups duplicates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-nextup-noise-dedup-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async (method, path) => {
          assert.equal(method, "GET");
          assert.ok(path.startsWith("/api/client/mission-control/next-up?"));
          assert.match(path, /noise_threshold=high/);
          assert.match(path, /dedup_window=60000/);
          return {
            ok: true,
            total: 4,
            items: [
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-critical-a",
                workstreamTitle: "Critical A",
                workstreamStatus: "blocked",
                queueState: "blocked",
                blockReason: "Critical production outage",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-critical-b",
                workstreamTitle: "Critical B",
                workstreamStatus: "blocked",
                queueState: "blocked",
                blockReason: "Critical production outage",
                updatedAt: "2026-01-01T00:00:30.000Z",
              },
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-low",
                workstreamTitle: "Low",
                workstreamStatus: "blocked",
                queueState: "blocked",
                blockReason: "Waiting on dependency task-ws-low",
                updatedAt: "2026-01-01T00:01:00.000Z",
              },
              {
                initiativeId: "init-1",
                initiativeTitle: "Initiative 1",
                initiativeStatus: "active",
                workstreamId: "ws-queued",
                workstreamTitle: "Queued",
                workstreamStatus: "active",
                queueState: "queued",
                updatedAt: "2026-01-01T00:01:30.000Z",
              },
            ],
            pagination: { offset: 0, limit: 24, total: 4, hasMore: false, nextCursor: null },
          };
        },
      });

      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/next-up?initiative_id=init-1&noise_threshold=high&dedup_window=60000",
        headers: {},
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.deepEqual(
        body.items.map((item) => item.workstreamId).sort(),
        ["ws-critical-a", "ws-queued"]
      );
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
      const invalidBody = JSON.parse(resInvalid.body);
      assert.equal(invalidBody?.error_location, "mission-control.next-up.triage.stop.validation");

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

      const resAutoStop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resAutoStop.status, 200);
      await sleep(50);
      cleanupAutopilotChildren();
    }
  );
});

test("mission-control auto-continue status returns error location when initiative is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-status-error-location-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler();
      const res = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/auto-continue/status",
        headers: {},
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body?.ok, false);
      assert.equal(
        body?.error_location,
        "mission-control.read.auto-continue.status.validation"
      );
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

      const resStop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resStop.status, 200);
      await sleep(50);
      cleanupAutopilotChildren();
    }
  );
});

test("mission-control activity auto-fix schedules execution and emits lifecycle events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-activity-autofix-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
    },
    async () => {
      const { handler, calls, tasks } = await createHandler();

      const resSchedule = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/activity/auto-fix",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          runId: "run-test",
          event: "autopilot_slice_result",
          requestedByAgentId: "agent-1",
          requestedByAgentName: "Agent One",
          graceMs: 30,
        }),
      });
      assert.equal(resSchedule.status, 202);
      const scheduleBody = JSON.parse(resSchedule.body);
      assert.equal(scheduleBody.ok, true);
      assert.equal(scheduleBody.scheduled?.initiativeId, "init-1");
      assert.equal(scheduleBody.scheduled?.workstreamId, "ws-1");
      assert.equal(scheduleBody.scheduled?.graceMs, 1000);

      await sleep(1_260);

      const events = calls.emitActivity
        .map((entry) => entry?.metadata?.event)
        .filter((entry) => typeof entry === "string");
      assert.ok(events.includes("autopilot_autofix_scheduled"), "expected scheduled event");
      assert.ok(events.includes("autopilot_autofix_executed"), "expected executed event");
      assert.equal(tasks.get("task-ws1-running")?.status, "todo");
      assert.equal(tasks.get("task-ws1-blocked")?.status, "todo");

      const resStop = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resStop.status, 200);
      await sleep(50);
      cleanupAutopilotChildren();
    }
  );
});

test("mission-control activity auto-fix skips when user pauses during grace window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-activity-autofix-skip-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
    },
    async () => {
      const { handler, calls } = await createHandler();

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
        url: "/orgx/api/mission-control/auto-continue/stop",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resStop.status, 200);

      const resSchedule = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/activity/auto-fix",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          graceMs: 30,
        }),
      });
      assert.equal(resSchedule.status, 202);

      await sleep(1_260);

      const events = calls.emitActivity
        .map((entry) => entry?.metadata?.event)
        .filter((entry) => typeof entry === "string");
      assert.ok(events.includes("autopilot_autofix_scheduled"), "expected scheduled event");
      assert.ok(events.includes("autopilot_autofix_skipped"), "expected skipped event");
      assert.ok(!events.includes("autopilot_autofix_executed"), "expected no execution event");
      const skipped = calls.emitActivity.find(
        (entry) => entry?.metadata?.event === "autopilot_autofix_skipped"
      );
      assert.equal(skipped?.metadata?.reason, "paused_by_user");
    }
  );
});

test("mission-control dependency cycle auto-fix applies cycle diagnostics updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-cycle-autofix-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
    },
    async () => {
      const { handler, calls } = await createHandler({
        taskDependencyOverrides: {
          "task-ws1-primary": ["task-ws1-dependency"],
          "task-ws1-dependency": ["task-ws1-primary"],
        },
      });

      const res = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/graph/cycles/auto-fix",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });

      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.ok(body.cycleEdgesDetected >= 1);
      assert.ok(body.nodesUpdated >= 1);
      assert.ok(Array.isArray(body.scheduledAutofixes));
      assert.ok(
        calls.updateEntity.some(
          (entry) =>
            entry.type === "task" &&
            Array.isArray(entry.updates?.dependency_ids)
        )
      );
    }
  );
});

test("mission-control slices reorder proxies to canonical client API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-slices-reorder-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler, calls } = await createHandler({
        rawRequestImpl: async (_method, path, body) => {
          assert.equal(path, "/api/client/mission-control/slices/reorder");
          return {
            ok: true,
            level: body.level,
            order: body.order ?? [],
          };
        },
      });

      const res = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/slices/reorder?workspace_id=workspace-crane",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          level: "workstream",
          order: [{ sliceId: "workstream:ws-2" }, { sliceId: "workstream:ws-1" }],
        }),
      });

      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, "canonical");
      assert.equal(calls.rawRequest.length, 1);
    }
  );
});

test("mission-control slices order-mode returns 503 when canonical API is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-slices-order-mode-down-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
    },
    async () => {
      const { handler } = await createHandler({
        rawRequestImpl: async () => {
          throw new Error("upstream unavailable");
        },
      });

      const res = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/slices/order-mode",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          level: "task",
          order_mode: "manual",
        }),
      });

      assert.equal(res.status, 503);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, false);
      assert.equal(body.canonical_only, true);
      assert.ok(Array.isArray(body.degraded));
      assert.ok(String(body.degraded[0]).includes("canonical unavailable"));
    }
  );
});
