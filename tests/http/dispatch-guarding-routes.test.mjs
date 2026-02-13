import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync } from "node:fs";
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

test("Agent launch blocks on spawn-guard denial and raises decision", async () => {
  const config = baseConfig();
  const calls = {
    updateEntity: [],
    applyChangeset: [],
    emitActivity: [],
    checkSpawnGuard: [],
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    listEntities: async () => ({ data: [] }),
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      return { ok: true, id };
    },
    applyChangeset: async (payload) => {
      calls.applyChangeset.push(payload);
      return { ok: true, run_id: "run_1", changeset_id: "cs_1" };
    },
    emitActivity: async (payload) => {
      calls.emitActivity.push(payload);
      return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
    },
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
        listAgents: async () => [{ id: "agent-1", model: "local" }],
        spawnAgentTurn: () => {
          throw new Error("spawn should not be called when launch is blocked");
        },
      },
    }
  );

  const res = createStubResponse();
  await handler(
    {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&workstreamId=ws-1&taskId=task-1",
      headers: {},
    },
    res
  );

  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.equal(body?.ok, false);
  assert.equal(body?.code, "spawn_guard_blocked");

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
    "expected decision.create changeset when launch is blocked"
  );

  assert.ok(
    calls.emitActivity.some(
      (entry) => entry?.metadata?.event === "agent_launch_spawn_guard_blocked"
    ),
    "expected blocked launch activity event"
  );
});

test("Agent launch returns 429 when spawn-guard is rate-limited", async () => {
  const config = baseConfig();
  const calls = {
    updateEntity: [],
    applyChangeset: [],
    checkSpawnGuard: [],
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    listEntities: async () => ({ data: [] }),
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      return { ok: true, id };
    },
    applyChangeset: async (payload) => {
      calls.applyChangeset.push(payload);
      return { ok: true, run_id: "run_1", changeset_id: "cs_1" };
    },
    emitActivity: async () => ({ ok: true, run_id: "run_1", event_id: null, reused_run: false }),
    checkSpawnGuard: async (domain, taskId) => {
      calls.checkSpawnGuard.push({ domain, taskId });
      return {
        allowed: false,
        modelTier: "sonnet",
        checks: {
          rateLimit: { passed: false, current: 10, max: 10 },
          qualityGate: { passed: true, score: 5, threshold: 3 },
          taskAssigned: { passed: true, taskId, status: "todo" },
        },
        blockedReason: "Spawn rate limit reached",
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
        listAgents: async () => [{ id: "agent-1", model: "local" }],
        spawnAgentTurn: () => {
          throw new Error("spawn should not be called when launch is rate-limited");
        },
      },
    }
  );

  const res = createStubResponse();
  await handler(
    {
      method: "POST",
      url: "/orgx/api/agents/launch?agentId=agent-1&initiativeId=init-1&workstreamId=ws-1&taskId=task-1",
      headers: {},
    },
    res
  );

  assert.equal(res.status, 429);
  const body = JSON.parse(res.body);
  assert.equal(body?.ok, false);
  assert.equal(body?.code, "spawn_guard_rate_limited");
  assert.equal(body?.retryable, true);

  assert.equal(calls.checkSpawnGuard.length, 1);
  assert.ok(
    calls.applyChangeset.every(
      (entry) =>
        !Array.isArray(entry.operations) ||
        !entry.operations.some((op) => op.op === "decision.create")
    ),
    "did not expect decision.create when guard is retryable"
  );
});

