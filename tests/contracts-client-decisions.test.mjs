import test from "node:test";
import assert from "node:assert/strict";

test("OrgXClient.decideDecision sends null for legacy fields to clear them", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com", "user-1");

  const calls = [];
  client.updateEntity = async (_type, _id, updates) => {
    calls.push(updates);
    return { id: "dec-1" };
  };

  await client.decideDecision("dec-1", "approve", { note: "looks good" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "approved");
  assert.equal(calls[0].resolution, "approved");
  assert.ok(!Object.hasOwn(calls[0], "option_id"));
  // Legacy fields are sent as null to clear them from stored entities
  assert.equal(calls[0].decided_at, null);
  assert.equal(calls[0].decided_by, null);
  assert.equal(calls[0].resolved_at, null);
});

test("OrgXClient.decideDecision fallback also nulls legacy fields", async () => {
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
  assert.equal(calls[0].status, "declined");
  assert.equal(calls[1].status, "resolved");
  assert.equal(calls[1].decision_status, "declined");
  // Both paths clear legacy fields
  assert.equal(calls[0].decided_at, null);
  assert.equal(calls[0].decided_by, null);
  assert.equal(calls[0].resolved_at, null);
  assert.equal(calls[1].decided_at, null);
  assert.equal(calls[1].decided_by, null);
  assert.equal(calls[1].resolved_at, null);
});

test("OrgXClient.decideDecision forwards selected option id", async () => {
  const { OrgXClient } = await import("../dist/contracts/client.js");
  const client = new OrgXClient("oxk_test", "https://www.useorgx.com", "user-1");

  const calls = [];
  client.updateEntity = async (_type, _id, updates) => {
    calls.push(updates);
    return { id: "dec-3" };
  };

  await client.decideDecision("dec-3", "approve", {
    optionId: "unblock_workstream",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "approved");
  assert.equal(calls[0].option_id, "unblock_workstream");
});
