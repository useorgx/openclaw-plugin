import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

const INITIATIVE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSTREAM_ID = "22222222-2222-4222-8222-222222222222";
const WORKSTREAM_A = "33333333-3333-4333-8333-333333333333";
const WORKSTREAM_B = "44444444-4444-4444-8444-444444444444";

function createDeps(overrides = {}) {
  const calls = [];
  const overrideClientList = overrides.client?.listEntities;
  const overrideClientUpdate = overrides.client?.updateEntityDetailed;
  const deps = {
    registerTool: () => {},
    client: {},
    config: { syncIntervalMs: 10_000, pluginVersion: "test" },
    getCachedSnapshot: () => null,
    getLastSnapshotAt: () => 0,
    doSync: async () => {},
    text: (value) => ({ content: [{ type: "text", text: value }] }),
    json: (label, data) => ({ content: [{ type: "text", text: `${label}\n${JSON.stringify(data)}` }] }),
    formatSnapshot: () => "snapshot",
    autoAssignEntityForCreate: async () => ({ assignmentSource: "manual", assignedAgents: [], warnings: [] }),
    toReportingPhase: () => "implementation",
    inferReportingInitiativeId: () => undefined,
    isUuid: (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
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

  deps.client = {
    ...(overrides.client ?? {}),
    listEntities: async () =>
      overrideClientList
        ? overrideClientList()
        : {
            data: [
              { id: WORKSTREAM_ID, domain: "product-before" },
              { id: WORKSTREAM_A, domain: "ops-before" },
              { id: WORKSTREAM_B, domain: "eng-before" },
            ],
          },
    updateEntityDetailed: async (type, id, updates) => {
      calls.push({ type, id, updates });
      if (overrideClientUpdate) {
        return overrideClientUpdate(type, id, updates);
      }
      return {
        entity: { id, ...updates },
        reassignment: { scheduled: true, requestId: "req-1" },
        initiative_reassignment: null,
      };
    },
  };

  return { deps, calls };
}

test("orgx_reassign_stream exposes strict schema", () => {
  const { deps } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_stream");

  assert.ok(tool, "expected orgx_reassign_stream to be registered");
  assert.deepEqual(tool.parameters.required, ["workstream_id", "initiative_id"]);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("orgx_reassign_stream requires at least one reassignment mutation field", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_stream");

  const result = await tool.execute("call-1", {
    workstream_id: WORKSTREAM_ID,
    initiative_id: INITIATIVE_ID,
  });

  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /Include at least one reassignment field/);
});

test("orgx_reassign_stream maps aliases and returns reassignment metadata", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_stream");

  const result = await tool.execute("call-2", {
    workstream_id: WORKSTREAM_ID,
    initiative_id: INITIATIVE_ID,
    status: "in_progress",
    domain: "engineering",
    assignedAgentIds: ["agent-1", "agent-2"],
    assignedAgentNames: ["Agent One", "Agent Two"],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "workstream");
  assert.equal(calls[0].id, WORKSTREAM_ID);
  assert.deepEqual(calls[0].updates, {
    initiative_id: INITIATIVE_ID,
    status: "in_progress",
    domain: "engineering",
    assigned_agent_ids: ["agent-1", "agent-2"],
    assigned_agent_names: ["Agent One", "Agent Two"],
  });

  const payloadText = result.content[0].text.split("\n").slice(1).join("\n");
  const payload = JSON.parse(payloadText);
  assert.equal(payload.workstream_id, WORKSTREAM_ID);
  assert.equal(payload.before_domain, "product-before");
  assert.equal(payload.after_domain, "engineering");
  assert.equal(payload.reassignment?.scheduled, true);
  assert.equal(payload.reassignment?.requestId, "req-1");
});

test("orgx_reassign_stream validates UUID identifiers", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_stream");

  const result = await tool.execute("call-3", {
    workstream_id: "ws-3",
    initiative_id: INITIATIVE_ID,
    domain: "engineering",
  });

  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /workstream_id must be a valid UUID/);
});

test("orgx_reassign_streams exposes strict schema", () => {
  const { deps } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");

  assert.ok(tool, "expected orgx_reassign_streams to be registered");
  assert.deepEqual(tool.parameters.required, ["initiative_id"]);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("orgx_reassign_streams validates workstream_domains payload", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");

  const result = await tool.execute("call-batch-invalid", {
    initiative_id: INITIATIVE_ID,
    workstream_domains: {},
  });

  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /Include workstream_domains, mapping, or mappings/);
});

