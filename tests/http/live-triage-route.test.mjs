import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerLiveTriageRoutes } from "../../dist/http/routes/live-triage.js";

function createDeps(overrides = {}) {
  const state = {
    resolved: [],
    emitted: [],
  };
  return {
    state,
    deps: {
      parseJsonRequest: async (req) => req.body ?? {},
      sendJson: (res, status, body) => {
        res.status = status;
        res.body = body;
      },
      getDecisions: () => [],
      getBlockerEvents: () => [],
      resolveDecisionAction: async (decisionId, action, note, optionId) => {
        state.resolved.push({ decisionId, action, note, optionId });
        return { ok: true };
      },
      emitDecisionResolvedActivity: async (input) => {
        state.emitted.push(input);
      },
      ...overrides,
    },
  };
}

test("POST /live/triage/action emits decision_resolved callback after approve", async () => {
  const router = createRouter();
  const { deps, state } = createDeps();
  registerLiveTriageRoutes(router, deps);

  const route = router.match("POST", "live/triage/action");
  assert.ok(route, "expected triage action route");

  const res = {};
  await route.handler({
    req: {
      body: {
        action: "approve",
        note: "approved",
        optionId: "opt-1",
      },
    },
    res,
    path: "live/triage/action",
    query: new URLSearchParams("id=triage-decision-dec-42"),
    body: null,
    state: {},
  });

  assert.equal(res.status, 200);
  assert.equal(state.resolved.length, 1);
  assert.equal(state.resolved[0].decisionId, "dec-42");
  assert.equal(state.emitted.length, 1);
  assert.deepEqual(state.emitted[0], {
    ids: ["dec-42"],
    action: "approve",
    note: "approved",
    optionId: "opt-1",
  });
});

test("POST /live/triage/action accepts snake_case option_id for reject actions", async () => {
  const router = createRouter();
  const { deps, state } = createDeps();
  registerLiveTriageRoutes(router, deps);

  const route = router.match("POST", "live/triage/action");
  assert.ok(route, "expected triage action route");

  const res = {};
  await route.handler({
    req: {
      body: {
        action: "reject",
        note: "needs revision",
        option_id: "opt-legacy",
      },
    },
    res,
    path: "live/triage/action",
    query: new URLSearchParams("id=triage-decision-dec-77"),
    body: null,
    state: {},
  });

  assert.equal(res.status, 200);
  assert.equal(state.resolved.length, 1);
  assert.equal(state.resolved[0].decisionId, "dec-77");
  assert.equal(state.resolved[0].action, "reject");
  assert.equal(state.resolved[0].optionId, "opt-legacy");
  assert.equal(state.emitted.length, 1);
  assert.equal(state.emitted[0].optionId, "opt-legacy");
});
