import test from "node:test";
import assert from "node:assert/strict";

import { resolveSafeAutopilotWorkerKind } from "../../dist/http/helpers/autopilot-runtime.js";

test("node tests default to mock autopilot workers", () => {
  assert.equal(
    resolveSafeAutopilotWorkerKind("codex", { NODE_TEST_CONTEXT: "child-v8" }),
    "mock"
  );
  assert.equal(
    resolveSafeAutopilotWorkerKind("", { NODE_TEST_CONTEXT: "child-v8" }),
    "mock"
  );
});

test("explicit test opt-in and production keep the requested worker", () => {
  assert.equal(
    resolveSafeAutopilotWorkerKind("claude-code", {
      NODE_TEST_CONTEXT: "child-v8",
      ORGX_AUTOPILOT_ALLOW_REAL_TEST_WORKER: "true",
    }),
    "claude-code"
  );
  assert.equal(resolveSafeAutopilotWorkerKind("codex", {}), "codex");
});
