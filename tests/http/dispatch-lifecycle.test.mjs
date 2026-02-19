import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDispatchLifecycle } from "../../dist/http/helpers/dispatch-lifecycle.js";

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function createLifecycle(clientOverrides = {}) {
  const client = {
    applyChangeset: async () => ({ ok: true }),
    emitActivity: async () => ({ ok: true }),
    ...clientOverrides,
  };

  return createDispatchLifecycle({
    client,
    pluginVersion: "test",
    randomUUID: () => "uuid-test",
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    stableHash: () => "hash-test",
    idempotencyKey: () => "idem-test",
    pickString: (record, keys) => {
      for (const key of keys) {
        const value = record?.[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
      return null;
    },
    deriveStructuredActivityBucket: () => "decision",
  });
}

test("requestDecisionSafe returns true when decision applies directly", async () => {
  const lifecycle = createLifecycle();
  const result = await lifecycle.requestDecisionSafe({
    initiativeId: "init-1",
    correlationId: "corr-1",
    title: "Need approval",
    summary: "Approve this path",
    urgency: "high",
    options: ["Approve", "Pause"],
    blocking: true,
  });
  assert.equal(result?.queued, true);
  assert.ok(Array.isArray(result?.decisionIds));
});

test("requestDecisionSafe returns true when API fails but outbox buffering succeeds", async () => {
  const openclawHome = mkdtempSync(join(tmpdir(), "orgx-openclaw-home-"));
  const lifecycle = createLifecycle({
    applyChangeset: async () => {
      throw new Error("simulated api outage");
    },
  });

  await withEnv(
    {
      OPENCLAW_HOME: openclawHome,
      ORGX_OUTBOX_DIR: null,
    },
    async () => {
      const result = await lifecycle.requestDecisionSafe({
        initiativeId: "init-2",
        correlationId: "corr-2",
        title: "Need fallback",
        blocking: true,
      });
      assert.equal(result?.queued, true);
      assert.ok(Array.isArray(result?.decisionIds));
      const outboxPath = join(openclawHome, "orgx-outbox", "init-2.json");
      assert.equal(existsSync(outboxPath), true);
      const raw = readFileSync(outboxPath, "utf8");
      assert.match(raw, /decision\.create/);
    }
  );
});

test("emitActivitySafe injects canonical run metadata for downstream linkage", async () => {
  const emitCalls = [];
  const lifecycle = createLifecycle({
    emitActivity: async (payload) => {
      emitCalls.push(payload);
      return { ok: true, run_id: "remote-run-1", event_id: "evt-1", reused_run: false };
    },
  });

  await lifecycle.emitActivitySafe({
    initiativeId: "init-meta",
    runId: "2df4888d-6c56-49ba-8ba5-9a3f5b2a5f5f",
    correlationId: "corr-ignored-when-run-id-present",
    phase: "execution",
    message: "Autopilot dispatched slice",
    metadata: {
      event: "autopilot_slice_dispatched",
      workstream_id: "ws-1",
    },
  });

  assert.equal(emitCalls.length, 1);
  const payload = emitCalls[0];
  assert.equal(payload.run_id, "2df4888d-6c56-49ba-8ba5-9a3f5b2a5f5f");
  assert.equal(payload.correlation_id, undefined);
  assert.equal(payload.metadata?.initiative_id, "init-meta");
  assert.equal(payload.metadata?.run_id, "2df4888d-6c56-49ba-8ba5-9a3f5b2a5f5f");
  assert.equal(payload.metadata?.slice_run_id, "2df4888d-6c56-49ba-8ba5-9a3f5b2a5f5f");
  assert.equal(payload.metadata?.workstream_id, "ws-1");
});

test("requestDecisionSafe returns false when API and outbox buffering both fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-openclaw-outbox-fail-"));
  const fakeHomeFile = join(root, "openclaw-home-file");
  writeFileSync(fakeHomeFile, "not a directory\n", "utf8");

  const lifecycle = createLifecycle({
    applyChangeset: async () => {
      throw new Error("simulated api outage");
    },
  });

  await withEnv(
    {
      OPENCLAW_HOME: fakeHomeFile,
      ORGX_OUTBOX_DIR: null,
    },
    async () => {
      const result = await lifecycle.requestDecisionSafe({
        initiativeId: "init-3",
        correlationId: "corr-3",
        title: "Need fallback but storage is broken",
        blocking: true,
      });
      assert.equal(result?.queued, false);
      assert.ok(Array.isArray(result?.decisionIds));
    }
  );
});
