import test from "node:test";
import assert from "node:assert/strict";

import { formatSnapshot } from "../dist/snapshot-format.js";

const snapshot = {
  workspaceId: "workspace-1",
  workspaceName: "OrgX",
  initiatives: [],
  agents: [],
  activeTasks: [
    {
      id: "task-ops",
      title: "Run heartbeat proof",
      status: "todo",
      domain: "operations",
      modelTier: "standard",
      canonicalGoalId: "goal-health",
      initiativeId: "initiative-health",
      workstreamId: "workstream-audit",
      assignedAgentIds: ["operations-agent"],
      canonicalNextTask: true,
      dispatchReady: true,
    },
    {
      id: "task-sales",
      title: "Schedule buyer run",
      status: "todo",
      domain: "sales",
      modelTier: "standard",
      assignedAgentIds: ["sales-agent"],
      canonicalNextTask: true,
    },
  ],
  pendingDecisions: [],
  syncedAt: "2026-07-10T00:00:00.000Z",
};

test("formatSnapshot exposes IDs and filters canonical work by agent", () => {
  const output = formatSnapshot(snapshot, {
    agentId: "operations-agent",
    domain: "operations",
    canonicalOnly: true,
  });

  assert.match(output, /\[task-ops\] Run heartbeat proof/);
  assert.match(output, /goal=goal-health/);
  assert.match(output, /initiative=initiative-health/);
  assert.doesNotMatch(output, /task-sales/);
});
