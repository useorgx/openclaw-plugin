import test from "node:test";
import assert from "node:assert/strict";

async function importMcpHandler() {
  const url = new URL("../../dist/mcp-http-handler.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

// ---------------------------------------------------------------------------
// 1. Tool registration – verify proof ladder tools exist in registerCoreTools
// ---------------------------------------------------------------------------

test("proof ladder tools are registered by registerCoreTools", async () => {
  const { registerCoreTools } = await import("../../dist/tools/core-tools.js");

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
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

  const proofTools = [
    "orgx_proof_status",
    "orgx_quality_score",
    "orgx_record_outcome",
    "orgx_get_outcome_attribution",
    "orgx_verify_completion",
  ];

  for (const name of proofTools) {
    const tool = tools.get(name);
    assert.ok(tool, `expected ${name} to be registered`);
    assert.equal(typeof tool.execute, "function", `${name} should have an execute function`);
    assert.ok(tool.description, `${name} should have a description`);
    assert.equal(tool.parameters?.type, "object", `${name} schema type should be "object"`);
  }
});

test("orgx_proof_status returns auth guidance for unauthorized responses", async () => {
  const { registerCoreTools } = await import("../../dist/tools/core-tools.js");

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      rawRequest: async () => {
        throw new Error("401 Unauthorized");
      },
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

  const tool = registerCoreTools(deps).get("orgx_proof_status");
  const result = await tool.execute("call-proof-auth", { task_id: "task-1" });

  assert.match(result.content[0].text, /Proof status requires authentication/);
  assert.match(result.content[0].text, /auth_required/);
});

// ---------------------------------------------------------------------------
// 2. MCP scope inclusion – proof tools in all 7 domain scopes
// ---------------------------------------------------------------------------

test("proof ladder tools appear in all 7 domain scopes", async () => {
  const mod = await importMcpHandler();

  const proofTools = [
    "orgx_proof_status",
    "orgx_quality_score",
    "orgx_record_outcome",
    "orgx_get_outcome_attribution",
    "orgx_verify_completion",
  ];

  // Build a tool map that includes every proof tool
  const tools = new Map();
  for (const name of proofTools) {
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

    for (const name of proofTools) {
      assert.ok(names.includes(name), `${name} should be in ${domain} scope`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Operations and orchestration retain their extra tools
// ---------------------------------------------------------------------------

test("operations and orchestration scopes include extra mutation tools", async () => {
  const mod = await importMcpHandler();

  const extraTools = ["orgx_apply_changeset", "orgx_reassign_stream", "orgx_reassign_streams"];
  const allToolNames = [
    "orgx_proof_status",
    "orgx_emit_activity",
    ...extraTools,
  ];

  const tools = new Map();
  for (const name of allToolNames) {
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

  for (const domain of ["operations", "orchestration"]) {
    const req = {
      method: "POST",
      url: `/orgx/mcp/${domain}`,
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: `extra-${domain}`, method: "tools/list", params: {} }),
    };
    const state = { status: null, headers: null, body: null };
    const res = {
      writeHead(s, h) { state.status = s; state.headers = h; },
      end(b) { state.body = b ?? null; },
    };
    await handler(req, res);
    const payload = JSON.parse(state.body);
    const names = payload.result.tools.map((t) => t.name);

    for (const name of extraTools) {
      assert.ok(names.includes(name), `${name} should be in ${domain} scope`);
    }
  }

  // Verify a non-privileged domain does NOT see the extra tools
  const req = {
    method: "POST",
    url: "/orgx/mcp/engineering",
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", id: "extra-eng", method: "tools/list", params: {} }),
  };
  const state = { status: null, headers: null, body: null };
  const res = {
    writeHead(s, h) { state.status = s; state.headers = h; },
    end(b) { state.body = b ?? null; },
  };
  await handler(req, res);
  const payload = JSON.parse(state.body);
  const names = payload.result.tools.map((t) => t.name);

  for (const name of extraTools) {
    assert.equal(names.includes(name), false, `${name} should NOT be in engineering scope`);
  }
});
