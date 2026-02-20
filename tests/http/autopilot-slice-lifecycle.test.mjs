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
    decisions: new Map(),
    activities: [],
    nextDecisionId: 1,
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
	          } else if (op.op === "decision.create") {
	            const id = `decision-${state.nextDecisionId++}`;
	            const now = new Date().toISOString();
	            const blocking = typeof op.blocking === "boolean" ? op.blocking : true;
	            const options = Array.isArray(op.options)
	              ? op.options.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
	              : [];
	            const summary =
	              typeof op.summary === "string" && op.summary.trim().length > 0
	                ? op.summary.trim()
	                : null;
	            const title =
	              typeof op.title === "string" && op.title.trim().length > 0
	                ? op.title.trim()
	                : "Decision";
	            state.decisions.set(id, {
	              id,
	              title,
	              summary,
	              context: summary,
	              status: "pending",
	              decision_status: "pending",
	              blocking,
	              options,
	              initiative_id:
	                typeof payload?.initiative_id === "string"
	                  ? payload.initiative_id
	                  : "init-1",
	              created_at: now,
	              updated_at: now,
	              metadata: {
	                source: "test_changeset",
	                blocking,
	                correlation_id:
	                  typeof payload?.correlation_id === "string"
	                    ? payload.correlation_id
	                    : null,
	                run_id:
	                  typeof payload?.run_id === "string"
	                    ? payload.run_id
	                    : null,
	              },
	            });
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
      const timestamp = new Date().toISOString();
      const metadata =
        payload?.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : {};
      state.activities.push({
        id: `activity-${state.activities.length + 1}`,
        type:
          payload?.phase === "completed"
            ? "run_completed"
            : payload?.phase === "blocked"
              ? "run_failed"
              : "run_started",
        title: payload?.message ?? "",
        description: payload?.next_step ?? null,
        agentId:
          typeof metadata.agent_id === "string" ? metadata.agent_id : null,
        agentName:
          typeof metadata.agent_name === "string" ? metadata.agent_name : null,
        requesterAgentId:
          typeof metadata.requested_by_agent_id === "string"
            ? metadata.requested_by_agent_id
            : null,
        requesterAgentName:
          typeof metadata.requested_by_agent_name === "string"
            ? metadata.requested_by_agent_name
            : null,
        executorAgentId:
          typeof metadata.agent_id === "string" ? metadata.agent_id : null,
        executorAgentName:
          typeof metadata.agent_name === "string" ? metadata.agent_name : null,
        runId:
          (typeof payload?.run_id === "string" && payload.run_id.trim().length > 0
            ? payload.run_id.trim()
            : null) ??
          (typeof payload?.correlation_id === "string" &&
          payload.correlation_id.trim().length > 0
            ? payload.correlation_id.trim()
            : null),
        initiativeId:
          typeof payload?.initiative_id === "string"
            ? payload.initiative_id
            : null,
        timestamp,
        phase: payload?.phase ?? "execution",
        summary:
          typeof payload?.next_step === "string"
            ? payload.next_step
            : payload?.message ?? null,
        kind:
          typeof metadata.activity_bucket === "string"
            ? metadata.activity_bucket
            : null,
        metadata,
      });
      return { ok: true, run_id: payload?.run_id ?? "run_1", event_id: null, reused_run: false };
    },
    createEntity: async (type, payload) => {
      calls.createEntity.push({ type, payload });
      return { ok: true, id: `ent_${type}_1` };
    },
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async (filters = {}) => {
      const run = typeof filters?.run === "string" ? filters.run.trim() : "";
      const since = typeof filters?.since === "string" ? filters.since.trim() : "";
      const limit =
        typeof filters?.limit === "number" && Number.isFinite(filters.limit)
          ? Math.max(1, Math.floor(filters.limit))
          : null;
      let rows = state.activities.slice();
      if (run) {
        rows = rows.filter((entry) => entry.runId === run);
      }
      if (since) {
        const sinceEpoch = Date.parse(since);
        if (Number.isFinite(sinceEpoch)) {
          rows = rows.filter((entry) => Date.parse(entry.timestamp) > sinceEpoch);
        }
      }
      rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      if (limit) rows = rows.slice(0, limit);
      return { activities: rows };
    },
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async (filters = {}) => {
      const statusFilter =
        typeof filters?.status === "string" ? filters.status.trim().toLowerCase() : "";
      const limit =
        typeof filters?.limit === "number" && Number.isFinite(filters.limit)
          ? Math.max(1, Math.floor(filters.limit))
          : null;
      let rows = Array.from(state.decisions.values());
      if (statusFilter) {
        rows = rows.filter(
          (entry) => String(entry?.status ?? "").trim().toLowerCase() === statusFilter
        );
      }
      rows.sort((a, b) => Date.parse(String(b.updated_at ?? "")) - Date.parse(String(a.updated_at ?? "")));
      if (limit) rows = rows.slice(0, limit);
      return { decisions: rows };
    },
    bulkDecideDecisions: async (ids, action, note) => {
      const normalizedAction =
        typeof action === "string" ? action.trim().toLowerCase() : "";
      const nextStatus =
        normalizedAction === "approve"
          ? "approved"
          : normalizedAction === "reject"
            ? "rejected"
            : normalizedAction === "cancel"
              ? "cancelled"
              : null;
      const updated = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        if (!state.decisions.has(id) || !nextStatus) continue;
        const existing = state.decisions.get(id);
        const now = new Date().toISOString();
        const next = {
          ...existing,
          status: nextStatus,
          decision_status: nextStatus,
          updated_at: now,
          note: typeof note === "string" ? note : null,
        };
        state.decisions.set(id, next);
        updated.push(next);
      }
      return updated;
    },
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

  return { client, calls, state };
}

