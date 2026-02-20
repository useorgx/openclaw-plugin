import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerEntitiesRoutes } from "../../dist/http/routes/entities.js";

function pickString(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function createHarness(options = {}) {
  const router = createRouter();
  const calls = {
    listEntities: 0,
    scheduled: [],
  };
  let response = null;

  registerEntitiesRoutes(router, {
    client: {
      createEntity: async () => ({ id: "unused" }),
      updateEntity: async (_type, id) => ({ id, status: "active" }),
      listEntities: async () => {
        calls.listEntities += 1;
        return {
          data:
            options.workstreams ??
            [
              { id: "ws-1", status: "active" },
              { id: "ws-2", status: "blocked" },
              { id: "ws-3", status: "ready" },
            ],
        };
      },
    },
    parseJsonRequest: async () => options.payload ?? {},
    pickString,
    normalizeEntityMutationPayload: (input) => input,
    resolveAutoAssignments: async () => ({
      ok: true,
      assignment_source: "fallback",
      assigned_agents: [],
      warnings: [],
    }),
    setLocalInitiativeStatusOverride: () => {},
    clearLocalInitiativeStatusOverride: () => {},
    isUnauthorizedOrgxError: () => false,
    applyLocalInitiativeOverrides: (rows) => rows,
    formatInitiatives: () => [],
    getSnapshot: () => null,
    scheduleWorkstreamReassignment: async (input) => {
      calls.scheduled.push(input);
      if (input.workstreamId === "ws-3" && options.failLast) {
        throw new Error("scheduler unavailable");
      }
      return { requestId: `req-${input.workstreamId}`, dueAt: null };
    },
    sendJson: (_res, status, payload) => {
      response = { status, payload };
    },
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  });

  const route = router.match("PATCH", "entities");
  if (!route) {
    throw new Error("PATCH /entities route not registered");
  }

  return {
    calls,
    invoke: async () => {
      await route.handler({
        req: {},
        res: {},
        path: "entities",
        query: new URLSearchParams(),
        body: null,
        state: {},
      });
      return response;
    },
  };
}

test("PATCH initiative assignment cascades reassignment across dispatchable workstreams", async () => {
  const harness = createHarness({
    payload: {
      type: "initiative",
      id: "init-1",
      assigned_agents: [{ id: "agent-2", name: "Agent Two", domain: "engineering" }],
    },
  });

  const response = await harness.invoke();
  assert.equal(response?.status, 200);
  assert.equal(harness.calls.listEntities, 1);
  assert.deepEqual(
    harness.calls.scheduled.map((item) => ({
      initiativeId: item.initiativeId,
      workstreamId: item.workstreamId,
      event: item.event,
    })),
    [
      { initiativeId: "init-1", workstreamId: "ws-1", event: "initiative_reassigned" },
      { initiativeId: "init-1", workstreamId: "ws-3", event: "initiative_reassigned" },
    ]
  );
  assert.deepEqual(response?.payload?.initiative_reassignment, {
    triggered: true,
    requested: 3,
    scheduled: 2,
    skipped: 1,
    failures: [],
  });
});

test("PATCH initiative assignment reports reassignment failures without aborting entity update", async () => {
  const harness = createHarness({
    payload: {
      type: "initiative",
      id: "init-1",
      assignedAgentIds: ["agent-2"],
    },
    failLast: true,
  });

  const response = await harness.invoke();
  assert.equal(response?.status, 200);
  assert.equal(harness.calls.listEntities, 1);
  assert.equal(harness.calls.scheduled.length, 2);
  assert.deepEqual(response?.payload?.initiative_reassignment, {
    triggered: true,
    requested: 3,
    scheduled: 1,
    skipped: 1,
    failures: ["ws-3:scheduler unavailable"],
  });
});

test("PATCH initiative assignment also schedules in_progress workstreams", async () => {
  const harness = createHarness({
    payload: {
      type: "initiative",
      id: "init-1",
      assignedAgentIds: ["agent-2"],
    },
    workstreams: [
      { id: "ws-1", status: "in_progress" },
      { id: "ws-2", status: "todo" },
      { id: "ws-3", status: "running" },
    ],
  });

  const response = await harness.invoke();
  assert.equal(response?.status, 200);
  assert.equal(harness.calls.listEntities, 1);
  assert.deepEqual(
    harness.calls.scheduled.map((item) => item.workstreamId),
    ["ws-1", "ws-3"]
  );
  assert.deepEqual(response?.payload?.initiative_reassignment, {
    triggered: true,
    requested: 3,
    scheduled: 2,
    skipped: 1,
    failures: [],
  });
});

test("PATCH initiative assignment also schedules pending workstreams", async () => {
  const harness = createHarness({
    payload: {
      type: "initiative",
      id: "init-1",
      assignedAgentIds: ["agent-2"],
    },
    workstreams: [
      { id: "ws-1", status: "pending" },
      { id: "ws-2", status: "blocked" },
      { id: "ws-3", status: "ready" },
    ],
  });

  const response = await harness.invoke();
  assert.equal(response?.status, 200);
  assert.equal(harness.calls.listEntities, 1);
  assert.deepEqual(
    harness.calls.scheduled.map((item) => item.workstreamId),
    ["ws-1", "ws-3"]
  );
  assert.deepEqual(response?.payload?.initiative_reassignment, {
    triggered: true,
    requested: 3,
    scheduled: 2,
    skipped: 1,
    failures: [],
  });
});
