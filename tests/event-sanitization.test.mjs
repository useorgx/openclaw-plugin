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

test("classifyOutboxReplaySkip flags mock and invalid artifact events", async () => {
  const mod = await importFreshEventSanitization();

  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "progress",
      payload: {
        metadata: { mock: true },
      },
    }),
    "mock_event"
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
        initiative_id: "11111111-1111-1111-1111-111111111111",
      },
    }),
    "missing_artifact_entity_id"
  );

  assert.equal(
    mod.classifyOutboxReplaySkip({
      type: "artifact",
      payload: {
        initiative_id: "11111111-1111-1111-1111-111111111111",
        entity_id: "artifact-local-1",
      },
    }),
    "synthetic_artifact_entity_id"
  );
});

test("shouldHideActivityItem hides synthetic and mock activity while preserving valid events", async () => {
  const mod = await importFreshEventSanitization();

  assert.equal(
    mod.shouldHideActivityItem(baseActivity({ metadata: { is_mock: true } })),
    true
  );
  assert.equal(
    mod.shouldHideActivityItem(baseActivity({ initiativeId: "task-local-123" })),
    true
  );
  assert.equal(
    mod.shouldHideActivityItem(baseActivity({ metadata: { entity_id: "artifact-local-1" } })),
    true
  );

  assert.equal(mod.shouldHideActivityItem(baseActivity()), false);
});
