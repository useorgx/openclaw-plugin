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
        startedAt: "2026-02-19T00:03:00.000Z",
        stoppedAt: "2026-02-19T00:04:00.000Z",
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
