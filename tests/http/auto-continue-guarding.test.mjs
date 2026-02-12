import test from "node:test";
import assert from "node:assert/strict";

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

test("Next-up play blocks on spawn-guard denial and raises decision", async () => {
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
  };

  const calls = {
    listEntities: [],
    updateEntity: [],
    applyChangeset: [],
    emitActivity: [],
    checkSpawnGuard: [],
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
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
          data: [
            {
              id: "ms-1",
              title: "Milestone 1",
              status: "planned",
              initiative_id: "init-1",
              workstream_id: "ws-1",
            },
          ],
          pagination: { total: 1, has_more: false },
        };
      }
      if (type === "task") {
        return {
          data: [
            {
              id: "task-1",
              title: "Implement dispatch reliability",
              status: "todo",
              initiative_id: "init-1",
              workstream_id: "ws-1",
              milestone_id: "ms-1",
              priority: "high",
            },
          ],
          pagination: { total: 1, has_more: false },
        };
      }
      return {
        data: [],
        pagination: { total: 0, has_more: false },
      };
    },
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      return { ok: true, id };
    },
    applyChangeset: async (payload) => {
      calls.applyChangeset.push(payload);
      return {
        ok: true,
        changeset_id: "cs_1",
        replayed: false,
        run_id: "run_1",
        applied_count: 1,
        results: [],
        event_id: null,
      };
    },
    emitActivity: async (payload) => {
      calls.emitActivity.push(payload);
      return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
    },
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    checkSpawnGuard: async (domain, taskId) => {
      calls.checkSpawnGuard.push({ domain, taskId });
      return {
        allowed: false,
        modelTier: "sonnet",
        checks: {
          rateLimit: { passed: true, current: 1, max: 10 },
          qualityGate: { passed: false, score: 2, threshold: 3 },
          taskAssigned: { passed: true, taskId, status: "todo" },
        },
        blockedReason: "Quality gate threshold not met",
      };
    },
  };

  const handler = createHttpHandler(
    config,
    client,
    () => null,
    createNoopOnboarding(),
    undefined,
    {
      openclaw: {
        listAgents: async () => [{ id: "agent-1", name: "Engineering Agent", model: "local" }],
        spawnAgentTurn: () => {
          throw new Error("spawn should not be called when spawn guard blocks");
        },
      },
    }
  );

  const res = createStubResponse();
  const req = {
    method: "POST",
    url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=agent-1",
    headers: {},
  };

  await handler(req, res);

  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.equal(body?.ok, false);
  assert.equal(body?.run?.stopReason, "blocked");

  assert.equal(calls.checkSpawnGuard.length, 1);
  assert.equal(calls.checkSpawnGuard[0].domain, "engineering");
  assert.equal(calls.checkSpawnGuard[0].taskId, "task-1");

  assert.ok(
    calls.updateEntity.some(
      (entry) => entry.type === "task" && entry.id === "task-1" && entry.updates?.status === "blocked"
    ),
    "expected task to be marked blocked"
  );

  assert.ok(
    calls.applyChangeset.some(
      (entry) =>
        Array.isArray(entry.operations) &&
        entry.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create changeset when spawn guard blocks"
  );

  assert.ok(
    calls.emitActivity.some(
      (entry) => entry?.metadata?.event === "auto_continue_spawn_guard_blocked"
    ),
    "expected blocked activity event"
  );
});
