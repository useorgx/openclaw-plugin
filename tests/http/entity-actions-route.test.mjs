import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerEntityDynamicRoutes } from "../../dist/http/routes/entity-dynamic.js";

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
  const calls = {
    updateEntity: [],
    setLocalInitiativeStatusOverride: [],
    clearLocalInitiativeStatusOverride: [],
  };

  const router = createRouter();
  registerEntityDynamicRoutes(router, {
    parseJsonRequest: async (req) => req.body ?? {},
    pickString,
    rawRequest: async () => ({ ok: true }),
    listEntityComments: () => [],
    mergeEntityComments: (_remote, local) => local,
    appendEntityComment: () => ({ id: "local-comment" }),
    updateEntity: async (type, id, updates) => {
      calls.updateEntity.push({ type, id, updates });
      if (typeof options.onUpdateEntity === "function") {
        return options.onUpdateEntity(type, id, updates);
      }
      return { id, type, status: updates.status ?? null };
    },
    setLocalInitiativeStatusOverride: (initiativeId, status) => {
      calls.setLocalInitiativeStatusOverride.push({ initiativeId, status });
    },
    clearLocalInitiativeStatusOverride: (initiativeId) => {
      calls.clearLocalInitiativeStatusOverride.push({ initiativeId });
    },
    isUnauthorizedOrgxError: (err) => {
      if (typeof options.isUnauthorizedOrgxError === "function") {
        return options.isUnauthorizedOrgxError(err);
      }
      return false;
    },
    sendJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  });

  const route = router.match("POST", "entities/workstream/ws-1/start");
  assert.ok(route, "expected dynamic entities route");

  const invoke = async ({ type, id, action, body = {} }) => {
    const path = `entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`;
    const matched = router.match("POST", path);
    assert.ok(matched, `expected route for ${path}`);
    const res = {};
    await matched.handler({
      req: { method: "POST", body },
      res,
      path,
      query: new URLSearchParams(),
      body: null,
      state: {},
    });
    return res;
  };

  return { calls, invoke };
}

test("entity action maps workstream start to active", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "workstream",
    id: "ws-1",
    action: "start",
  });

  assert.equal(res.status, 200);
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.updateEntity[0], {
    type: "workstream",
    id: "ws-1",
    updates: { status: "active" },
  });
});

test("entity action maps workstream complete to completed", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "workstream",
    id: "ws-2",
    action: "complete",
  });

  assert.equal(res.status, 200);
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.updateEntity[0], {
    type: "workstream",
    id: "ws-2",
    updates: { status: "completed" },
  });
});

test("entity action keeps task start mapping to in_progress", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "task",
    id: "task-1",
    action: "start",
  });

  assert.equal(res.status, 200);
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.updateEntity[0], {
    type: "task",
    id: "task-1",
    updates: { status: "in_progress" },
  });
});

test("entity action maps workstream pause to paused", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "workstream",
    id: "ws-4",
    action: "pause",
  });

  assert.equal(res.status, 200);
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.updateEntity[0], {
    type: "workstream",
    id: "ws-4",
    updates: { status: "paused" },
  });
});

test("entity action maps workstream resume to active", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "workstream",
    id: "ws-5",
    action: "resume",
  });

  assert.equal(res.status, 200);
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.updateEntity[0], {
    type: "workstream",
    id: "ws-5",
    updates: { status: "active" },
  });
});

test("entity action falls back to local override for unauthorized initiative resume", async () => {
  const harness = createHarness({
    onUpdateEntity: async () => {
      throw new Error("forbidden");
    },
    isUnauthorizedOrgxError: (err) => (err instanceof Error ? err.message === "forbidden" : false),
  });
  const res = await harness.invoke({
    type: "initiative",
    id: "init-unauthorized",
    action: "resume",
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.localFallback, true);
  assert.equal(res.payload?.entity?.status, "active");
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.setLocalInitiativeStatusOverride, [
    { initiativeId: "init-unauthorized", status: "active" },
  ]);
  assert.equal(harness.calls.clearLocalInitiativeStatusOverride.length, 0);
});

test("entity action falls back to local override for unauthorized initiative delete", async () => {
  const harness = createHarness({
    onUpdateEntity: async () => {
      throw new Error("denied");
    },
    isUnauthorizedOrgxError: (err) => (err instanceof Error ? err.message === "denied" : false),
  });
  const res = await harness.invoke({
    type: "initiative",
    id: "init-delete-unauthorized",
    action: "delete",
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload?.ok, true);
  assert.equal(res.payload?.localFallback, true);
  assert.equal(res.payload?.entity?.status, "archived");
  assert.equal(res.payload?.deletedAsStatus, "archived");
  assert.equal(harness.calls.updateEntity.length, 1);
  assert.deepEqual(harness.calls.setLocalInitiativeStatusOverride, [
    { initiativeId: "init-delete-unauthorized", status: "archived" },
  ]);
  assert.equal(harness.calls.clearLocalInitiativeStatusOverride.length, 0);
});

test("entity action rejects unknown action", async () => {
  const harness = createHarness();
  const res = await harness.invoke({
    type: "workstream",
    id: "ws-3",
    action: "launch",
  });

  assert.equal(res.status, 400);
  assert.match(res.payload?.error ?? "", /Unknown entity action/i);
  assert.equal(harness.calls.updateEntity.length, 0);
});
