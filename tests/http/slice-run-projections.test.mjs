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

// ---------------------------------------------------------------------------
// Oscillation-fix regression tests
// ---------------------------------------------------------------------------

test("run_completed prevents final-pass downgrade to needs_review", () => {
  const projections = buildSliceRunProjections({
    activity: [
      activityBase(),
      activityBase({
        id: "act-2",
        type: "run_completed",
        title: "Accepted",
        timestamp: "2026-02-27T10:05:00.000Z",
        metadata: { event: "run_completed", slice_run_id: "slice-1" },
      }),
    ],
    sessions: [],
    runtimeInstances: [],
    decisions: [],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].status, "completed");
  assert.equal(projections[0].hasArtifact, false);
});

test("high-water artifact count prevents downgrade", () => {
  const projections = buildSliceRunProjections({
    activity: [
      activityBase(),
      activityBase({
        id: "act-2",
        type: "run_started",
        title: "Result with artifacts",
        timestamp: "2026-02-27T10:02:00.000Z",
        metadata: {
          event: "autopilot_slice_result",
          slice_run_id: "slice-1",
          artifacts: 1,
        },
      }),
      activityBase({
        id: "act-3",
        type: "run_started",
        title: "Result without artifacts",
        timestamp: "2026-02-27T10:03:00.000Z",
        metadata: {
          event: "autopilot_slice_result",
          slice_run_id: "slice-1",
          artifacts: 0,
        },
      }),
    ],
    sessions: [],
    runtimeInstances: [],
    decisions: [],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].status, "completed");
});

test("truncated artifact_created with reported artifacts stays completed", () => {
  const projections = buildSliceRunProjections({
    activity: [
      activityBase(),
      activityBase({
        id: "act-2",
        type: "run_started",
        title: "Result reported 1 artifact",
        timestamp: "2026-02-27T10:02:00.000Z",
        metadata: {
          event: "autopilot_slice_result",
          slice_run_id: "slice-1",
          artifacts: 1,
        },
      }),
      // No artifact_created activity follows (truncated by activity limit)
    ],
    sessions: [],
    runtimeInstances: [],
    decisions: [],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].status, "completed");
  // hasArtifact is true because reportedArtifacts > 0 sets it
  assert.equal(projections[0].hasArtifact, true);
});

test("genuine no-artifact completion gets needs_review", () => {
  const projections = buildSliceRunProjections({
    activity: [
      activityBase(),
      activityBase({
        id: "act-2",
        type: "run_started",
        title: "Result with zero artifacts",
        timestamp: "2026-02-27T10:02:00.000Z",
        metadata: {
          event: "autopilot_slice_result",
          slice_run_id: "slice-1",
          artifacts: 0,
        },
      }),
    ],
    sessions: [],
    runtimeInstances: [],
    decisions: [],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].status, "needs_review");
  assert.equal(projections[0].hasArtifact, false);
});

// ---------------------------------------------------------------------------

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

test("decision without metadata slice_run_id can map by decision runId", () => {
  const projections = buildSliceRunProjections({
    activity: [activityBase()],
    sessions: [],
    runtimeInstances: [],
    decisions: [
      {
        title: "Need confirmation",
        status: "pending",
        runId: "slice-1",
        options: [
          {
            id: "approve",
            label: "Approve",
          },
        ],
      },
    ],
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0].status, "awaiting_input");
  assert.equal(projections[0].decisionCount, 1);
  assert.equal(projections[0].blockingDecisionCount, 1);
  assert.equal(projections[0].decisionOptions.length, 1);
});
