import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerEntitiesRoutes } from "../../dist/http/routes/entities.js";

function pickString(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function createDeps(overrides = {}) {
  return {
    client: {
      createEntity: async () => ({ id: "unused" }),
      updateEntity: async (_type, id, updates) => ({
        id,
        initiative_id: "init-1",
        status: updates.status ?? "active",
      }),
      listEntities: async () => ({ data: [] }),
    },
    parseJsonRequest: async (req) => req.body ?? {},
    pickString,
    normalizeEntityMutationPayload: (input) => ({ ...input }),
    resolveAutoAssignments: async () => ({
      ok: true,
      assignment_source: "manual",
      assigned_agents: [],
      warnings: [],
    }),
    setLocalInitiativeStatusOverride: () => {},
    clearLocalInitiativeStatusOverride: () => {},
    isUnauthorizedOrgxError: () => false,
    applyLocalInitiativeOverrides: (rows) => rows,
    formatInitiatives: () => [],
    getSnapshot: () => null,
    sendJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    ...overrides,
  };
}

async function invokePatch(input, deps) {
  const router = createRouter();
  registerEntitiesRoutes(router, deps);
  const route = router.match("PATCH", "entities");
  assert.ok(route, "expected PATCH /entities route");
  const res = {};
  await route.handler({
    req: { body: input },
    res,
    path: "entities",
    query: new URLSearchParams(),
    body: null,
    state: {},
  });
  return res;
}

test("PATCH /entities schedules reassignment redispatch for active workstream updates", async () => {
  const scheduled = [];
  const deps = createDeps({
    scheduleWorkstreamReassignment: async (input) => {
      scheduled.push(input);
      return { requestId: "req-1", dueAt: "2026-02-20T00:00:00.000Z" };
    },
  });

  const res = await invokePatch(
    {
      type: "workstream",
      id: "ws-1",
      initiative_id: "init-1",
      status: "active",
      domain: "product",
    },
    deps
  );

  assert.equal(res.status, 200);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].workstreamId, "ws-1");
  assert.equal(scheduled[0].status, "active");
  assert.equal(res.payload?.reassignment?.scheduled, true);
});

test("PATCH /entities does not schedule reassignment redispatch for todo workstreams", async () => {
  const scheduled = [];
  const deps = createDeps({
    scheduleWorkstreamReassignment: async (input) => {
      scheduled.push(input);
      return { requestId: "req-2", dueAt: null };
    },
  });

  const res = await invokePatch(
    {
      type: "workstream",
      id: "ws-2",
      initiative_id: "init-1",
      status: "todo",
      domain: "engineering",
    },
    deps
  );

  assert.equal(res.status, 200);
  assert.equal(scheduled.length, 0);
  assert.equal(res.payload?.reassignment?.scheduled, false);
  assert.equal(res.payload?.reassignment?.reason, "workstream_not_active_or_ready");
});
