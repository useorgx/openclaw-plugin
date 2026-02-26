import test from "node:test";
import assert from "node:assert/strict";

import { buildDispatchGatewayEnvelope } from "../dist/http/routes/dispatch-gateway-envelope.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("dispatch gateway envelope preserves canonical play lineage and dedupes ids", () => {
  const payload = buildDispatchGatewayEnvelope({
    dispatchId: "dispatch-123",
    dispatchMode: "pending",
    route: "mission-control.next-up.play",
    source: "manual_play",
    initiativeId: "init-1",
    workstreamId: "ws-1",
    workstreamIds: ["ws-1", "ws-2", "ws-1"],
    taskIds: ["task-1", "task-1", "task-2", "   "],
  });

  assert.equal(payload.dispatchId, "dispatch-123");
  assert.equal(payload.executionPath, "orgx_orchestrator_gateway");
  assert.equal(payload.dispatchGateway, "orchestrator-agent");
  assert.equal(payload.dispatchLineage.route, "mission-control.next-up.play");
  assert.equal(payload.dispatchLineage.source, "manual_play");
  assert.equal(payload.dispatchLineage.initiativeId, "init-1");
  assert.equal(payload.dispatchLineage.workstreamId, "ws-1");
  assert.deepEqual(payload.dispatchLineage.workstreamIds, ["ws-1", "ws-2"]);
  assert.deepEqual(payload.dispatchLineage.taskIds, ["task-1", "task-2"]);
});

test("dispatch gateway envelope generates ids and normalizes empty lineage lists", () => {
  const payload = buildDispatchGatewayEnvelope({
    dispatchMode: "server",
    route: "mission-control.auto-continue.start",
    source: "auto_continue_start",
    initiativeId: "init-2",
    workstreamIds: null,
    taskIds: null,
  });

  assert.ok(UUID_REGEX.test(payload.dispatchId), "expected generated UUID dispatchId");
  assert.equal(payload.dispatchMode, "server");
  assert.equal(payload.dispatchLineage.route, "mission-control.auto-continue.start");
  assert.equal(payload.dispatchLineage.source, "auto_continue_start");
  assert.equal(payload.dispatchLineage.workstreamId, null);
  assert.deepEqual(payload.dispatchLineage.workstreamIds, []);
  assert.deepEqual(payload.dispatchLineage.taskIds, []);
});
