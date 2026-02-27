import test from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_ACTIVITY_ACTION_PHASES,
  KNOWN_ACTIVITY_ACTION_TYPES,
  normalizeActivityActionPhase,
  normalizeActivityActionType,
  isKnownActivityActionType,
} from "../../dist/contracts/shared-types.js";

test("normalizeActivityActionType maps aliases and canonicalizes spacing", () => {
  assert.equal(normalizeActivityActionType("started"), "run_started");
  assert.equal(normalizeActivityActionType("completed"), "run_completed");
  assert.equal(normalizeActivityActionType("orchestrator dispatch"), "orchestrator_dispatch");
  assert.equal(normalizeActivityActionType(""), null);
  assert.equal(normalizeActivityActionType(null), null);
});

test("known activity action types include lifecycle actions used by auto-continue", () => {
  const required = [
    "orchestrator_dispatch",
    "dispatch_slice",
    "run_started",
    "run_heartbeat",
    "slice_handoff",
    "run_completed",
    "run_failed",
    "decision_requested",
    "decision_resolved",
    "status_updates_applied",
    "status_updates_buffered",
    "artifact_registered",
    "auto_fix",
    "run_state_transition",
    "auto_continue_started",
    "auto_continue_stopped",
  ];
  for (const actionType of required) {
    assert.ok(
      KNOWN_ACTIVITY_ACTION_TYPES.includes(actionType),
      `expected known action type: ${actionType}`
    );
    assert.equal(
      isKnownActivityActionType(actionType),
      true,
      `expected isKnownActivityActionType(${actionType})`
    );
  }
});

test("normalizeActivityActionPhase accepts only canonical phases", () => {
  for (const phase of KNOWN_ACTIVITY_ACTION_PHASES) {
    assert.equal(normalizeActivityActionPhase(phase), phase);
  }
  assert.equal(normalizeActivityActionPhase(" Completed "), "completed");
  assert.equal(normalizeActivityActionPhase("invalid"), null);
  assert.equal(normalizeActivityActionPhase(null), null);
});