test("Agent restart blocks on spawn-guard denial before spawning a new run", async () => {
  // Hermetic env: avoid accidentally reading/writing real ~/.openclaw during tests.
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-dispatch-guarding-"));
  const openclawHome = join(home, ".openclaw");
  mkdirSync(openclawHome, { recursive: true });
  process.env.HOME = home;
  process.env.OPENCLAW_HOME = openclawHome;

  const config = baseConfig();
  const calls = {
    applyChangeset: [],
    checkSpawnGuard: [],
    emitActivity: [],
  };
  let guardBlocked = false;
  let spawnCount = 0;

  try {
    const client = {
      getBaseUrl: () => config.baseUrl,
      listEntities: async (type) => {
        if (type === "task") {
          return {
            data: [
              {
                id: "task-1",
                status: "todo",
                initiative_id: "init-1",
                workstream_id: "ws-1",
              },
            ],
          };
        }
        return { data: [] };
      },
      updateEntity: async () => ({ ok: true }),
      applyChangeset: async (payload) => {
        calls.applyChangeset.push(payload);
        return { ok: true, run_id: "run_1", changeset_id: "cs_1" };
      },
      emitActivity: async (payload) => {
        calls.emitActivity.push(payload);
        return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
      },
      checkSpawnGuard: async (domain, taskId) => {
        calls.checkSpawnGuard.push({ domain, taskId });
        if (!guardBlocked) {
          return {
            allowed: true,
            modelTier: "sonnet",
            checks: {
              rateLimit: { passed: true, current: 1, max: 10 },
              qualityGate: { passed: true, score: 4, threshold: 3 },
              taskAssigned: { passed: true, taskId, status: "todo" },
            },
          };
        }
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
          listAgents: async () => [{ id: "agent-1", model: "local" }],
          spawnAgentTurn: () => {
            spawnCount += 1;
            return { pid: 321 };
          },
        },
      }
    );

    const launchRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/agents/launch?agentId=agent-1&sessionId=00000000-0000-0000-0000-000000000111&initiativeId=init-1&workstreamId=ws-1&taskId=task-1",
        headers: {},
      },
      launchRes
    );
    assert.equal(launchRes.status, 202);
    const launchBody = JSON.parse(launchRes.body);
    assert.equal(launchBody?.ok, true);

    guardBlocked = true;

    const restartRes = createStubResponse();
    await handler(
      {
        method: "POST",
        url: "/orgx/api/agents/restart?runId=00000000-0000-0000-0000-000000000111",
        headers: {},
      },
      restartRes
    );

    assert.equal(restartRes.status, 409);
    const restartBody = JSON.parse(restartRes.body);
    assert.equal(restartBody?.ok, false);
    assert.equal(restartBody?.code, "spawn_guard_blocked");
    assert.equal(spawnCount, 1);

    assert.ok(
      calls.applyChangeset.some(
        (entry) =>
          Array.isArray(entry.operations) &&
          entry.operations.some((op) => op.op === "decision.create")
      ),
      "expected decision.create changeset on blocked restart"
    );
    assert.ok(
      calls.emitActivity.some(
        (entry) => entry?.metadata?.event === "agent_restart_spawn_guard_blocked"
      ),
      "expected blocked restart activity event"
    );
  } finally {
    process.env.HOME = originalHome;
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
});

test("Next-up fallback dispatch blocks on spawn-guard denial and raises decision", async () => {
  const config = baseConfig();
  const calls = {
    checkSpawnGuard: [],
    applyChangeset: [],
    emitActivity: [],
  };

  const client = {
    getBaseUrl: () => config.baseUrl,
    listEntities: async (type) => {
      if (type === "initiative") {
        return {
          data: [{ id: "init-1", title: "Initiative 1", status: "active" }],
          pagination: { total: 1, has_more: false },
        };
      }
      if (type === "workstream") {
        return {
          data: [{ id: "ws-1", name: "Workstream 1", status: "active", initiative_id: "init-1" }],
          pagination: { total: 1, has_more: false },
        };
      }
      if (type === "milestone") {
        return {
          data: [
            {
              id: "ms-1",
              title: "Milestone 1",
              status: "blocked",
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
              title: "Blocked by milestone",
              status: "todo",
              priority: "high",
              initiative_id: "init-1",
              workstream_id: "ws-1",
              milestone_id: "ms-1",
            },
          ],
          pagination: { total: 1, has_more: false },
        };
      }
      return { data: [], pagination: { total: 0, has_more: false } };
    },
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    updateEntity: async () => ({ ok: true }),
    applyChangeset: async (payload) => {
      calls.applyChangeset.push(payload);
      return { ok: true, changeset_id: "cs_1", run_id: "run_1" };
    },
    emitActivity: async (payload) => {
      calls.emitActivity.push(payload);
      return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
    },
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
        listAgents: async () => [],
        spawnAgentTurn: () => {
          throw new Error("spawn should not be called when fallback guard blocks");
        },
      },
    }
  );

  const res = createStubResponse();
  await handler(
    {
      method: "POST",
      url: "/orgx/api/mission-control/next-up/play?initiativeId=init-1&workstreamId=ws-1&agentId=main",
      headers: {},
    },
    res
  );

  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.equal(body?.ok, false);
  assert.equal(body?.code, "spawn_guard_blocked");

  assert.equal(calls.checkSpawnGuard.length, 1);
  assert.equal(calls.checkSpawnGuard[0].domain, "engineering");
  assert.equal(calls.checkSpawnGuard[0].taskId, undefined);

  assert.ok(
    calls.applyChangeset.some(
      (entry) =>
        Array.isArray(entry.operations) &&
        entry.operations.some((op) => op.op === "decision.create")
    ),
    "expected decision.create changeset on blocked fallback dispatch"
  );
  assert.ok(
    calls.emitActivity.some(
      (entry) => entry?.metadata?.event === "next_up_fallback_spawn_guard_blocked"
    ),
    "expected blocked fallback activity event"
  );
});
