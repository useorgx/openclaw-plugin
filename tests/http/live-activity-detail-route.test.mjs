import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerLiveLegacyRoutes } from "../../dist/http/routes/live-legacy.js";

function createStubResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end() {},
  };
}

function registerRoutes(overrides = {}) {
  const router = createRouter();
  registerLiveLegacyRoutes(router, {
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: [] }),
    listInitiativeIdsForProject: async () => [],
    listRuntimeInstances: () => [],
    injectRuntimeInstancesAsSessions: (input) => input,
    enrichSessionsWithRuntime: (input) => input,
    loadLocalOpenClawSnapshot: async () => ({ sessions: [], activity: [] }),
    toLocalSessionTree: () => ({ nodes: [], edges: [], groups: [] }),
    readAgentContexts: () => ({ agents: {}, runs: {} }),
    applyAgentContextsToSessionTree: (input) => input,
    listActivityPage: () => ({ activities: [], cursor: null, nextCursor: null, prevCursor: null, hasMore: false }),
    applyAgentContextsToActivity: (input) => input,
    appendActivityItems: () => {},
    activityWarmByKey: new Map(),
    activityWarmThrottleMs: 1_000,
    outboxReadAllItems: async () => [],
    toLocalLiveActivity: async () => ({ activities: [], total: 0 }),
    loadLocalTurnDetail: async () => null,
    summarizeActivityHeadline: async () => ({
      headline: "fallback headline",
      source: "llm",
      model: "test-model",
    }),
    sendJson: (res, status, payload) => {
      res.status = status;
      res.body = payload;
    },
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    sendHtml: () => {},
    resolveFilesystemOpenPath: (value) => value,
    escapeHtml: (value) => value,
    statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 0 }),
    readdirSync: () => [],
    existsSync: () => false,
    resolvePath: (...segments) => segments.join("/"),
    readFilePreview: () => ({ previewBuffer: Buffer.from(""), truncated: false }),
    filePreviewMaxBytes: 1024,
    filePreviewMaxDirEntries: 20,
    securityHeaders: {},
    corsHeaders: {},
    config: {
      baseUrl: "https://www.useorgx.com",
      apiKey: "oxk_test",
      userId: "",
    },
    isUserScopedApiKey: () => true,
    streamIdleTimeoutMs: 1_000,
    ...overrides,
  });
  return router;
}

test("live/activity/detail returns merged detail + headline from one route", async () => {
  let headlineCalls = 0;
  const router = registerRoutes({
    loadLocalTurnDetail: async () => ({
      summary: "Patch completed and artifact registered.",
      turnId: "turn_123",
    }),
    summarizeActivityHeadline: async ({ text, type }) => {
      headlineCalls += 1;
      assert.equal(text, "Patch completed and artifact registered.");
      assert.equal(type, "activity");
      return {
        headline: "Patch completed",
        source: "llm",
        model: "test-model",
      };
    },
  });

  const route = router.match("GET", "live/activity/detail");
  assert.ok(route, "expected live/activity/detail route");

  const res = createStubResponse();
  await route.handler({
    query: new URLSearchParams("turnId=turn_123&sessionKey=sess_1&run=run_1"),
    res,
  });

  assert.equal(res.status, 200);
  assert.equal(headlineCalls, 1);
  assert.deepEqual(res.body, {
    detail: {
      summary: "Patch completed and artifact registered.",
      turnId: "turn_123",
    },
    headline: "Patch completed",
    headlineSource: "llm",
    headlineModel: "test-model",
  });
});

test("live/activity/detail skips headline generation when summary is missing", async () => {
  let headlineCalls = 0;
  const router = registerRoutes({
    loadLocalTurnDetail: async () => ({
      turnId: "turn_456",
      summary: null,
    }),
    summarizeActivityHeadline: async () => {
      headlineCalls += 1;
      return {
        headline: "should not be used",
        source: "llm",
        model: "test-model",
      };
    },
  });

  const route = router.match("GET", "live/activity/detail");
  assert.ok(route, "expected live/activity/detail route");

  const res = createStubResponse();
  await route.handler({
    query: new URLSearchParams("turnId=turn_456"),
    res,
  });

  assert.equal(res.status, 200);
  assert.equal(headlineCalls, 0);
  assert.deepEqual(res.body, {
    detail: {
      turnId: "turn_456",
      summary: null,
    },
    headline: null,
    headlineSource: null,
    headlineModel: null,
  });
});
