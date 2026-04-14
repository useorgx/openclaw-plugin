import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

function createDeps(overrides = {}) {
  const recordedPayloads = [];

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      getMorningBrief: async () => ({ session: { id: "session-1" } }),
      queryOrgMemory: async () => ({ results: [] }),
      recommendNextAction: async () => ({ recommendations: [] }),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      recordRunOutcome: async (payload) => {
        recordedPayloads.push(payload);
        return {
          ok: true,
          run_id: payload.run_id ?? "run-from-correlation",
          reused_run: false,
          execution_id: payload.execution_id,
          event_id: "event-1",
        };
      },
    },
    config: { syncIntervalMs: 10_000, pluginVersion: "test" },
    getCachedSnapshot: () => null,
    getLastSnapshotAt: () => 0,
    doSync: async () => {},
    text: (value) => ({ content: [{ type: "text", text: value }] }),
    json: (label, data) => ({ content: [{ type: "text", text: `${label}\n${JSON.stringify(data)}` }] }),
    formatSnapshot: () => "snapshot",
    autoAssignEntityForCreate: async () => ({ assignmentSource: "manual", assignedAgents: [], warnings: [] }),
    toReportingPhase: () => "execution",
    inferReportingInitiativeId: () => undefined,
    isUuid: () => true,
    pickNonEmptyString: (...values) => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return undefined;
    },
    resolveReportingContext: () => ({ ok: false, error: "unused" }),
    readSkillPackState: () => ({}),
    randomUUID: () => "uuid-test",
    ...overrides,
  };

  return { deps, recordedPayloads };
}

test("orgx_record_outcome has a strict schema", () => {
  const { deps } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_record_outcome");

  assert.ok(tool);
  assert.equal(tool.parameters?.type, "object");
  assert.equal(tool.parameters?.additionalProperties, false);
  assert.equal(tool.parameters?.properties?.source_client?.enum?.includes("codex"), true);
});

test("orgx_record_outcome derives reporting context for coordinator calls", async () => {
  const { deps, recordedPayloads } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_record_outcome");

  const result = await tool.execute("call-outcome", {
    initiative_id: "initiative-1",
    execution_id: "execution-1",
    agent_id: "orchestrator-agent",
    success: true,
    quality_score: 5,
    domain: "orchestrator",
    metadata: { outcome_type: "initiative_completed" },
  });

  assert.match(result.content[0].text, /Outcome recorded/);
  assert.deepEqual(recordedPayloads[0], {
    initiative_id: "initiative-1",
    execution_id: "execution-1",
    execution_type: "agent_run",
    agent_id: "orchestrator-agent",
    success: true,
    quality_score: 5,
    domain: "orchestrator",
    metadata: { outcome_type: "initiative_completed" },
    correlation_id: "execution-1",
    source_client: "openclaw",
  });
});

test("orgx_record_outcome forwards explicit run context overrides", async () => {
  const { deps, recordedPayloads } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_record_outcome");

  await tool.execute("call-outcome", {
    initiative_id: "initiative-1",
    execution_id: "execution-1",
    execution_type: "codex.coordinator",
    run_id: "run-1",
    correlation_id: "correlation-1",
    source_client: "codex",
    agent_id: "orchestrator-agent",
    success: true,
  });

  assert.deepEqual(recordedPayloads[0], {
    initiative_id: "initiative-1",
    execution_id: "execution-1",
    execution_type: "codex.coordinator",
    agent_id: "orchestrator-agent",
    success: true,
    quality_score: undefined,
    domain: undefined,
    metadata: undefined,
    run_id: "run-1",
  });
});
