import test from "node:test";
import assert from "node:assert/strict";

test("OrgXClient.recordQuality normalizes legacy domain to agentDomain", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await client.recordQuality({
      taskId: "task-1",
      domain: "engineering",
      score: 5,
      notes: "clean pass",
    });

    assert.equal(result.success, true);
    assert.deepEqual(requestBody, {
      taskId: "task-1",
      agentDomain: "engineering",
      score: 5,
      notes: "clean pass",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient.recordQuality preserves explicit agentDomain", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await client.recordQuality({
      taskId: "task-2",
      agentDomain: "operations",
      score: 4,
    });

    assert.equal(result.success, true);
    assert.deepEqual(requestBody, {
      taskId: "task-2",
      agentDomain: "operations",
      score: 4,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient.getMorningBrief uses the flywheel brief route", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  let requestUrl = "";

  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({ session: { id: "session-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await client.getMorningBrief({
      workspace_id: "workspace-1",
      session_id: "session-1",
    });

    assert.equal(requestUrl, "https://www.useorgx.com/api/flywheel/briefs?workspace_id=workspace-1&session_id=session-1");
    assert.equal(result.session?.id, "session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient executes query_org_memory and recommend_next_action through /api/client/tools/execute", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const data =
      body.tool_id === "query_org_memory"
        ? { results: [{ id: "artifact-1" }] }
        : { recommendations: [{ id: "rec-1" }] };
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const memory = await client.queryOrgMemory({
      query: "pricing wins",
      scope: "decisions",
      limit: 3,
    });
    const recommendations = await client.recommendNextAction({
      entity_type: "workspace",
      entity_id: "default",
      workspace_id: "workspace-1",
      limit: 2,
    });

    assert.equal(memory.results.length, 1);
    assert.equal(recommendations.recommendations.length, 1);
    assert.deepEqual(requests, [
      {
        tool_id: "query_org_memory",
        args: {
          query: "pricing wins",
          scope: "decisions",
          limit: 3,
        },
      },
      {
        tool_id: "recommend_next_action",
        args: {
          entity_type: "workspace",
          entity_id: "default",
          workspace_id: "workspace-1",
          limit: 2,
        },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
