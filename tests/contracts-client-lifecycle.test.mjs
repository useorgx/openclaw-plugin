import test from "node:test";
import assert from "node:assert/strict";

import { OrgXClient } from "../dist/contracts/client.js";

test("manageLifecycle posts the canonical hierarchy-control payload", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        ok: true,
        level: "workstream",
        id: "11111111-1111-4111-8111-111111111111",
        action: "retry",
        affected: { nodes: 1, runsPaused: 0, runsCancelled: 0, redispatched: 1 },
        message: "Retrying workstream",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const client = new OrgXClient("oxk_test", "https://www.useorgx.com");
    const result = await client.manageLifecycle({
      level: "workstream",
      id: "11111111-1111-4111-8111-111111111111",
      action: "retry",
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.useorgx.com/api/client/lifecycle");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      level: "workstream",
      id: "11111111-1111-4111-8111-111111111111",
      action: "retry",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
