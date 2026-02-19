import test from "node:test";
import assert from "node:assert/strict";

test("buildLocalSyncAgentsFromRuns returns active agents from running local runs", async () => {
  const { buildLocalSyncAgentsFromRuns } = await import(
    "../../dist/sync/local-agent-telemetry.js"
  );

  const agents = buildLocalSyncAgentsFromRuns({
    runs: {
      one: {
        runId: "run-1",
        agentId: "orgx-engineering",
        pid: 100,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: "task-1",
        startedAt: "2026-02-19T00:00:00.000Z",
        stoppedAt: null,
        status: "running",
      },
      two: {
        runId: "run-2",
        agentId: "orgx-engineering",
        pid: 101,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: "task-2",
        startedAt: "2026-02-19T00:05:00.000Z",
        stoppedAt: null,
        status: "running",
      },
      three: {
        runId: "run-3",
        agentId: "orgx-operations",
        pid: null,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: null,
        startedAt: "2026-02-17T00:03:00.000Z",
        stoppedAt: "2026-02-17T00:04:00.000Z",
        status: "stopped",
      },
    },
  });

  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0], {
    id: "orgx-engineering",
    name: "Orgx Engineering",
    domain: "engineering",
    status: "active",
    currentTask: "task-2",
    lastActive: "2026-02-19T00:05:00.000Z",
  });
});

test("buildLocalSyncAgentsFromRuns merges snapshot mirrors and prefers active local runs", async () => {
  const { buildLocalSyncAgentsFromRuns } = await import(
    "../../dist/sync/local-agent-telemetry.js"
  );

  const agents = buildLocalSyncAgentsFromRuns({
    runs: {
      one: {
        runId: "run-1",
        agentId: "orgx-engineering",
        pid: 200,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: "task-live",
        startedAt: "2026-02-19T01:00:00.000Z",
        stoppedAt: null,
        status: "running",
      },
    },
    mirrors: [
      {
        id: "orgx-engineering",
        name: "Engineering Mirror",
        domain: "engineering",
        status: "idle",
        currentTask: "stale-task",
        lastActive: "2026-02-19T00:30:00.000Z",
      },
      {
        id: "orgx-design",
        name: "Design Mirror",
        domain: "design",
        status: "idle",
        lastActive: "2026-02-19T00:20:00.000Z",
      },
    ],
  });

  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0], {
    id: "orgx-design",
    name: "Design Mirror",
    domain: "design",
    status: "idle",
    currentTask: undefined,
    lastActive: "2026-02-19T00:20:00.000Z",
  });
  assert.deepEqual(agents[1], {
    id: "orgx-engineering",
    name: "Orgx Engineering",
    domain: "engineering",
    status: "active",
    currentTask: "task-live",
    lastActive: "2026-02-19T01:00:00.000Z",
  });
});

test("buildLocalSyncAgentsFromRuns includes idle mirrors for recently stopped agents", async () => {
  const { buildLocalSyncAgentsFromRuns } = await import(
    "../../dist/sync/local-agent-telemetry.js"
  );
  const stoppedAt = new Date(Date.now() - 5 * 60_000).toISOString();

  const agents = buildLocalSyncAgentsFromRuns({
    runs: {
      one: {
        runId: "run-10",
        agentId: "orgx-sales",
        pid: 200,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: "task-10",
        startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        stoppedAt,
        status: "stopped",
      },
    },
  });

  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0], {
    id: "orgx-sales",
    name: "Orgx Sales",
    domain: "sales",
    status: "idle",
    lastActive: stoppedAt,
  });
});

test("buildLocalSyncAgentsFromRuns drops stale stopped runs from idle mirrors", async () => {
  const { buildLocalSyncAgentsFromRuns } = await import(
    "../../dist/sync/local-agent-telemetry.js"
  );

  const agents = buildLocalSyncAgentsFromRuns({
    runs: {
      one: {
        runId: "run-11",
        agentId: "orgx-design",
        pid: null,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: null,
        startedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
        stoppedAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
        status: "stopped",
      },
    },
  });

  assert.equal(agents.length, 0);
});

test("buildLocalSyncAgentsFromRuns prefers fresher stopped local state over stale snapshot mirror", async () => {
  const { buildLocalSyncAgentsFromRuns } = await import(
    "../../dist/sync/local-agent-telemetry.js"
  );

  const agents = buildLocalSyncAgentsFromRuns({
    runs: {
      one: {
        runId: "run-12",
        agentId: "orgx-product",
        pid: null,
        message: null,
        provider: null,
        model: null,
        initiativeId: null,
        initiativeTitle: null,
        workstreamId: null,
        taskId: null,
        startedAt: "2026-02-19T02:00:00.000Z",
        stoppedAt: "2026-02-19T02:40:00.000Z",
        status: "stopped",
      },
    },
    mirrors: [
      {
        id: "orgx-product",
        name: "Product Mirror",
        domain: "product",
        status: "active",
        currentTask: "stale-task",
        lastActive: "2026-02-19T01:30:00.000Z",
      },
    ],
  });

  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0], {
    id: "orgx-product",
    name: "Product Mirror",
    domain: "product",
    status: "idle",
    lastActive: "2026-02-19T02:40:00.000Z",
  });
});
