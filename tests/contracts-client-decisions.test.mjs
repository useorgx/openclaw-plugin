import test from "node:test";
import assert from "node:assert/strict";

test("OrgXClient.decideDecision omits decided_at from primary decision updates", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com", "user-1");

  const calls = [];
  client.updateEntity = async (_type, _id, updates) => {
    calls.push(updates);
    return { id: "dec-1" };
  };

  await client.decideDecision("dec-1", "approve", "looks good");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "approved");
  assert.equal(calls[0].resolution, "approved");
  assert.equal(calls[0].decided_by, "user-1");
  assert.ok(!Object.hasOwn(calls[0], "decided_at"));
});

test("OrgXClient.decideDecision fallback also omits decided_at", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com", "user-1");

  const calls = [];
  let attempt = 0;
  client.updateEntity = async (_type, _id, updates) => {
    attempt += 1;
    calls.push(updates);
    if (attempt === 1) {
      throw new Error("simulate strict backend mismatch");
    }
    return { id: "dec-2" };
  };

  await client.decideDecision("dec-2", "reject");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].status, "rejected");
  assert.equal(calls[1].status, "resolved");
  assert.equal(calls[1].decision_status, "rejected");
  assert.ok(!Object.hasOwn(calls[0], "decided_at"));
  assert.ok(!Object.hasOwn(calls[1], "decided_at"));
});
