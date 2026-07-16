import test from "node:test";
import assert from "node:assert/strict";

import { OrgXClient } from "../dist/contracts/client.js";

test("OrgXClient routes attention requests, polls, and receipts through the canonical endpoints", async () => {
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com", "user-1");
  const calls = [];
  client.post = async (path, body) => {
    calls.push({ method: "POST", path, body });
    return { ok: true };
  };
  client.get = async (path) => {
    calls.push({ method: "GET", path });
    return { ok: true };
  };

  await client.requestAttention({
    initiative_id: "initiative-1",
    attention_kind: "question",
    idempotency_key: "attention-1",
    question: "Which direction?",
    source_tool: "openclaw.ask",
  });
  await client.pollAttention("decision/with spaces");
  await client.acknowledgeAttention("decision/with spaces", {
    state: "resumed",
    idempotency_key: "receipt-1",
  });

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/api/client/live/attention",
      body: {
        initiative_id: "initiative-1",
        attention_kind: "question",
        idempotency_key: "attention-1",
        question: "Which direction?",
        source_tool: "openclaw.ask",
      },
    },
    {
      method: "GET",
      path: "/api/client/live/attention/decision%2Fwith%20spaces",
    },
    {
      method: "POST",
      path: "/api/client/live/attention/decision%2Fwith%20spaces",
      body: { state: "resumed", idempotency_key: "receipt-1" },
    },
  ]);
});