async function runPlayTickStatus({
  scenario,
  initiativeId = "init-1",
  extraEnv = {},
  configureHarness = null,
  after = null,
  waitMs = 80,
}) {
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
      const { client, calls, state } = createClientHarness();
      if (typeof configureHarness === "function") {
        await configureHarness({ client, calls, state });
      }
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resPlay = await call(handler, {
        method: "POST",
        url: `/orgx/api/mission-control/next-up/play?initiativeId=${encodeURIComponent(initiativeId)}&workstreamId=ws-1&agentId=agent-1`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId, workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 200);

      // Let the worker complete (or stall) before ticking.
      await sleep(waitMs);

      const resTick = await call(handler, {
        method: "POST",
        url: `/orgx/api/mission-control/auto-continue/tick?initiativeId=${encodeURIComponent(initiativeId)}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId }),
      });
      assert.equal(resTick.status, 200);

      const resStatus = await call(handler, {
        method: "GET",
        url: `/orgx/api/mission-control/auto-continue/status?initiativeId=${encodeURIComponent(initiativeId)}`,
        headers: {},
      });
      assert.equal(resStatus.status, 200);

      const afterResult = typeof after === "function" ? await after({ handler, calls }) : null;

      return {
        play: JSON.parse(resPlay.body),
        tick: JSON.parse(resTick.body),
        status: JSON.parse(resStatus.body),
        calls,
        state,
        handler,
        afterResult,
      };
    }
  );
}

function listDecisionCreateOps(calls) {
  return calls.applyChangeset
    .flatMap((entry) => (Array.isArray(entry.operations) ? entry.operations : []))
    .filter((op) => op?.op === "decision.create");
}

function latestSliceResultActivity(calls) {
  for (let i = calls.emitActivity.length - 1; i >= 0; i -= 1) {
    const payload = calls.emitActivity[i];
    if (payload?.metadata?.event === "autopilot_slice_result") {
      return payload;
    }
  }
  return null;
}

function latestAutoContinueStoppedActivity(calls) {
  for (let i = calls.emitActivity.length - 1; i >= 0; i -= 1) {
    const payload = calls.emitActivity[i];
    if (payload?.metadata?.event === "auto_continue_stopped") {
      return payload;
    }
  }
  return null;
}

async function readLiveSnapshot(handler, input = {}) {
  const initiativeId =
    typeof input.initiativeId === "string" && input.initiativeId.trim().length > 0
      ? input.initiativeId.trim()
      : "init-1";
  const sessionsLimit =
    typeof input.sessionsLimit === "number" && Number.isFinite(input.sessionsLimit)
      ? Math.max(1, Math.floor(input.sessionsLimit))
      : 20;
  const activityLimit =
    typeof input.activityLimit === "number" && Number.isFinite(input.activityLimit)
      ? Math.max(1, Math.floor(input.activityLimit))
      : 50;
  const decisionsLimit =
    typeof input.decisionsLimit === "number" && Number.isFinite(input.decisionsLimit)
      ? Math.max(1, Math.floor(input.decisionsLimit))
      : 10;

  const resSnapshot = await call(handler, {
    method: "GET",
    url: `/orgx/api/live/snapshot?sessionsLimit=${sessionsLimit}&activityLimit=${activityLimit}&decisionsLimit=${decisionsLimit}&initiative=${encodeURIComponent(initiativeId)}`,
    headers: {},
  });
  assert.equal(resSnapshot.status, 200);
  return JSON.parse(resSnapshot.body);
}

function findSnapshotActivityByEvent(snapshot, eventName) {
  if (!snapshot || !Array.isArray(snapshot.activity)) return null;
  for (const entry of snapshot.activity) {
    const event = entry?.metadata?.event;
    if (typeof event === "string" && event === eventName) return entry;
  }
  return null;
}

test("autopilot slice lifecycle: success registers artifact and completes run", async () => {
  const result = await runPlayTickStatus({ scenario: "success" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  const artifactCreate = result.calls.createEntity.find((c) => c.type === "artifact");
  assert.ok(artifactCreate, "expected artifact.create");
  assert.equal(artifactCreate.payload?.entity_type, "initiative");
  assert.equal(artifactCreate.payload?.entity_id, "init-1");
  assert.equal(artifactCreate.payload?.initiative_id, "init-1");
  assert.equal(artifactCreate.payload?.name, "Mock deliverable");
  assert.equal(artifactCreate.payload?.artifact_type, "document");
  assert.equal(artifactCreate.payload?.created_by_type, "human");
  assert.ok(typeof artifactCreate.payload?.artifact_url === "string" && artifactCreate.payload.artifact_url.includes("/artifacts/"));
  assert.ok(
    result.calls.applyChangeset.some((c) =>
      Array.isArray(c.operations) && c.operations.some((op) => op.op === "task.update" && op.task_id === "task-1")
    ),
    "expected task.update changeset"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "completed");
  assert.ok(
    typeof sliceResult.metadata?.run_id === "string" && sliceResult.metadata.run_id.length > 0,
    "expected run_id linkage on slice result metadata"
  );
  assert.equal(
    sliceResult.metadata?.slice_run_id,
    sliceResult.metadata?.run_id,
    "expected slice_run_id to mirror run_id"
  );
  assert.equal(
    sliceResult.metadata?.initiative_id,
    "init-1",
    "expected initiative_id linkage on slice result metadata"
  );
  assert.ok(
    typeof sliceResult.metadata?.requested_by_agent_id === "string" &&
      sliceResult.metadata.requested_by_agent_id.length > 0,
    "expected requester agent id on slice result metadata"
  );
  assert.ok(
    typeof sliceResult.metadata?.requested_by_agent_name === "string" &&
      sliceResult.metadata.requested_by_agent_name.length > 0,
    "expected requester agent name on slice result metadata"
  );
  assert.ok(
    typeof sliceResult.metadata?.agent_id === "string" && sliceResult.metadata.agent_id.length > 0,
    "expected executing agent id on slice result metadata"
  );
  assert.ok(
    typeof sliceResult.metadata?.agent_name === "string" && sliceResult.metadata.agent_name.length > 0,
    "expected executing agent name on slice result metadata"
  );
  assert.equal(sliceResult.metadata?.decision_required, false);
  assert.equal(sliceResult.metadata?.activity_bucket, "artifact");
});

test(
  "autopilot slice lifecycle: default token budget is not enforced unless explicitly configured",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-default-budget-"));
    await withEnv(
      {
        ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
        ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
        ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
        ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
        ORGX_AUTO_CONTINUE_TOKEN_BUDGET: null,
        ORGX_AUTO_CONTINUE_ENFORCE_TOKEN_BUDGET: null,
      },
      async () => {
        const config = baseConfig();
        const { client, state } = createClientHarness();
        state.tasks.set("task-2", {
          id: "task-2",
          title: "Mock task 2",
          status: "todo",
          initiative_id: "init-1",
          workstream_id: "ws-1",
          milestone_id: null,
          priority: "high",
        });

        const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
        const resStart = await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/start",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initiativeId: "init-1",
            agentId: "agent-1",
            includeVerification: false,
            workstreamIds: ["ws-1"],
            ignoreSpawnGuardRateLimit: true,
          }),
        });
        assert.equal(resStart.status, 200);

        let statusBody = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(35);
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
          statusBody = JSON.parse(resStatus.body);
          if (statusBody?.run?.status === "stopped") break;
        }

        assert.ok(statusBody?.run, "expected auto-continue status payload");
        assert.equal(statusBody.run.status, "stopped");
        assert.equal(statusBody.run.stopReason, "completed");
        assert.equal(statusBody.run.tokenBudget ?? null, null);
      }
    );
  }
);

test(
  "autopilot slice lifecycle: legacy enforce flag no longer auto-enables token budget",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-legacy-enforce-flag-"));
    await withEnv(
      {
        ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
        ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
        ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
        ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
        ORGX_AUTO_CONTINUE_TOKEN_BUDGET: null,
        ORGX_AUTO_CONTINUE_ENFORCE_TOKEN_BUDGET: "1",
      },
      async () => {
        const config = baseConfig();
        const { client, state } = createClientHarness();
        state.tasks.set("task-2", {
          id: "task-2",
          title: "Mock task 2",
          status: "todo",
          initiative_id: "init-1",
          workstream_id: "ws-1",
          milestone_id: null,
          priority: "high",
        });

        const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
        const resStart = await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/start",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initiativeId: "init-1",
            agentId: "agent-1",
            includeVerification: false,
            workstreamIds: ["ws-1"],
            ignoreSpawnGuardRateLimit: true,
          }),
        });
        assert.equal(resStart.status, 200);

        let statusBody = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(35);
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
          statusBody = JSON.parse(resStatus.body);
          if (statusBody?.run?.status === "stopped") break;
        }

        assert.ok(statusBody?.run, "expected auto-continue status payload");
        assert.equal(statusBody.run.status, "stopped");
        assert.equal(statusBody.run.stopReason, "completed");
        assert.equal(statusBody.run.tokenBudget ?? null, null);
      }
    );
  }
);

test(
  "autopilot slice lifecycle: explicit token budget is still enforced",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-explicit-budget-"));
    await withEnv(
      {
        ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
        ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
        ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
        ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
      },
      async () => {
        const config = baseConfig();
        const { client, state } = createClientHarness();
        state.tasks.set("task-2", {
          id: "task-2",
          title: "Mock task 2",
          status: "todo",
          initiative_id: "init-1",
          workstream_id: "ws-1",
          milestone_id: null,
          priority: "high",
        });

        const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
        const resStart = await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/start",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initiativeId: "init-1",
            agentId: "agent-1",
            tokenBudget: 1000,
            includeVerification: false,
            workstreamIds: ["ws-1"],
            ignoreSpawnGuardRateLimit: true,
          }),
        });
        assert.equal(resStart.status, 200);

        let statusBody = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(35);
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
          statusBody = JSON.parse(resStatus.body);
          if (statusBody?.run?.status === "stopped") break;
        }

        assert.ok(statusBody?.run, "expected auto-continue status payload");
        assert.equal(statusBody.run.status, "stopped");
        assert.equal(statusBody.run.stopReason, "budget_exhausted");
        assert.equal(statusBody.run.tokenBudget, 1000);
      }
    );
  }
);

test(
  "autopilot slice lifecycle: restart clears stale explicit token budget when omitted",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-restart-budget-reset-"));
    await withEnv(
      {
        ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
        ORGX_AUTOPILOT_WORKER_KIND: "mock",
        ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
        ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
        ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
        ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
        ORGX_AUTO_CONTINUE_TOKEN_BUDGET: null,
        ORGX_AUTO_CONTINUE_ENFORCE_TOKEN_BUDGET: null,
      },
      async () => {
        const config = baseConfig();
        const { client, state } = createClientHarness();
        state.tasks.set("task-2", {
          id: "task-2",
          title: "Mock task 2",
          status: "todo",
          initiative_id: "init-1",
          workstream_id: "ws-1",
          milestone_id: null,
          priority: "high",
        });

        const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

        const resStartWithBudget = await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/start",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initiativeId: "init-1",
            agentId: "agent-1",
            tokenBudget: 1000,
            includeVerification: false,
            workstreamIds: ["ws-1"],
            ignoreSpawnGuardRateLimit: true,
          }),
        });
        assert.equal(resStartWithBudget.status, 200);

        let firstStatusBody = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(35);
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
          firstStatusBody = JSON.parse(resStatus.body);
          if (firstStatusBody?.run?.status === "stopped") break;
        }

        assert.ok(firstStatusBody?.run, "expected first run status payload");
        assert.equal(firstStatusBody.run.status, "stopped");
        assert.equal(firstStatusBody.run.stopReason, "budget_exhausted");
        assert.equal(firstStatusBody.run.tokenBudget, 1000);

        const resRestartWithoutBudget = await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/start",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initiativeId: "init-1",
            agentId: "agent-1",
            includeVerification: false,
            workstreamIds: ["ws-1"],
            ignoreSpawnGuardRateLimit: true,
          }),
        });
        assert.equal(resRestartWithoutBudget.status, 200);
        const restartBody = JSON.parse(resRestartWithoutBudget.body);
        assert.equal(restartBody?.run?.tokenBudget ?? null, null);

        let secondStatusBody = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(35);
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
          secondStatusBody = JSON.parse(resStatus.body);
          if (secondStatusBody?.run?.status === "stopped") break;
        }

        assert.ok(secondStatusBody?.run, "expected second run status payload");
        assert.equal(secondStatusBody.run.status, "stopped");
        assert.equal(secondStatusBody.run.stopReason, "completed");
        assert.equal(secondStatusBody.run.tokenBudget ?? null, null);
      }
    );
  }
);

test("autopilot slice lifecycle: completed without outputs blocks and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "no_updates" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected decision.create");
  assert.ok(
    decisionOps.some((op) => String(op.title ?? "").toLowerCase().includes("needs verification")),
    "expected verification follow-up decision"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "completed");
  assert.equal(sliceResult.metadata?.decision_required, false);
  assert.equal(sliceResult.metadata?.activity_bucket, "message");
  const stoppedActivity = latestAutoContinueStoppedActivity(result.calls);
  assert.ok(stoppedActivity, "expected auto_continue_stopped activity");
  assert.equal(stoppedActivity.metadata?.decision_required, true);
  assert.match(String(stoppedActivity.message ?? ""), /awaiting decision/i);
});

test("autopilot slice lifecycle: needs_decision blocks and requests decision", async () => {
  const result = await runPlayTickStatus({ scenario: "needs_decision" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected decision.create");
  assert.ok(
    decisionOps.some((op) => op.blocking === true),
    "expected blocking decision in needs_decision path"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "needs_decision");
  assert.equal(sliceResult.metadata?.blocking_decisions, 1);
  assert.equal(sliceResult.metadata?.non_blocking_decisions, 0);
  assert.equal(sliceResult.metadata?.decision_required, true);
  assert.equal(sliceResult.metadata?.activity_bucket, "decision");
});

test("autopilot slice lifecycle: behavior config approval gate blocks before dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-approval-gate-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        behavior_config_id: "default",
        behavior_config_version: "v1",
        behavior_approval_status: "pending",
        behavior_requires_approval: true,
      });

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 409);

      assert.equal(calls.checkSpawnGuard.length, 0, "spawn guard should not run before approval gate");
      const decisionOps = listDecisionCreateOps(calls);
      assert.ok(decisionOps.length > 0, "expected decision.create");
      assert.ok(
        decisionOps.some(
          (op) =>
            op.blocking === true &&
            String(op.title ?? "").toLowerCase().includes("approve behavior config")
        ),
        "expected blocking config-approval decision"
      );
      const gateActivity = calls.emitActivity.find(
        (payload) => payload?.metadata?.event === "auto_continue_behavior_config_approval_required"
      );
      assert.ok(gateActivity, "expected approval gate activity");
    }
  );
});

test("autopilot slice lifecycle: behavior config approval gate normalizes in-review status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-approval-review-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        behavior_config_id: "default",
        behavior_config_version: "v1",
        behavior_approval_status: "In Review",
        behavior_requires_approval: true,
      });
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 409);

      assert.equal(calls.checkSpawnGuard.length, 0, "spawn guard should not run before approval gate");
      const decisionOps = listDecisionCreateOps(calls);
      assert.ok(decisionOps.length > 0, "expected decision.create");
      assert.ok(
        decisionOps.some((op) => op.blocking === true),
        "expected blocking decision for in-review status"
      );
    }
  );
});

test("autopilot slice lifecycle: behavior config drift emits alert and continues dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-config-drift-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        behavior_config_id: "default",
        behavior_config_version: "v1",
        behavior_config_hash: "task-hash",
        policy_source: "workstream_override",
        behavior_context: "Always run targeted checks only.",
        automation_level: "auto",
      });

      const originalListEntities = client.listEntities;
      client.listEntities = async (type, filters) => {
        const result = await originalListEntities(type, filters);
        if (type !== "workstream") return result;
        return {
          ...result,
          data: (Array.isArray(result?.data) ? result.data : []).map((entry) =>
            entry?.id === "ws-1"
                ? {
                  ...entry,
                  behavior_config_id: "default",
                  behavior_config_version: "v1",
                  behavior_config_hash: "workstream-hash",
                  policy_source: "Workstream Override",
                  behavior_context: "Always run   targeted checks only.",
                  automation_level: "auto",
                }
              : entry
          ),
        };
      };

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.ok([200, 202].includes(resPlay.status), `expected successful dispatch, got ${resPlay.status}`);

      const driftActivity = calls.emitActivity.find(
        (payload) => payload?.metadata?.event === "auto_continue_behavior_config_drift_detected"
      );
      assert.ok(driftActivity, "expected behavior config drift alert activity");
      const driftFields = Array.isArray(driftActivity?.metadata?.drift_fields)
        ? driftActivity.metadata.drift_fields
        : [];
      assert.ok(driftFields.includes("hash"), "expected hash drift field");
      assert.ok(
        !driftFields.includes("policy_source"),
        "expected no policy_source drift for equivalent formatting differences"
      );
    }
  );
});

test("autopilot slice lifecycle: task-only behavior config does not emit drift without declared workstream config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-config-drift-task-only-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        behavior_config_id: "task-specific",
        behavior_config_version: "v2",
        behavior_config_hash: "task-hash",
        behavior_context: "Task-level override.",
        automation_level: "auto",
      });

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.ok([200, 202].includes(resPlay.status), `expected successful dispatch, got ${resPlay.status}`);

      const driftActivity = calls.emitActivity.find(
        (payload) => payload?.metadata?.event === "auto_continue_behavior_config_drift_detected"
      );
      assert.equal(driftActivity, undefined, "expected no drift alert without declared workstream config");
    }
  );
});

test("autopilot slice lifecycle: manual automation level blocks auto-continue dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-manual-mode-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        automation_level: "manual",
      });

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start?initiativeId=init-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", agentId: "agent-1" }),
      });
      assert.equal(resStart.status, 200);

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
      const statusBody = JSON.parse(resStatus.body);
      assert.equal(statusBody?.run?.status, "stopped");
      assert.equal(statusBody?.run?.stopReason, "blocked");
      assert.equal(calls.checkSpawnGuard.length, 0, "manual mode should not reach spawn guard");
      const decisionOps = listDecisionCreateOps(calls);
      assert.ok(decisionOps.length > 0, "expected blocking decision for manual mode");
      assert.ok(
        decisionOps.some(
          (op) =>
            op.blocking === true &&
            String(op.title ?? "").toLowerCase().includes("manual dispatch required")
        ),
        "expected manual-dispatch decision title"
      );
      const blockedActivity = calls.emitActivity.find(
        (payload) => payload?.metadata?.event === "auto_continue_behavior_automation_manual_blocked"
      );
      assert.ok(blockedActivity, "expected manual automation-level block activity");
    }
  );
});

test("autopilot slice lifecycle: supervised automation level stops after one dispatched slice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-supervised-mode-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      const existing = state.tasks.get("task-1");
      assert.ok(existing, "expected seeded task");
      state.tasks.set("task-1", {
        ...existing,
        automation_level: "supervised",
      });
      state.tasks.set("task-2", {
        id: "task-2",
        title: "Second task waits for first completion",
        status: "todo",
        initiative_id: "init-1",
        workstream_id: "ws-1",
        milestone_id: null,
        priority: "high",
        depends_on: ["task-1"],
      });

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start?initiativeId=init-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", agentId: "agent-1" }),
      });
      assert.equal(resStart.status, 200);

      let statusBody = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
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
        statusBody = JSON.parse(resStatus.body);
        if (statusBody?.run?.status === "stopped") break;
        await sleep(120);
      }

      assert.ok(statusBody?.run, "expected status payload");
      assert.equal(statusBody.run.status, "stopped");
      assert.equal(statusBody.run.stopReason, "completed");
      assert.equal(state.tasks.get("task-2")?.status, "todo");
      const dispatchedCount = calls.emitActivity.filter(
        (payload) => payload?.metadata?.event === "autopilot_slice_dispatched"
      ).length;
      assert.equal(dispatchedCount, 1, "supervised mode should dispatch only one slice per run");
    }
  );
});

test("autopilot slice lifecycle: blocked without decisions synthesizes fallback blocking decision", async () => {
  const result = await runPlayTickStatus({
    scenario: "blocked_no_decision",
    after: async ({ handler }) => await readLiveSnapshot(handler),
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected fallback decision.create");
  assert.ok(
    decisionOps.some((op) => op.blocking === true),
    "expected fallback blocking decision for blocked_no_decision"
  );
  const snapshot = result.afterResult;
  assert.ok(snapshot && typeof snapshot === "object", "expected live snapshot payload");
  assert.ok(Array.isArray(snapshot.decisions), "expected snapshot decisions list");
  const pendingDecision = snapshot.decisions.find(
    (entry) =>
      entry?.status === "pending" &&
      String(entry?.title ?? "")
        .toLowerCase()
        .includes("autopilot slice blocked")
  );
  assert.ok(pendingDecision, "expected synthesized blocking decision in snapshot");
  const stopped = findSnapshotActivityByEvent(snapshot, "auto_continue_stopped");
  assert.ok(stopped, "expected auto_continue_stopped in snapshot activity");
  assert.equal(stopped.metadata?.stop_reason, "blocked");
  assert.equal(stopped.metadata?.decision_required, true);
});

test("autopilot slice lifecycle: needs_decision translates to decision-first snapshot state", async () => {
  const result = await runPlayTickStatus({
    scenario: "needs_decision",
    after: async ({ handler }) => await readLiveSnapshot(handler),
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  const snapshot = result.afterResult;
  assert.ok(snapshot && typeof snapshot === "object", "expected live snapshot payload");
  assert.ok(Array.isArray(snapshot.decisions), "expected snapshot decisions list");
  const pendingDecision = snapshot.decisions.find(
    (entry) =>
      entry?.status === "pending" &&
      String(entry?.title ?? "")
        .toLowerCase()
        .includes("approve mock slice changes")
  );
  assert.ok(pendingDecision, "expected blocking decision in snapshot decisions");
  const sliceResult = findSnapshotActivityByEvent(snapshot, "autopilot_slice_result");
  assert.ok(sliceResult, "expected autopilot_slice_result in snapshot activity");
  assert.equal(sliceResult.kind, "decision");
  assert.equal(sliceResult.metadata?.decision_required, true);
  const stopped = findSnapshotActivityByEvent(snapshot, "auto_continue_stopped");
  assert.ok(stopped, "expected auto_continue_stopped in snapshot activity");
  assert.equal(stopped.kind, "decision");
  assert.equal(stopped.metadata?.stop_reason, "blocked");
  assert.equal(stopped.metadata?.decision_required, true);
});

test("autopilot slice lifecycle: needs_decision + non-blocking decisions stays completed", async () => {
  const result = await runPlayTickStatus({ scenario: "needs_decision_optional" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected decision.create");
  assert.ok(
    decisionOps.every((op) => op.blocking === false),
    "expected optional decisions to remain non-blocking"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "completed");
  assert.equal(sliceResult.metadata?.blocking_decisions, 0);
  assert.equal(sliceResult.metadata?.non_blocking_decisions, 1);
  assert.equal(sliceResult.metadata?.decision_required, false);
  assert.equal(sliceResult.metadata?.activity_bucket, "artifact");
});

test("autopilot slice lifecycle: completed + non-blocking decision stays completed", async () => {
  const result = await runPlayTickStatus({ scenario: "completed_optional_decision" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected optional decision.create");
  assert.ok(
    decisionOps.every((op) => op.blocking === false),
    "expected all optional decisions to be non-blocking"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "completed");
  assert.equal(sliceResult.metadata?.decisions, 1);
  assert.equal(sliceResult.metadata?.blocking_decisions, 0);
  assert.equal(sliceResult.metadata?.non_blocking_decisions, 1);
  assert.equal(sliceResult.metadata?.decision_required, false);
  assert.equal(sliceResult.metadata?.activity_bucket, "artifact");
});

test("autopilot slice lifecycle: completed + unspecified decision defaults to non-blocking", async () => {
  const result = await runPlayTickStatus({ scenario: "completed_unspecified_decision" });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  const decisionOps = listDecisionCreateOps(result.calls);
  assert.ok(decisionOps.length > 0, "expected decision.create");
  assert.ok(
    decisionOps.every((op) => op.blocking === false),
    "expected decisions without explicit blocking to default to non-blocking on completed status"
  );
  const sliceResult = latestSliceResultActivity(result.calls);
  assert.ok(sliceResult, "expected autopilot_slice_result activity");
  assert.equal(sliceResult.metadata?.parsed_status, "completed");
  assert.equal(sliceResult.metadata?.blocking_decisions, 0);
  assert.equal(sliceResult.metadata?.non_blocking_decisions, 1);
  assert.equal(sliceResult.metadata?.decision_required, false);
  assert.equal(sliceResult.metadata?.activity_bucket, "artifact");
});

test("autopilot slice lifecycle: buffered artifact activity preserves requester/executor provenance", async () => {
  const result = await runPlayTickStatus({
    scenario: "success",
    configureHarness: async ({ client }) => {
      client.createEntity = async () => {
        throw new Error("503 upstream artifact endpoint unavailable");
      };
    },
    after: async ({ handler }) => {
      const resSnapshot = await call(handler, {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=20&activityLimit=50&decisionsLimit=10&initiative=init-1",
        headers: {},
      });
      assert.equal(resSnapshot.status, 200);
      return JSON.parse(resSnapshot.body);
    },
  });

  const localBufferedArtifact =
    result.afterResult?.activity?.find(
      (item) => item?.metadata?.event === "autopilot_slice_artifact_buffered"
    ) ?? null;

  assert.ok(localBufferedArtifact, "expected local buffered artifact activity");
  assert.ok(
    typeof localBufferedArtifact.agentId === "string" && localBufferedArtifact.agentId.length > 0,
    "expected fallback artifact activity agentId"
  );
  assert.ok(
    typeof localBufferedArtifact.agentName === "string" && localBufferedArtifact.agentName.length > 0,
    "expected fallback artifact activity agentName"
  );
  assert.ok(
    typeof localBufferedArtifact.requesterAgentId === "string" &&
      localBufferedArtifact.requesterAgentId.length > 0,
    "expected requesterAgentId on buffered artifact activity"
  );
  assert.ok(
    typeof localBufferedArtifact.requesterAgentName === "string" &&
      localBufferedArtifact.requesterAgentName.length > 0,
    "expected requesterAgentName on buffered artifact activity"
  );
  assert.ok(
    typeof localBufferedArtifact.executorAgentId === "string" &&
      localBufferedArtifact.executorAgentId.length > 0,
    "expected executorAgentId on buffered artifact activity"
  );
  assert.ok(
    typeof localBufferedArtifact.executorAgentName === "string" &&
      localBufferedArtifact.executorAgentName.length > 0,
    "expected executorAgentName on buffered artifact activity"
  );
});

test("autopilot slice lifecycle: buffered status updates avoid redispatching the same task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-buffered-status-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls, state } = createClientHarness();
      state.tasks.set("task-2", {
        id: "task-2",
        title: "Mock task 2",
        status: "todo",
        initiative_id: "init-1",
        workstream_id: "ws-2",
        milestone_id: null,
        priority: "high",
      });

      const originalListEntities = client.listEntities;
      client.listEntities = async (type, filters) => {
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
              {
                id: "ws-2",
                name: "Workstream 2",
                status: "active",
                initiative_id: "init-1",
                assigned_agents: [{ id: "agent-1", name: "Engineering Agent", domain: "engineering" }],
              },
            ],
            pagination: { total: 2, has_more: false },
          };
        }
        if (type === "task") {
          const rows = Array.from(state.tasks.values()).filter((row) => {
            const scopedInitiative = typeof filters?.initiative_id === "string" ? filters.initiative_id : null;
            const scopedWorkstream = typeof filters?.workstream_id === "string" ? filters.workstream_id : null;
            if (scopedInitiative && row.initiative_id !== scopedInitiative) return false;
            if (scopedWorkstream && row.workstream_id !== scopedWorkstream) return false;
            return true;
          });
          return {
            data: rows,
            pagination: { total: rows.length, has_more: false },
          };
        }
        return await originalListEntities(type, filters);
      };
      client.applyChangeset = async (payload) => {
        calls.applyChangeset.push(payload);
        throw new Error("simulated offline mode");
      };

      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          agentId: "agent-1",
          includeVerification: false,
          workstreamIds: ["ws-1", "ws-2"],
          ignoreSpawnGuardRateLimit: true,
          tokenBudget: 10_000_000,
        }),
      });
      assert.equal(resStart.status, 200);

      let statusBody = null;
      for (let i = 0; i < 20; i += 1) {
        await sleep(35);
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
        statusBody = JSON.parse(resStatus.body);
        if (statusBody?.run?.status === "stopped") break;
      }

      assert.ok(statusBody?.run, "expected auto-continue status payload");
      assert.equal(statusBody.run.status, "stopped");
      assert.equal(statusBody.run.stopReason, "completed");

      const dispatchedTaskIds = calls.emitActivity
        .filter((entry) => entry?.metadata?.event === "autopilot_slice_dispatched")
        .map((entry) => {
          const list = Array.isArray(entry?.metadata?.task_ids) ? entry.metadata.task_ids : [];
          return typeof list[0] === "string" ? list[0] : null;
        })
        .filter(Boolean);
      const uniqueTaskIds = Array.from(new Set(dispatchedTaskIds)).sort();
      assert.deepEqual(
        uniqueTaskIds,
        ["task-1", "task-2"],
        "expected dispatch to progress to task-2 even when status updates are buffered"
      );
    }
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

test("autopilot slice lifecycle: invalid output translates to error + decision snapshot state", async () => {
  const result = await runPlayTickStatus({
    scenario: "invalid_json",
    after: async ({ handler }) => await readLiveSnapshot(handler),
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "error");
  const snapshot = result.afterResult;
  assert.ok(snapshot && typeof snapshot === "object", "expected live snapshot payload");
  assert.ok(Array.isArray(snapshot.decisions), "expected snapshot decisions list");
  const pendingDecision = snapshot.decisions.find(
    (entry) =>
      entry?.status === "pending" &&
      String(entry?.title ?? "")
        .toLowerCase()
        .includes("autopilot slice failed")
  );
  assert.ok(pendingDecision, "expected fallback decision in snapshot decisions");
  const sliceResult = findSnapshotActivityByEvent(snapshot, "autopilot_slice_result");
  assert.ok(sliceResult, "expected autopilot_slice_result in snapshot activity");
  assert.equal(sliceResult.kind, "decision");
  assert.equal(sliceResult.metadata?.parsed_status, "error");
  assert.equal(
    sliceResult.metadata?.error_location,
    "mission-control.auto-continue.engine.slice.result"
  );
  const stopped = findSnapshotActivityByEvent(snapshot, "auto_continue_stopped");
  assert.ok(stopped, "expected auto_continue_stopped in snapshot activity");
  assert.equal(stopped.kind, "decision");
  assert.equal(stopped.metadata?.stop_reason, "error");
  assert.equal(stopped.metadata?.error_location, "mission-control.auto-continue.engine.error");
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

test("autopilot slice lifecycle: stalled worker translates to blocked decision snapshot state", async () => {
  const result = await runPlayTickStatus({
    scenario: "stall",
    extraEnv: {
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1000",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "5000",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "20",
    },
    after: async ({ handler }) => await readLiveSnapshot(handler),
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "blocked");
  const snapshot = result.afterResult;
  assert.ok(snapshot && typeof snapshot === "object", "expected live snapshot payload");
  assert.ok(Array.isArray(snapshot.decisions), "expected snapshot decisions list");
  const pendingDecision = snapshot.decisions.find(
    (entry) =>
      entry?.status === "pending" &&
      String(entry?.title ?? "")
        .toLowerCase()
        .includes("autopilot slice stalled")
  );
  assert.ok(pendingDecision, "expected stalled-slice decision in snapshot decisions");
  const stalledEvent = findSnapshotActivityByEvent(snapshot, "autopilot_slice_log_stall");
  assert.ok(stalledEvent, "expected stall activity in snapshot");
  assert.equal(stalledEvent.kind, "decision");
  assert.equal(
    stalledEvent.metadata?.error_location,
    "mission-control.auto-continue.engine.slice.stall"
  );
  const stopped = findSnapshotActivityByEvent(snapshot, "auto_continue_stopped");
  assert.ok(stopped, "expected auto_continue_stopped in snapshot activity");
  assert.equal(stopped.kind, "decision");
  assert.equal(stopped.metadata?.stop_reason, "blocked");
  assert.equal(stopped.metadata?.decision_required, true);
});

test("autopilot slice lifecycle: active log heartbeats do not trigger false stall", async () => {
  const result = await runPlayTickStatus({
    scenario: "slow_logs_success",
    waitMs: 320,
    extraEnv: {
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "180",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "5000",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "40",
    },
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.status.run?.status, "stopped");
  assert.equal(result.status.run?.stopReason, "completed");
  assert.equal(result.status.run?.lastError ?? null, null);
});

test("autopilot slice lifecycle: Play override bypasses snake_case spawn-guard rate limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-play-override-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
      ORGX_AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS: "1000",
    },
    async () => {
      const config = baseConfig();
      const { client, calls } = createClientHarness();
      client.checkSpawnGuard = async (_domain, taskId) => ({
        allowed: false,
        modelTier: "sonnet",
        checks: {
          rate_limit: { passed: false, current: 5, max: 5 },
          quality_gate: { passed: true, score: 4, threshold: 3 },
          task_assigned: { passed: true, task_id: taskId, status: "todo" },
        },
        blockedReason: "rate limit: 5/5 domain, 15/15 total",
      });
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1&fastAck=true&ignoreSpawnGuardRateLimit=true",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          workstreamId: "ws-1",
          agentId: "agent-1",
          fastAck: true,
          ignoreSpawnGuardRateLimit: true,
        }),
      });
      assert.ok(
        [200, 202].includes(resPlay.status),
        `expected fast-ack success status, got ${resPlay.status}`
      );

      await sleep(80);
      await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/tick?initiativeId=init-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });

      const resStatus = await call(handler, {
        method: "GET",
        url: "/orgx/api/mission-control/auto-continue/status?initiativeId=init-1",
        headers: {},
      });
      assert.equal(resStatus.status, 200);
      const statusBody = JSON.parse(resStatus.body);
      assert.equal(statusBody?.run?.stopReason, "completed");
      assert.equal(statusBody?.run?.lastError ?? null, null);

      const overrideEvent = calls.emitActivity.find(
        (entry) => entry?.metadata?.event === "auto_continue_spawn_guard_rate_limit_overridden"
      );
      assert.ok(overrideEvent, "expected override activity event");
      const deferredEvent = calls.emitActivity.find(
        (entry) => entry?.metadata?.event === "auto_continue_spawn_guard_rate_limited"
      );
      assert.equal(deferredEvent ?? null, null);
    }
  );
});

test("autopilot slice lifecycle: auto-continue start override persists and executes under rate limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autocontinue-override-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
      ORGX_AUTO_CONTINUE_SPAWN_GUARD_RETRY_MS: "1000",
    },
    async () => {
      const config = baseConfig();
      const { client, calls } = createClientHarness();
      client.checkSpawnGuard = async (_domain, taskId) => ({
        allowed: false,
        modelTier: "sonnet",
        checks: {
          rate_limit: { passed: false, current: 5, max: 5 },
          quality_gate: { passed: true, score: 4, threshold: 3 },
          task_assigned: { passed: true, task_id: taskId, status: "todo" },
        },
        blockedReason: "rate limit: 5/5 domain, 15/15 total",
      });
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiativeId: "init-1",
          agentId: "agent-1",
          ignoreSpawnGuardRateLimit: true,
          workstreamIds: ["ws-1"],
        }),
      });
      assert.equal(resStart.status, 200);
      const startBody = JSON.parse(resStart.body);
      assert.equal(startBody?.ok, true);
      assert.equal(startBody?.run?.ignoreSpawnGuardRateLimit, true);

      let statusBody = null;
      for (let i = 0; i < 20; i += 1) {
        await call(handler, {
          method: "POST",
          url: "/orgx/api/mission-control/auto-continue/tick?initiativeId=init-1",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ initiativeId: "init-1" }),
        });
        await sleep(60);
        const resStatus = await call(handler, {
          method: "GET",
          url: "/orgx/api/mission-control/auto-continue/status?initiativeId=init-1",
          headers: {},
        });
        assert.equal(resStatus.status, 200);
        statusBody = JSON.parse(resStatus.body);
        if (statusBody?.run?.status === "stopped") break;
      }

      assert.ok(statusBody?.run, "expected status payload");
      assert.equal(statusBody?.run?.status, "stopped");
      assert.equal(statusBody?.run?.stopReason, "completed");
      assert.equal(statusBody?.run?.lastError ?? null, null);

      const overrideEvent = calls.emitActivity.find(
        (entry) => entry?.metadata?.event === "auto_continue_spawn_guard_rate_limit_overridden"
      );
      assert.ok(overrideEvent, "expected override activity event");
    }
  );
});

test("autopilot slice lifecycle: includeVerification=false skips verification scenario tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "success",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "1",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "250",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "120",
    },
    async () => {
      const config = baseConfig();
      const { client, calls } = createClientHarness();
      const originalListEntities = client.listEntities;
      client.listEntities = async (type, filters) => {
        if (type === "task") {
          return {
            data: [
              {
                id: "task-verification",
                title: "Verification scenario: do not run this task first",
                status: "todo",
                initiative_id: "init-1",
                workstream_id: "ws-1",
                milestone_id: null,
                priority: "high",
              },
              {
                id: "task-real",
                title: "Implement real slice task",
                status: "todo",
                initiative_id: "init-1",
                workstream_id: "ws-1",
                milestone_id: null,
                priority: "high",
              },
            ],
            pagination: { total: 2, has_more: false },
          };
        }
        return originalListEntities(type, filters);
      };
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 200);
      await sleep(80);
      const resTick = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/tick?initiativeId=init-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      assert.equal(resTick.status, 200);

      const taskUpdates = calls.applyChangeset
        .flatMap((entry) => (Array.isArray(entry.operations) ? entry.operations : []))
        .filter((op) => op?.op === "task.update");
      const updatedIds = taskUpdates.map((op) => op.task_id);
      assert.ok(updatedIds.includes("task-real"), "expected non-verification task to be updated");
      assert.ok(!updatedIds.includes("task-verification"), "expected verification scenario task to be skipped");
    }
  );
});

test("autopilot slice lifecycle: play rejects while another slice is already active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-autopilot-"));
  await withEnv(
    {
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: dir,
      ORGX_AUTOPILOT_WORKER_KIND: "mock",
      ORGX_AUTOPILOT_MOCK_SCENARIO: "stall",
      ORGX_AUTOPILOT_MOCK_SLEEP_MS: "10000",
      ORGX_AUTOPILOT_SLICE_TIMEOUT_MS: "60000",
      ORGX_AUTOPILOT_SLICE_LOG_STALL_MS: "60000",
    },
    async () => {
      const config = baseConfig();
      const { client } = createClientHarness();
      const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

      const resStart = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/start?initiativeId=init-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", agentId: "agent-1" }),
      });
      assert.equal(resStart.status, 200);

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
      const statusBody = JSON.parse(resStatus.body);
      assert.ok(statusBody?.run?.activeRunId, "expected active slice run before play");

      const resPlay = await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1", workstreamId: "ws-1", agentId: "agent-1" }),
      });
      assert.equal(resPlay.status, 409);
      const playBody = JSON.parse(resPlay.body);
      assert.equal(playBody?.ok, false);
      assert.equal(playBody?.code, "auto_continue_already_running");

      await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/stop?initiativeId=init-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
      await call(handler, {
        method: "POST",
        url: "/orgx/api/mission-control/auto-continue/tick?initiativeId=init-1",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiativeId: "init-1" }),
      });
    }
  );
});

test("autopilot slice lifecycle: claude-code executor surfaces anthropic runtime provider in snapshot", async () => {
  const result = await runPlayTickStatus({
    scenario: "success",
    extraEnv: {
      ORGX_AUTOPILOT_EXECUTOR: "claude-code",
    },
    after: async ({ handler }) => {
      const resSnapshot = await call(handler, {
        method: "GET",
        url: "/orgx/api/live/snapshot?sessionsLimit=20&activityLimit=20&decisionsLimit=10&initiative=init-1",
        headers: {},
      });
      assert.equal(resSnapshot.status, 200);
      return JSON.parse(resSnapshot.body);
    },
  });

  const body = result.afterResult;
  assert.ok(Array.isArray(body.runtimeInstances));
  const claude = body.runtimeInstances.find((i) => i?.sourceClient === "claude-code");
  assert.ok(claude, "expected claude-code runtime instance");
  assert.equal(claude.providerLogo, "anthropic");
});
