import test from "node:test";
import assert from "node:assert/strict";

import { createAutoContinueEngine } from "../../dist/http/helpers/auto-continue-engine.js";

// ---------------------------------------------------------------------------
// Minimal stub deps for creating an engine instance to test session store
// ---------------------------------------------------------------------------

function stubClient() {
  return {
    listEntities: async () => [],
    getEntity: async () => null,
    createEntity: async () => ({}),
    updateEntity: async () => ({}),
    deleteEntity: async () => true,
    syncSnapshot: async () => ({ version: 1, entities: [] }),
    applyChangeset: async () => ({ ok: true }),
    listDecisions: async () => [],
    approveDecision: async () => ({}),
    rejectDecision: async () => ({}),
  };
}

function createTestEngine() {
  return createAutoContinueEngine({
    client: stubClient(),
    filename: "/tmp/test-engine.js",
    safeErrorMessage: (err) => String(err),
    pidAlive: () => false,
    stopProcess: async () => ({ stopped: false, wasRunning: false }),
    resolveOrgxAgentForDomain: (domain) => ({ id: `agent-${domain}`, name: domain }),
    checkSpawnGuardSafe: async () => null,
    syncParentRollupsForTask: async () => {},
    emitActivitySafe: async () => {},
    requestDecisionSafe: async () => false,
    registerArtifactSafe: async () => ({ ok: true, id: null }),
    applyAgentStatusUpdatesSafe: async () => ({
      applied: 0,
      buffered: false,
      taskUpdates: [],
      milestoneUpdates: [],
    }),
    upsertRuntimeInstanceFromHook: () => ({
      id: "test",
      source_client: "codex",
      status: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    broadcastRuntimeSse: () => {},
    clearSnapshotResponseCache: () => {},
    resolveByokEnvOverrides: () => ({}),
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  });
}

// ---------------------------------------------------------------------------
// Session store CRUD tests
// ---------------------------------------------------------------------------

test("session store get returns null when empty", () => {
  const engine = createTestEngine();
  const session = engine.getWorkstreamSession("ws-1");
  assert.equal(session, null);
});

test("session store set and get round-trip", () => {
  const engine = createTestEngine();
  const now = new Date().toISOString();
  engine.setWorkstreamSession("ws-1", {
    sessionId: "sess-aaa",
    sourceClient: "codex",
    workstreamId: "ws-1",
    initiativeId: "init-1",
    capturedAt: now,
    fromRunId: "run-1",
  });

  const session = engine.getWorkstreamSession("ws-1");
  assert.ok(session);
  assert.equal(session.sessionId, "sess-aaa");
  assert.equal(session.sourceClient, "codex");
  assert.equal(session.workstreamId, "ws-1");
  assert.equal(session.initiativeId, "init-1");
});

test("session store set overwrites existing entry", () => {
  const engine = createTestEngine();
  const now = new Date().toISOString();
  engine.setWorkstreamSession("ws-1", {
    sessionId: "sess-old",
    sourceClient: "codex",
    workstreamId: "ws-1",
    initiativeId: "init-1",
    capturedAt: now,
    fromRunId: "run-1",
  });
  engine.setWorkstreamSession("ws-1", {
    sessionId: "sess-new",
    sourceClient: "claude-code",
    workstreamId: "ws-1",
    initiativeId: "init-1",
    capturedAt: now,
    fromRunId: "run-2",
  });

  const session = engine.getWorkstreamSession("ws-1");
  assert.ok(session);
  assert.equal(session.sessionId, "sess-new");
  assert.equal(session.sourceClient, "claude-code");
});

test("session store clear removes all for initiative", () => {
  const engine = createTestEngine();
  const now = new Date().toISOString();

  for (const wsId of ["ws-1", "ws-2", "ws-3"]) {
    engine.setWorkstreamSession(wsId, {
      sessionId: `sess-${wsId}`,
      sourceClient: "codex",
      workstreamId: wsId,
      initiativeId: "init-1",
      capturedAt: now,
      fromRunId: `run-${wsId}`,
    });
  }
  // Add a session for a different initiative
  engine.setWorkstreamSession("ws-other", {
    sessionId: "sess-other",
    sourceClient: "codex",
    workstreamId: "ws-other",
    initiativeId: "init-2",
    capturedAt: now,
    fromRunId: "run-other",
  });

  engine.clearWorkstreamSession("init-1");

  // All init-1 sessions should be gone
  assert.equal(engine.getWorkstreamSession("ws-1"), null);
  assert.equal(engine.getWorkstreamSession("ws-2"), null);
  assert.equal(engine.getWorkstreamSession("ws-3"), null);
  // init-2 session should remain
  assert.ok(engine.getWorkstreamSession("ws-other"));
});

test("session store list filters by initiative", () => {
  const engine = createTestEngine();
  const now = new Date().toISOString();

  engine.setWorkstreamSession("ws-1", {
    sessionId: "sess-1",
    sourceClient: "codex",
    workstreamId: "ws-1",
    initiativeId: "init-1",
    capturedAt: now,
    fromRunId: "run-1",
  });
  engine.setWorkstreamSession("ws-2", {
    sessionId: "sess-2",
    sourceClient: "codex",
    workstreamId: "ws-2",
    initiativeId: "init-2",
    capturedAt: now,
    fromRunId: "run-2",
  });

  const forInit1 = engine.listWorkstreamSessions("init-1");
  assert.equal(forInit1.length, 1);
  assert.equal(forInit1[0].sessionId, "sess-1");

  const all = engine.listWorkstreamSessions();
  assert.equal(all.length, 2);
});

test("session store list without filter returns all", () => {
  const engine = createTestEngine();
  const now = new Date().toISOString();

  engine.setWorkstreamSession("ws-a", {
    sessionId: "sess-a",
    sourceClient: "codex",
    workstreamId: "ws-a",
    initiativeId: "init-a",
    capturedAt: now,
    fromRunId: "run-a",
  });
  engine.setWorkstreamSession("ws-b", {
    sessionId: "sess-b",
    sourceClient: "claude-code",
    workstreamId: "ws-b",
    initiativeId: "init-b",
    capturedAt: now,
    fromRunId: "run-b",
  });

  const list = engine.listWorkstreamSessions();
  assert.equal(list.length, 2);
});

// ---------------------------------------------------------------------------
// sessionResumeEnabled tests
// ---------------------------------------------------------------------------

test("sessionResumeEnabled returns false by default", () => {
  const saved = process.env.ORGX_AUTOPILOT_SESSION_RESUME;
  try {
    delete process.env.ORGX_AUTOPILOT_SESSION_RESUME;
    const engine = createTestEngine();
    assert.equal(engine.sessionResumeEnabled(), false);
  } finally {
    if (saved !== undefined) process.env.ORGX_AUTOPILOT_SESSION_RESUME = saved;
    else delete process.env.ORGX_AUTOPILOT_SESSION_RESUME;
  }
});

test("sessionResumeEnabled returns true when set", () => {
  const saved = process.env.ORGX_AUTOPILOT_SESSION_RESUME;
  try {
    process.env.ORGX_AUTOPILOT_SESSION_RESUME = "true";
    const engine = createTestEngine();
    assert.equal(engine.sessionResumeEnabled(), true);
  } finally {
    if (saved !== undefined) {
      process.env.ORGX_AUTOPILOT_SESSION_RESUME = saved;
    } else {
      delete process.env.ORGX_AUTOPILOT_SESSION_RESUME;
    }
  }
});

test("sessionResumeEnabled returns false for 'false'", () => {
  const saved = process.env.ORGX_AUTOPILOT_SESSION_RESUME;
  try {
    process.env.ORGX_AUTOPILOT_SESSION_RESUME = "false";
    const engine = createTestEngine();
    assert.equal(engine.sessionResumeEnabled(), false);
  } finally {
    if (saved !== undefined) {
      process.env.ORGX_AUTOPILOT_SESSION_RESUME = saved;
    } else {
      delete process.env.ORGX_AUTOPILOT_SESSION_RESUME;
    }
  }
});

test("sessionResumeEnabled returns false for '0'", () => {
  const saved = process.env.ORGX_AUTOPILOT_SESSION_RESUME;
  try {
    process.env.ORGX_AUTOPILOT_SESSION_RESUME = "0";
    const engine = createTestEngine();
    assert.equal(engine.sessionResumeEnabled(), false);
  } finally {
    if (saved !== undefined) {
      process.env.ORGX_AUTOPILOT_SESSION_RESUME = saved;
    } else {
      delete process.env.ORGX_AUTOPILOT_SESSION_RESUME;
    }
  }
});

// ---------------------------------------------------------------------------
// workstreamSessionStore Map direct access
// ---------------------------------------------------------------------------

test("workstreamSessionStore is directly accessible", () => {
  const engine = createTestEngine();
  assert.ok(engine.workstreamSessionStore instanceof Map);
  assert.equal(engine.workstreamSessionStore.size, 0);

  const now = new Date().toISOString();
  engine.setWorkstreamSession("ws-direct", {
    sessionId: "sess-direct",
    sourceClient: "codex",
    workstreamId: "ws-direct",
    initiativeId: "init-direct",
    capturedAt: now,
    fromRunId: "run-direct",
  });
  assert.equal(engine.workstreamSessionStore.size, 1);
});
