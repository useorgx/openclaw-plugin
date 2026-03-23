import test from "node:test";
import assert from "node:assert/strict";

async function importMcpHandler() {
  const url = new URL("../../dist/mcp-http-handler.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("preferred read surfaces are registered by registerCoreTools", async () => {
  const { registerCoreTools } = await import("../../dist/tools/core-tools.js");

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      queryOrgMemory: async () => ({ results: [] }),
      recommendNextAction: async () => ({ recommendations: [] }),
      getMorningBrief: async () => ({ workspace_id: "ws_123", session_summary: null }),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      rawRequest: async () => ({}),
    },
    config: { syncIntervalMs: 10_000, pluginVersion: "test" },
    getCachedSnapshot: () => null,
    getLastSnapshotAt: () => 0,
    doSync: async () => {},
    text: (v) => ({ content: [{ type: "text", text: v }] }),
    json: (l, d) => ({ content: [{ type: "text", text: `${l}\n${JSON.stringify(d)}` }] }),
    formatSnapshot: () => "snapshot",
    autoAssignEntityForCreate: async () => ({ assignmentSource: "manual", assignedAgents: [], warnings: [] }),
    toReportingPhase: () => "execution",
    inferReportingInitiativeId: () => undefined,
    isUuid: () => true,
    pickNonEmptyString: (...vs) => vs.find((v) => typeof v === "string" && v.trim())?.trim(),
    resolveReportingContext: () => ({ ok: false, error: "unused" }),
    readSkillPackState: () => ({}),
    randomUUID: () => "uuid-test",
  };

  const tools = registerCoreTools(deps);

  for (const name of [
    "orgx_query_org_memory",
    "orgx_recommend_next_action",
    "orgx_get_morning_brief",
  ]) {
    const tool = tools.get(name);
    assert.ok(tool, `expected ${name} to be registered`);
    assert.equal(typeof tool.execute, "function", `${name} should have an execute function`);
    assert.ok(tool.description, `${name} should have a description`);
  }
});

test("preferred read surfaces appear in all 7 domain scopes", async () => {
  const mod = await importMcpHandler();

  const toolNames = [
    "orgx_query_org_memory",
    "orgx_recommend_next_action",
    "orgx_get_morning_brief",
  ];

  const tools = new Map();
  for (const name of toolNames) {
    tools.set(name, {
      name,
      description: `test ${name}`,
      parameters: { type: "object", properties: {} },
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
      body: JSON.stringify({ jsonrpc: "2.0", id: `scope-${domain}`, method: "tools/list", params: {} }),
    };
    const state = { status: null, headers: null, body: null };
    const res = {
      writeHead(s, h) { state.status = s; state.headers = h; },
      end(b) { state.body = b ?? null; },
    };
    await handler(req, res);
    assert.equal(state.status, 200, `${domain} should return 200`);

    const payload = JSON.parse(state.body);
    const names = payload.result.tools.map((t) => t.name);

    for (const name of toolNames) {
      assert.ok(names.includes(name), `${name} should be in ${domain} scope`);
    }
  }
});