test("orgx_reassign_streams validates workstream UUID map keys", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");

  const result = await tool.execute("call-batch-invalid-key", {
    initiative_id: INITIATIVE_ID,
    workstream_domains: { "not-a-uuid": "engineering" },
  });

  assert.equal(calls.length, 0);
  assert.match(result.content[0].text, /must be a valid UUID/);
});

test("orgx_reassign_streams reassigns all mapped workstreams", async () => {
  const { deps, calls } = createDeps();
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");

  const result = await tool.execute("call-bulk", {
    initiative_id: INITIATIVE_ID,
    status: "in_progress",
    workstream_domains: {
      [WORKSTREAM_A]: "engineering",
      [WORKSTREAM_B]: "operations",
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    type: "workstream",
    id: WORKSTREAM_A,
    updates: {
      initiative_id: INITIATIVE_ID,
      domain: "engineering",
      status: "in_progress",
    },
  });
  assert.deepEqual(calls[1], {
    type: "workstream",
    id: WORKSTREAM_B,
    updates: {
      initiative_id: INITIATIVE_ID,
      domain: "operations",
      status: "in_progress",
    },
  });

  const payloadText = result.content[0].text.split("\n").slice(1).join("\n");
  const payload = JSON.parse(payloadText);
  assert.equal(payload.updated_count, 2);
  assert.equal(payload.failed_count, 0);
  assert.equal(payload.updates.length, 2);
  assert.equal(payload.updates[0].ok, true);
  assert.equal(payload.updates[0].before_domain, "ops-before");
  assert.equal(payload.updates[0].after_domain, "engineering");
  assert.equal(payload.updates[1].before_domain, "eng-before");
  assert.equal(payload.updates[1].after_domain, "operations");
});

test("orgx_reassign_streams returns per-workstream failures", async () => {
  const { deps } = createDeps({
    client: {
      updateEntityDetailed: async (_type, id, updates) => {
        if (id === WORKSTREAM_B) {
          throw new Error("upstream failed");
        }
        return {
          entity: { id, ...updates },
          reassignment: { scheduled: true, requestId: "req-1" },
          initiative_reassignment: null,
        };
      },
    },
  });
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");
  const result = await tool.execute("call-bulk-failure", {
    initiative_id: INITIATIVE_ID,
    workstream_domains: {
      [WORKSTREAM_A]: "engineering",
      [WORKSTREAM_B]: "operations",
    },
  });

  const payloadText = result.content[0].text.split("\n").slice(1).join("\n");
  const payload = JSON.parse(payloadText);
  assert.equal(payload.updated_count, 1);
  assert.equal(payload.failed_count, 1);
  assert.equal(payload.updates[1].workstream_id, WORKSTREAM_B);
  assert.equal(payload.updates[1].ok, false);
  assert.equal(payload.updates[1].before_domain, "eng-before");
  assert.equal(payload.updates[1].after_domain, null);
  assert.match(payload.updates[1].error, /upstream failed/);
});

test("orgx_reassign_streams falls back to reassignment metadata for before/after domains", async () => {
  const { deps } = createDeps({
    client: {
      listEntities: async () => ({ data: [] }),
      updateEntityDetailed: async (_type, id, updates) => ({
        entity: { id, ...updates },
        reassignment: {
          scheduled: true,
          requestId: "req-2",
          before_domain: "product",
          after_domain: "engineering",
        },
        initiative_reassignment: null,
      }),
    },
  });
  const tools = registerCoreTools(deps);
  const tool = tools.get("orgx_reassign_streams");
  const result = await tool.execute("call-bulk-metadata-fallback", {
    initiative_id: INITIATIVE_ID,
    workstream_domains: {
      [WORKSTREAM_A]: "engineering",
    },
  });

  const payloadText = result.content[0].text.split("\n").slice(1).join("\n");
  const payload = JSON.parse(payloadText);
  assert.equal(payload.updated_count, 1);
  assert.equal(payload.failed_count, 0);
  assert.equal(payload.updates[0].before_domain, "product");
  assert.equal(payload.updates[0].after_domain, "engineering");
});
