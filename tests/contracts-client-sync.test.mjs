import test from "node:test";
import assert from "node:assert/strict";

function makeSyncResponse(overrides = {}) {
  return {
    ok: true,
    data: {
      initiatives: [{ id: "init-1", title: "Initiative One", status: "active" }],
      activeTasks: [
        {
          id: "task-1",
          title: "Task One",
          status: "in_progress",
          domain: "engineering",
          modelTier: "sonnet",
        },
      ],
      pendingDecisions: [{ id: "dec-1", title: "Decision One", urgency: "high" }],
      qualityStats: [],
      modelPolicy: {},
      workspaceState: {},
      memoryCursor: { lastSyncEventId: null, lastAppliedHandoffId: null },
      syncedAt: "2026-02-19T00:00:00.000Z",
      ...overrides,
    },
  };
}

test("OrgXClient.getOrgSnapshot maps agents from /api/client/sync", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const body = makeSyncResponse({
      agents: [
        {
          id: "agent-1",
          name: "Engineering Agent",
          domain: "engineering",
          status: "active",
          currentTask: "task-1",
          lastActive: "2026-02-19T00:00:00.000Z",
        },
      ],
    });

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const snapshot = await client.getOrgSnapshot();
    assert.equal(snapshot.agents.length, 1);
    assert.deepEqual(snapshot.agents[0], {
      id: "agent-1",
      name: "Engineering Agent",
      domain: "engineering",
      status: "active",
      currentTask: "task-1",
      lastActive: "2026-02-19T00:00:00.000Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient.getOrgSnapshot stays backward-compatible when sync omits agents", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(makeSyncResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const snapshot = await client.getOrgSnapshot();
    assert.deepEqual(snapshot.agents, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient.syncMemory forwards agents and accepts direct sync response", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify(
        makeSyncResponse({
          agents: [
            {
              id: "agent-2",
              name: "Ops Agent",
              domain: "operations",
              status: "idle",
            },
          ],
        }).data
      ),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const response = await client.syncMemory({
      dailyLog: "daily",
      agents: [
        {
          id: "agent-local-1",
          name: "Local Agent",
          domain: "engineering",
          status: "active",
          currentTask: "task-1",
        },
      ],
    });

    assert.deepEqual(requestBody?.agents, [
      {
        id: "agent-local-1",
        name: "Local Agent",
        domain: "engineering",
        status: "active",
        currentTask: "task-1",
      },
    ]);
    assert.equal(response.agents?.[0]?.id, "agent-2");
    assert.equal(response.agents?.[0]?.status, "idle");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
