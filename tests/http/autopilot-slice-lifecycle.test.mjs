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
    pluginVersion: "test",
  };
}

async function call(handler, req) {
  const res = createStubResponse();
  await handler(req, res);
  return res;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
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

function createClientHarness() {
  const calls = {
    listEntities: [],
    updateEntity: [],
    applyChangeset: [],
    emitActivity: [],
    createEntity: [],
    checkSpawnGuard: [],
  };

  const state = {
    tasks: new Map([
      [
        "task-1",
        {
          id: "task-1",
          title: "Mock task",
          status: "todo",
          initiative_id: "init-1",
          workstream_id: "ws-1",
          milestone_id: null,
          priority: "high",
        },
      ],
    ]),
  };

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    listEntities: async (type, filters) => {
      calls.listEntities.push({ type, filters });
      if (type === "initiative") {
        return {
          data: [{ id: "init-1", title: "Initiative 1", status: "active" }],
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
              assigned_agents: [{ id: "agent-1", name: "Engineering Agent", domain: "engineering" }],
            },
          ],
          pagination: { total: 1, has_more: false },
        };
      }
      if (type === "milestone") {
        return {
          data: [],
          pagination: { total: 0, has_more: false },
        };
      }
      if (type === "task") {
        return {
          data: Array.from(state.tasks.values()),
          pagination: { total: 1, has_more: false },
        };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      if (type === "task" && state.tasks.has(id)) {
        const existing = state.tasks.get(id);
        state.tasks.set(id, { ...existing, ...updates });
      }
      return { ok: true, id };
    },
	    applyChangeset: async (payload) => {
	      calls.applyChangeset.push(payload);
	      try {
	        const ops = Array.isArray(payload?.operations) ? payload.operations : [];
	        for (const op of ops) {
	          if (!op || typeof op !== "object") continue;
	          if (op.op === "task.update" && typeof op.task_id === "string") {
	            const id = op.task_id;
	            if (!state.tasks.has(id)) continue;
	            const existing = state.tasks.get(id);
	            const patch = op.patch && typeof op.patch === "object" ? op.patch : {};
	            const next = { ...existing, ...patch };
	            if (typeof op.status === "string") next.status = op.status;
	            state.tasks.set(id, next);
	          }
	        }
	      } catch {
	        // ignore
	      }
      return {
        ok: true,
        changeset_id: "cs_1",
        replayed: false,
        run_id: payload?.run_id ?? "run_1",
        applied_count: Array.isArray(payload?.operations) ? payload.operations.length : 0,
        results: [],
        event_id: null,
      };
    },
    emitActivity: async (payload) => {
      calls.emitActivity.push(payload);
      return { ok: true, run_id: payload?.run_id ?? "run_1", event_id: null, reused_run: false };
    },
    createEntity: async (type, payload) => {
      calls.createEntity.push({ type, payload });
      return { ok: true, id: `ent_${type}_1` };
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
    checkSpawnGuard: async (domain, taskId) => {
      calls.checkSpawnGuard.push({ domain, taskId });
      return {
        allowed: true,
        modelTier: "sonnet",
        checks: {
          rateLimit: { passed: true, current: 1, max: 10 },
          qualityGate: { passed: true, score: 5, threshold: 3 },
          taskAssigned: { passed: true, taskId, status: "todo" },
        },
        blockedReason: null,
      };
    },
  };

  return { client, calls };
}

async function runPlayTickStatus({ scenario, extraEnv = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-"));
  return await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: scenario,
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
      ...extraEnv,
    },
    async () => {
      const config = baseConfig();
      const { client, calls } = createClientHarness();
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 200);

      // Let the worker complete (or stall) before ticking.
      await sleep(80);

      const resTick = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/tick?initiativeId=init-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resTick.status, 200);

      const resStatus = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/auto-continue/status?initiativeId=init-1",
        headers: {},
      });
      assert.equal(resStatus.status, 200);

      return {
        play: JSON.parse(resPlay.body),
        tick: JSON.parse(resTick.body),
        status: JSON.parse(resStatus.body),
        calls,
        handler,
      };
    }
  );
}

test("autopilot slice lifecycle: success registers artifact and completes run", async () => {
  const result = await runPlayTickStatus({ scenario: "success" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  assert.ok(result.calls.createEntity.some((c) => c.type === "artifact"), "expected artifact.create");
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "task.update" && op.task_id === "task-1")
    ),
    "expected task.update changeset"
  );
});

test("autopilot slice lifecycle: completed without outputs blocks and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "no_updates" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create"
  );
});

test("autopilot slice lifecycle: needs_decision blocks and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "needs_decision" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create"
  );
});

test("autopilot slice lifecycle: invalid output stops with error and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "invalid_json" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "error");
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create"
  );
});

test("autopilot slice lifecycle: worker-reported error stops with error and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "error" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "error");
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create"
  );
});

test("autopilot slice lifecycle: stalled worker is terminated and blocks run", async () => {
  const result = await runPlayTickStatus({
    scenario: "stall",
    extraEnv: {
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1000",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "5000",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "20",
    },
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  assert.ok(
    String(result.status.run?.lastError || "").toLowerCase().includes("stalled") ||
      String(result.status.run?.lastError || "").toLowerCase().includes("stall"),
    "expected stalled lastError"
  );
});

test("autopilot slice lifecycle: claude-code executor surfaces anthropic runtime provider in snapshot", async () => {
  const result = await runPlayTickStatus({
    scenario: "success",
    extraEnv: {
      ORGX_AUTOPILOT_EXECUTOR: "claude-code",
    },
  });

  const { handler } = result;
  const resSnapshot = await call(handler, {
    method: "GET",
    url: "/orgx/api/live/snapshot?sessionsLimit=20&activityLimit=20&decisionsLimit=10&initiative=init-1",
    headers: {},
  });
  assert.equal(resSnapshot.status, 200);
  const body = JSON.parse(resSnapshot.body);
  assert.ok(Array.isArray(body.runtimeInstances));
  const claude = body.runtimeInstances.find((i) => i?.sourceClient === "claude-code");
  assert.ok(claude, "expected claude-code runtime instance");
  assert.equal(claude.providerLogo, "anthropic");
});
