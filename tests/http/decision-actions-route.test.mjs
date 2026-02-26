import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerDecisionActionsRoutes } from "../../dist/http/routes/decision-actions.js";

function createDeps(overrides = {}) {
  const state = {
    callbackCalls: [],
    bulkCalls: [],
  };
  return {
    state,
    deps: {
      parseJsonRequest: async (req) => req.body ?? {},
      bulkDecideDecisions: async (ids, action, input) => {
        state.bulkCalls.push({ ids, action, input });
        return ids.map((id, index) => ({ id, ok: index === 0 }));
      },
      emitDecisionResolvedActivity: async (ids, action, input) => {
        state.callbackCalls.push({ ids, action, input });
      },
      sendJson: (res, status, payload) => {
        res.status = status;
        res.payload = payload;
      },
      safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
      ...overrides,
    },
  };
}

test("POST /live/decisions/approve emits resolution activity for successful decision ids only", async () => {
  const router = createRouter();
  const { deps, state } = createDeps();
  registerDecisionActionsRoutes(router, deps);

  const route = router.match("POST", "live/decisions/approve");
  assert.ok(route, "expected bulk decision route");

  const res = {};
  await route.handler({
    req: {
      body: {
        ids: ["dec-1", "dec-2"],
        action: "approve",
        note: "looks good",
      },
    },
    res,
    path: "live/decisions/approve",
    query: new URLSearchParams(),
    body: null,
    state: {},
  });

  assert.equal(res.status, 207);
  assert.equal(res.payload.updated, 1);
  assert.equal(state.bulkCalls.length, 1);
  assert.equal(state.callbackCalls.length, 1);
  assert.deepEqual(state.callbackCalls[0].ids, ["dec-1"]);
  assert.equal(state.callbackCalls[0].action, "approve");
  assert.equal(state.callbackCalls[0].input.note, "looks good");
});

test("POST /live/decisions/:id/approve resolves single decision route", async () => {
  const router = createRouter();
  const { deps, state } = createDeps({
    bulkDecideDecisions: async (ids) => ids.map((id) => ({ id, ok: true })),
  });
  registerDecisionActionsRoutes(router, deps);

  const route = router.match("POST", "live/decisions/dec-99/approve");
  assert.ok(route, "expected single decision route");

  const res = {};
  await route.handler({
    req: { body: { action: "approve" } },
    res,
    path: "live/decisions/dec-99/approve",
    query: new URLSearchParams(),
    body: null,
    state: {},
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload.updated, 1);
  assert.equal(state.callbackCalls.length, 1);
  assert.deepEqual(state.callbackCalls[0].ids, ["dec-99"]);
});

test("POST /live/decisions/:id/approve returns 400 for invalid percent-encoded id", async () => {
  const router = createRouter();
  const { deps, state } = createDeps();
  registerDecisionActionsRoutes(router, deps);

  const route = router.match("POST", "live/decisions/%E0%A4%A/approve");
  assert.ok(route, "expected single decision route");

  const res = {};
  await route.handler({
    req: { body: { action: "approve" } },
    res,
    path: "live/decisions/%E0%A4%A/approve",
    query: new URLSearchParams(),
    body: null,
    state: {},
  });

  assert.equal(res.status, 400);
  assert.equal(res.payload.error, "Invalid decision ID.");
  assert.equal(state.bulkCalls.length, 0);
  assert.equal(state.callbackCalls.length, 0);
});

test("POST /live/decisions/approve normalizes reject payload option_id for downstream deps", async () => {
  const router = createRouter();
  const { deps, state } = createDeps({
    bulkDecideDecisions: async (ids, action, input) => {
      state.bulkCalls.push({ ids, action, input });
      return ids.map((id) => ({ id, ok: true }));
    },
  });
  registerDecisionActionsRoutes(router, deps);

  const route = router.match("POST", "live/decisions/approve");
  assert.ok(route, "expected bulk decision route");

  const res = {};
  await route.handler({
    req: {
      body: {
        ids: ["dec-reject-1"],
        action: "reject",
        option_id: "option-7",
        note: "Not aligned",
      },
    },
    res,
    path: "live/decisions/approve",
    query: new URLSearchParams(),
    body: null,
    state: {},
  });

  assert.equal(res.status, 200);
  assert.equal(state.bulkCalls.length, 1);
  assert.equal(state.bulkCalls[0].action, "reject");
  assert.equal(state.bulkCalls[0].input.optionId, "option-7");
  assert.equal(state.bulkCalls[0].input.note, "Not aligned");
  assert.equal(state.callbackCalls.length, 1);
  assert.equal(state.callbackCalls[0].input.optionId, "option-7");
});
