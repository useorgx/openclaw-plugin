import test from "node:test";
import assert from "node:assert/strict";

async function importFreshEventSanitization() {
  const url = new URL("../dist/event-sanitization.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function baseActivity(overrides = {}) {
  return {
    id: "evt-1",
    type: "progress",
    title: "Legit update",
    description: "Normal execution update",
    agentId: null,
    agentName: null,
    runId: null,
    initiativeId: "11111111-1111-1111-1111-111111111111",
    timestamp: new Date().toISOString(),
    phase: "execution",
    summary: "Normal execution update",
    metadata: {},
    ...overrides,
  };
}

test("isUuid and isSyntheticIdentifier correctly classify ids", async () => {
  const mod = await importFreshEventSanitization();

  assert.equal(mod.isUuid("11111111-1111-1111-1111-111111111111"), true);
  assert.equal(mod.isUuid("task-abc"), false);

  assert.equal(mod.isSyntheticIdentifier("task-abc"), true);
  assert.equal(mod.isSyntheticIdentifier("demo-initiative"), true);
  assert.equal(mod.isSyntheticIdentifier("11111111-1111-1111-1111-111111111111"), false);
});

test("classifyOutboxReplaySkip only skips mock events when explicitly enabled", async () => {
  const mod = await importFreshEventSanitization();
  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "progress",
      payload: {
        metadata: { mock: true },
      },
    }),
    null
  );
  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "artifact",
      payload: {
        initiative_id: "init-local-1",
      },
    }),
    "synthetic_initiative_id"
  );
  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "artifact",
      payload: {
        source_client: "openclaw",
        initiative_id: "init-local-1",
        entity_type: "workstream",
        entity_id: "ws-1",
      },
      activityItem: baseActivity({
        id: "evt-local-artifact",
        metadata: { event: "autopilot_slice_artifact_buffered" },
      }),
    }),
    null
  );
  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "artifact",
      payload: {
        source_client: "OpenClaw",
        initiative_id: "init-local-2",
        entity_type: "workstream",
      },
    }),
    null
  );
  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "artifact",
      payload: {
        initiative_id: "init-local-3",
        entity_type: "workstream",
      },
      activityItem: baseActivity({
        id: "evt-local-artifact-upper",
        metadata: { event: "AUTOPILOT_SLICE_ARTIFACT_BUFFERED" },
      }),
    }),
    null
  );
});

test("shouldHideActivityItem hides mock activity only when env toggle is enabled", async () => {
  const mod = await importFreshEventSanitization();
  assert.equal(
    mod.shouldHideActivityItem(baseActivity({ metadata: { is_mock: true } })),
    false
  );
  assert.equal(mod.shouldHideActivityItem(baseActivity()), false);
});

test("mock marker detection avoids substring false positives", async () => {
  process.env.ORGX_SKIP_MOCK_OUTBOX_REPLAY = "true";
  try {
    const mod = await importFreshEventSanitization();
    assert.equal(
      mod.classifyOutboxReplaySkip({
        type: "progress",
        payload: {
          metadata: { source: "latest-prod" },
        },
      }),
      null
    );
    assert.equal(
      mod.classifyOutboxReplaySkip({
        type: "progress",
        payload: {
          metadata: { source: "test-runner" },
        },
      }),
      "mock_event"
    );
  } finally {
    delete process.env.ORGX_SKIP_MOCK_OUTBOX_REPLAY;
  }
});
