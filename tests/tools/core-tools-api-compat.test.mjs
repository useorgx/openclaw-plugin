import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

async function importMcpHandler() {
  const url = new URL("../../dist/mcp-http-handler.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function createDeps(overrides = {}) {
  let recordedQuality = null;
  let updatedEntity = null;

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      getMorningBrief: async () => ({ session: { id: "session-1" } }),
      queryOrgMemory: async () => ({ results: [{ id: "artifact-1" }] }),
      recommendNextAction: async () => ({ recommendations: [{ id: "rec-1" }] }),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async (type, id, updates) => {
        updatedEntity = { type, id, updates };
        return { entity: { id, ...updates } };
      },
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      recordQuality: async (payload) => {
        recordedQuality = payload;
        return { success: true };
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

  return {
    deps,
    getRecordedQuality: () => recordedQuality,
    getUpdatedEntity: () => updatedEntity,
  };
}

test("compatibility tools are registered with strict schemas", () => {
  const { deps } = createDeps();
  const tools = registerCoreTools(deps);

  const toolNames = [
    "orgx_get_morning_brief",
    "orgx_query_org_memory",
    "orgx_recommend_next_action",
  ];

  for (const name of toolNames) {
    const tool = tools.get(name);
    assert.ok(tool, `expected ${name} to be registered`);
    assert.equal(tool.parameters?.type, "object");
    assert.equal(tool.parameters?.additionalProperties, false);
  }
});

test("orgx_status forwards the agent task filter", async () => {
  let receivedFilter = null;
  const { deps } = createDeps({
    getCachedSnapshot: () => ({ activeTasks: [], syncedAt: "now" }),
    getLastSnapshotAt: () => Date.now(),
    formatSnapshot: (_snapshot, filter) => {
      receivedFilter = filter;
      return "filtered snapshot";
    },
  });
  const tool = registerCoreTools(deps).get("orgx_status");

  const result = await tool.execute("call-status", {
    agent_id: "operations-agent",
    domain: "operations",
    canonical_only: true,
  });

  assert.equal(result.content[0].text, "filtered snapshot");
  assert.deepEqual(receivedFilter, {
    agentId: "operations-agent",
    domain: "operations",
    canonicalOnly: true,
  });
});

test("orgx_spawn_check forwards explicit standard model tier", async () => {
  let spawnArgs = null;
  const { deps } = createDeps({
    client: {
      ...createDeps().deps.client,
      checkSpawnGuard: async (...args) => {
        spawnArgs = args;
        return {
          allowed: true,
          modelTier: "standard",
          checks: {
            rateLimit: { passed: true, current: 0, max: 5 },
            qualityGate: { passed: true, score: 5, threshold: 2.5 },
            taskAssigned: { passed: true, taskId: "task-1", status: "found" },
          },
        };
      },
    },
  });
  const tool = registerCoreTools(deps).get("orgx_spawn_check");

  const result = await tool.execute("call-spawn", {
    domain: "engineering",
    taskId: "task-1",
    modelTier: "standard",
  });

  assert.deepEqual(spawnArgs, ["engineering", "task-1", "standard"]);
  assert.match(result.content[0].text, /model tier: standard/);
});

test("orgx_quality_score accepts agentDomain-only requests", async () => {
  const { deps, getRecordedQuality } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_quality_score");

  const result = await tool.execute("call-quality", {
    taskId: "task-1",
    agentDomain: "engineering",
    score: 5,
  });

  assert.match(result.content[0].text, /Quality score recorded: 5\/5/);
  assert.deepEqual(getRecordedQuality(), {
    taskId: "task-1",
    agentDomain: "engineering",
    score: 5,
  });
});

test("orgx_update_entity normalizes legacy workstream in_progress status", async () => {
  const { deps, getUpdatedEntity } = createDeps();
  const tool = registerCoreTools(deps).get("orgx_update_entity");

  const result = await tool.execute("call-update-workstream", {
    type: "workstream",
    id: "workstream-1",
    status: "in_progress",
  });

  assert.match(result.content[0].text, /Updated workstream/);
  assert.deepEqual(getUpdatedEntity(), {
    type: "workstream",
    id: "workstream-1",
    updates: { status: "active" },
  });
});

test("compatibility tools appear in all scoped MCP domains", async () => {
  const mod = await importMcpHandler();

  const toolNames = [
    "orgx_get_morning_brief",
    "orgx_query_org_memory",
    "orgx_recommend_next_action",
  ];

  const tools = new Map();
  for (const name of toolNames) {
    tools.set(name, {
      name,
      description: `test ${name}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
  }

  const handler = mod.createMcpHttpHandler({
    tools,
    serverName: "orgx-test",
    serverVersion: "0.0.0",
  });

  const domains = [
    "engineering",
    "product",
    "design",
    "marketing",
    "sales",
    "operations",
    "orchestration",
  ];

  for (const domain of domains) {
    const req = {
      method: "POST",
      url: `/orgx/mcp/${domain}`,
      headers: {},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `compat-${domain}`,
        method: "tools/list",
        params: {},
      }),
    };
    const state = { status: null, body: null };
    const res = {
      writeHead(status) {
        state.status = status;
      },
      end(body) {
        state.body = body ?? null;
      },
    };
    await handler(req, res);

    assert.equal(state.status, 200);
    const payload = JSON.parse(state.body);
    const names = payload.result.tools.map((tool) => tool.name);

    for (const name of toolNames) {
      assert.ok(names.includes(name), `${name} should be available in ${domain}`);
    }
  }
});
