import assert from "node:assert/strict";
import test from "node:test";

import { resolveCapacityRuntime } from "../dist/runtime-capacity-routing.js";

test("OrgX capacity policy selects the local Codex runner", () => {
  const resolved = resolveCapacityRuntime({
    recommendation: {
      channelId: "codex_subscription",
      workerKind: "codex",
      provider: "openai",
      score: 88,
      reason: "77% minimum reported headroom",
    },
  });

  assert.equal(resolved.workerKind, "codex");
  assert.equal(resolved.source, "orgx-policy");
  assert.equal(resolved.channelId, "codex_subscription");
  assert.equal(resolved.requiresServerDispatch, false);
});

test("an explicit runtime pin wins over the central recommendation", () => {
  const resolved = resolveCapacityRuntime({
    configuredWorkerKind: "claude-code",
    recommendation: {
      channelId: "codex_subscription",
      workerKind: "codex",
      provider: "openai",
      score: 88,
      reason: "Codex has headroom",
    },
  });

  assert.equal(resolved.workerKind, "claude-code");
  assert.equal(resolved.source, "explicit");
  assert.equal(resolved.channelId, null);
});

test("a metered server recommendation stops the local plugin from double-running", () => {
  const resolved = resolveCapacityRuntime({
    recommendation: {
      channelId: "openai_api",
      workerKind: "server",
      provider: "openai",
      score: 20,
      reason: "Included routes are exhausted; spend remains inside the cap",
    },
  });

  assert.equal(resolved.workerKind, "server");
  assert.equal(resolved.source, "orgx-policy");
  assert.equal(resolved.requiresServerDispatch, true);
});
