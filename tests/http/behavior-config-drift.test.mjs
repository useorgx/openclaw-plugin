import test from "node:test";
import assert from "node:assert/strict";

import { detectBehaviorConfigDrift } from "../../dist/http/helpers/mission-control.js";

function buildNode(overrides = {}) {
  return {
    id: "n1",
    type: "task",
    title: "Node",
    status: "todo",
    parentId: null,
    initiativeId: "init-1",
    workstreamId: "ws-1",
    milestoneId: null,
    priorityNum: 0,
    priorityLabel: "P2",
    dependencyIds: [],
    dueDate: null,
    etaEndAt: null,
    expectedDurationHours: 2,
    expectedBudgetUsd: 100,
    assignedAgents: [],
    behaviorConfigId: null,
    behaviorConfigVersion: null,
    behaviorConfigHash: null,
    behaviorPolicySource: null,
    behaviorContext: null,
    behaviorRequiresApproval: null,
    behaviorApprovalStatus: null,
    behaviorApprovalDecisionId: null,
    behaviorAutomationLevel: null,
    updatedAt: null,
    ...overrides,
  };
}

test("detectBehaviorConfigDrift ignores whitespace-only context differences", () => {
  const taskNode = buildNode({
    type: "task",
    behaviorConfigId: "default",
    behaviorConfigVersion: "v1",
    behaviorConfigHash: "h1",
    behaviorContext: "Always run targeted checks only.",
    behaviorAutomationLevel: "auto",
  });
  const workstreamNode = buildNode({
    id: "ws-1",
    type: "workstream",
    behaviorConfigId: "default",
    behaviorConfigVersion: "v1",
    behaviorConfigHash: "h1",
    behaviorContext: "Always run   targeted checks only.",
    behaviorAutomationLevel: "auto",
  });
  const drift = detectBehaviorConfigDrift({
    taskNode,
    workstreamNode,
    behaviorConfig: {
      configId: taskNode.behaviorConfigId,
      version: taskNode.behaviorConfigVersion,
      hash: taskNode.behaviorConfigHash,
      policySource: taskNode.behaviorPolicySource,
      context: taskNode.behaviorContext,
    },
    behaviorAutomationLevel: "auto",
  });
  assert.equal(drift, null);
});

test("detectBehaviorConfigDrift flags context drift when text meaning differs", () => {
  const taskNode = buildNode({
    type: "task",
    behaviorConfigId: "default",
    behaviorConfigVersion: "v1",
    behaviorConfigHash: "h1",
    behaviorContext: "Always run targeted checks only.",
    behaviorAutomationLevel: "auto",
  });
  const workstreamNode = buildNode({
    id: "ws-1",
    type: "workstream",
    behaviorConfigId: "default",
    behaviorConfigVersion: "v1",
    behaviorConfigHash: "h1",
    behaviorContext: "Always run full test suite.",
    behaviorAutomationLevel: "auto",
  });
  const drift = detectBehaviorConfigDrift({
    taskNode,
    workstreamNode,
    behaviorConfig: {
      configId: taskNode.behaviorConfigId,
      version: taskNode.behaviorConfigVersion,
      hash: taskNode.behaviorConfigHash,
      policySource: taskNode.behaviorPolicySource,
      context: taskNode.behaviorContext,
    },
    behaviorAutomationLevel: "auto",
  });
  assert.ok(drift);
  assert.ok(Array.isArray(drift.fields));
  assert.ok(drift.fields.includes("context"));
});
