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
      description: "Run one scoped cycle and preserve the receipt.",
      status: "todo",
      domain: "operations",
      modelTier: "standard",
      canonicalGoalId: "goal-health",
      initiativeId: "initiative-health",
      workstreamId: "workstream-audit",
      assignedAgentIds: ["operations-agent"],
      canonicalNextTask: true,
      dispatchReady: true,
      acceptanceCriteria: ["All seven agents report a terminal outcome"],
      executionContext: {
        mode: "repository",
        repository: "https://github.com/useorgx/openclaw-plugin",
        workingDirectory: "/workspace/openclaw-plugin",
        branch: "main",
      },
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
  assert.match(output, /Context: Run one scoped cycle/);
  assert.match(output, /Acceptance: All seven agents report/);
  assert.match(output, /repository=https:\/\/github.com\/useorgx\/openclaw-plugin/);
  assert.match(output, /cwd=\/workspace\/openclaw-plugin/);
  assert.doesNotMatch(output, /task-sales/);
});
