import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";
import { registerRealtimeOrchestratorRoutes } from "../../dist/http/routes/realtime-orchestrator.js";

function createHarness(options = {}) {
  const calls = [];
  let response = null;
  const router = createRouter();

  registerRealtimeOrchestratorRoutes(router, {
    parseJsonRequest: async (req) => req.body ?? {},
    rawRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (options.rawRequestError) {
        throw options.rawRequestError;
      }
      return options.rawResponse ?? { ok: true };
    },
    sendJson: (_res, status, payload) => {
      response = { status, payload };
    },
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  });

  async function invoke(method, path, body = undefined) {
    const route = router.match(method, path);
    assert.ok(route, `expected route for ${method} ${path}`);
    await route.handler({
      req: { body },
      res: {},
      path,
      query: new URLSearchParams(),
      body: null,
      state: {},
    });
    return response;
  }

  return { calls, invoke };
}

test("POST realtime/session proxies payload to upstream path", async () => {
  const harness = createHarness({
    rawResponse: { ok: true, token: "session-token" },
  });
  const payload = { voice: "alloy", model: "gpt-realtime" };

  const res = await harness.invoke("POST", "realtime/session", payload);

  assert.equal(res?.status, 200);
  assert.deepEqual(res?.payload, { ok: true, token: "session-token" });
  assert.deepEqual(harness.calls, [
    {
      method: "POST",
      path: "/api/client/orchestrator/realtime/session",
      body: payload,
    },
  ]);
});

test("GET orchestrator/commands/* returns 404 for extra path segments", async () => {
  const harness = createHarness();

  const res = await harness.invoke("GET", "orchestrator/commands/cmd-1/extra");

  assert.equal(res?.status, 404);
  assert.equal(res?.payload?.ok, false);
  assert.equal(res?.payload?.error, "Unknown API endpoint");
  assert.equal(harness.calls.length, 0);
});

test("GET orchestrator/commands/* trims decoded command id before upstream call", async () => {
  const harness = createHarness({
    rawResponse: { ok: true, command: { id: "cmd 123" } },
  });

  const res = await harness.invoke("GET", "orchestrator/commands/%20cmd%20123%20");

  assert.equal(res?.status, 200);
  assert.deepEqual(harness.calls, [
    {
      method: "GET",
      path: "/api/client/orchestrator/commands/cmd%20123",
      body: undefined,
    },
  ]);
});

test("GET orchestrator/commands/* returns 400 for malformed command id encoding", async () => {
  const harness = createHarness();

  const res = await harness.invoke("GET", "orchestrator/commands/%E0%A4%A");

  assert.equal(res?.status, 400);
  assert.equal(res?.payload?.ok, false);
  assert.equal(res?.payload?.error, "invalid command id encoding");
  assert.equal(harness.calls.length, 0);
});

test("POST orchestrator/commands/apply returns safe error message on upstream failure", async () => {
  const harness = createHarness({
    rawRequestError: new Error("upstream unavailable"),
  });

  const res = await harness.invoke("POST", "orchestrator/commands/apply", { id: "cmd-1" });

  assert.equal(res?.status, 500);
  assert.deepEqual(res?.payload, {
    ok: false,
    error: "upstream unavailable",
  });
});

test("GET orchestrator/commands/* returns 400 when decoded command id is empty", async () => {
  const harness = createHarness();

  const res = await harness.invoke("GET", "orchestrator/commands/%20%20");

  assert.equal(res?.status, 400);
  assert.deepEqual(res?.payload, {
    ok: false,
    error: "command id is required",
  });
  assert.equal(harness.calls.length, 0);
});

test("POST orchestrator/commands/apply preserves HTTP status codes encoded in upstream error messages", async () => {
  const harness = createHarness({
    rawRequestError: new Error("404 command not found"),
  });

  const res = await harness.invoke("POST", "orchestrator/commands/apply", { id: "cmd-missing" });

  assert.equal(res?.status, 404);
  assert.deepEqual(res?.payload, {
    ok: false,
    error: "404 command not found",
  });
});

test("POST orchestrator/commands/apply preserves status codes when upstream error includes leading whitespace", async () => {
  const harness = createHarness({
    rawRequestError: new Error("  422 invalid command payload"),
  });

  const res = await harness.invoke("POST", "orchestrator/commands/apply", { id: "cmd-1" });

  assert.equal(res?.status, 422);
  assert.deepEqual(res?.payload, {
    ok: false,
    error: "  422 invalid command payload",
  });
});

test("POST orchestrator/commands/apply falls back to 500 for non-error status-like upstream prefixes", async () => {
  const harness = createHarness({
    rawRequestError: new Error("301 moved permanently"),
  });

  const res = await harness.invoke("POST", "orchestrator/commands/apply", { id: "cmd-1" });

  assert.equal(res?.status, 500);
  assert.deepEqual(res?.payload, {
    ok: false,
    error: "301 moved permanently",
  });
});
