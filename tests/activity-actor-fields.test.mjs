import test from "node:test";
import assert from "node:assert/strict";

async function importFreshActivityActorFields() {
  const url = new URL("../dist/activity-actor-fields.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function baseItem(overrides = {}) {
  return {
    id: "evt-1",
    type: "message",
    title: "Activity update",
    description: null,
    agentId: null,
    agentName: null,
    requesterAgentId: null,
    requesterAgentName: null,
    executorAgentId: null,
    executorAgentName: null,
    runId: "run-1",
    initiativeId: "11111111-1111-1111-1111-111111111111",
    timestamp: new Date().toISOString(),
    phase: "execution",
    summary: "Activity update",
    metadata: {},
    ...overrides,
  };
}

test("ignores numeric requester_id metadata as actor identity", async () => {
  const mod = await importFreshActivityActorFields();
  const item = baseItem({
    metadata: {
      requester_id: "5",
      source_client: "openclaw",
    },
  });

  const enriched = mod.enrichActivityActorFields(item);
  assert.equal(enriched.requesterAgentId, null);
  assert.equal(enriched.requesterAgentName, null);
});

test("preserves explicit requester/executor agent metadata", async () => {
  const mod = await importFreshActivityActorFields();
  const item = baseItem({
    metadata: {
      requested_by_agent_id: "orchestrator-agent",
      requested_by_agent_name: "OrgX Orchestrator",
      executed_by_agent_id: "engineering-agent",
      executed_by_agent_name: "OrgX Engineering",
    },
  });

  const enriched = mod.enrichActivityActorFields(item);
  assert.equal(enriched.requesterAgentId, "orchestrator-agent");
  assert.equal(enriched.requesterAgentName, "OrgX Orchestrator");
  assert.equal(enriched.executorAgentId, "engineering-agent");
  assert.equal(enriched.executorAgentName, "OrgX Engineering");
});

test("drops opaque numeric executor id and name", async () => {
  const mod = await importFreshActivityActorFields();
  const item = baseItem({
    metadata: {
      executed_by_agent_id: "5",
      executed_by_agent_name: "5",
    },
  });

  const enriched = mod.enrichActivityActorFields(item);
  assert.equal(enriched.executorAgentId, null);
  assert.equal(enriched.executorAgentName, null);
});

