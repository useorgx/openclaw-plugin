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

test("GET /live/triage merges decisions + blockers, dedupes repeated blockers, and sorts deterministically", async () => {
  const router = createRouter();
  const { deps } = createDeps({
    getDecisions: () => [
      {
        id: "dec-101",
        title: "Approve copy direction",
        status: "pending",
        priority: "high",
        initiativeId: "init-1",
        workstreamId: "ws-2",
        requestedAt: "2026-02-26T12:05:00.000Z",
        updatedAt: "2026-02-26T12:05:00.000Z",
      },
    ],
    getBlockerEvents: () => [
      {
        id: "blk-critical",
        failureType: "budget_exhausted",
        reason: "Budget reached hard cap",
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        workstreamId: "ws-1",
        workstreamTitle: "Workstream 1",
        logPath: "/tmp/log-critical.txt",
        timestamp: "2026-02-26T12:00:00.000Z",
      },
      {
        id: "blk-dup-1",
        failureType: "credential_missing",
        provider: "openai",
        reason: "Missing key",
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        workstreamId: "ws-1",
        workstreamTitle: "Workstream 1",
        logPath: "/tmp/log-dup-1.txt",
        timestamp: "2026-02-26T11:00:00.000Z",
      },
      {
        id: "blk-dup-2",
        failureType: "credential_missing",
        provider: "openai",
        reason: "Missing key",
        initiativeId: "init-1",
        initiativeTitle: "Initiative 1",
        workstreamId: "ws-1",
        workstreamTitle: "Workstream 1",
        logPath: "/tmp/log-dup-2.txt",
        timestamp: "2026-02-26T12:10:00.000Z",
      },
    ],
  });
  registerLiveTriageRoutes(router, deps);

  const route = router.match("GET", "live/triage");
  assert.ok(route, "expected triage list route");

  const res = {};
  await route.handler({
    req: {},
    res,
    path: "live/triage",
    query: new URLSearchParams("status=open&limit=20"),
    body: null,
    state: {},
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.items), "expected items array");
  assert.equal(res.body.items.length, 3, "expected merged + deduped triage list");

  // Critical blocker should sort first regardless of recency.
  assert.equal(res.body.items[0].conflictSource, "budget_exhausted");
  assert.equal(res.body.items[0].severity, "critical");

  const dedupedCredential = res.body.items.find(
    (item) => item.conflictSource === "credential_missing"
  );
  assert.ok(dedupedCredential, "expected deduped credential blocker");
  assert.equal(dedupedCredential.occurrenceCount, 2);
  assert.ok(
    dedupedCredential.proofBundle.logRefs.includes("/tmp/log-dup-1.txt") &&
      dedupedCredential.proofBundle.logRefs.includes("/tmp/log-dup-2.txt"),
    "expected merged log refs across duplicate blocker events"
  );
});
