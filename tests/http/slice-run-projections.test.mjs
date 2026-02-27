import test from "node:test";
import assert from "node:assert/strict";

import { buildSliceRunProjections } from "../../dist/http/helpers/slice-run-projections.js";

function activityBase(overrides = {}) {
  return {
    id: "act-1",
    type: "run_started",
    title: "Slice started",
    description: null,
    agentId: null,
    agentName: null,
    requesterAgentId: null,
    requesterAgentName: null,
    executorAgentId: null,
    executorAgentName: null,
    runId: "slice-1",
    initiativeId: "init-1",
    timestamp: "2026-02-27T10:00:00.000Z",
    metadata: { event: "autopilot_slice_started", slice_run_id: "slice-1" },
    ...overrides,
  };
}

test("decision option requires_note parses string false as false", () => {
  const projections = buildSliceRunProjections({
    activity: [activityBase()],
    sessions: [],
    runtimeInstances: [],
    decisions: [
      {
        title: "Need confirmation",
        status: "pending",
        metadata: { slice_run_id: "slice-1", blocking: true },
        options: [
          {
            id: "approve",
            label: "Approve",
            requires_note: "false",
          },
        ],
      },
    ],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].decisionOptions.length, 1);
  assert.equal(projections[0].decisionOptions[0].requiresNote, false);
});
