import test from "node:test";
import assert from "node:assert/strict";

import { blockTaskIfActive } from "../dist/http/helpers/task-status-guard.js";

function clientWithStatus(status) {
  const updates = [];
  return {
    updates,
    listEntities: async () => ({
      data: [{ id: "task-1", status }],
    }),
    updateEntity: async (type, id, patch) => {
      updates.push({ type, id, patch });
      return { id, ...patch };
    },
  };
}

test("blockTaskIfActive never downgrades completed proof", async () => {
  const client = clientWithStatus("done");
  const result = await blockTaskIfActive(client, {
    taskId: "task-1",
    initiativeId: "initiative-1",
  });

  assert.deepEqual(result, {
    updated: false,
    reason: "terminal",
    status: "done",
  });
  assert.deepEqual(client.updates, []);
});

test("blockTaskIfActive blocks a currently runnable task", async () => {
  const client = clientWithStatus("todo");
  const result = await blockTaskIfActive(client, { taskId: "task-1" });

  assert.equal(result.updated, true);
  assert.deepEqual(client.updates, [
    { type: "task", id: "task-1", patch: { status: "blocked" } },
  ]);
});
