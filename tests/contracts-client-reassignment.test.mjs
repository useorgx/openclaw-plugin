import test from "node:test";
import assert from "node:assert/strict";

test("OrgXClient.updateEntityDetailed preserves reassignment metadata", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        entity: {
          id: "ws-1",
          type: "workstream",
          title: "Workstream",
          status: "active",
        },
        reassignment: {
          scheduled: true,
          requestId: "req-1",
          dueAt: null,
        },
        initiative_reassignment: null,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const result = await client.updateEntityDetailed("workstream", "ws-1", {
      assignedAgentIds: ["agent-2"],
    });

    assert.equal(result.entity.id, "ws-1");
    assert.equal(result.reassignment?.scheduled, true);
    assert.equal(result.reassignment?.requestId, "req-1");
    assert.equal(result.initiative_reassignment, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OrgXClient.updateEntity remains compatible with entity-only callers", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        entity: {
          id: "init-1",
          type: "initiative",
          title: "Initiative",
          status: "active",
        },
        initiative_reassignment: {
          triggered: true,
          requested: 2,
          scheduled: 2,
          skipped: 0,
          failures: [],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const entity = await client.updateEntity("initiative", "init-1", {
      assignedAgentIds: ["agent-2"],
    });

    assert.equal(entity.id, "init-1");
    assert.equal(entity.status, "active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
