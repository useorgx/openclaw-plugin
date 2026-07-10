import test from "node:test";
import assert from "node:assert/strict";

import {
  selectSliceTasksByScope,
  evaluateScopeCompletion,
  SLICE_SCOPE_MAX_TASKS,
  SLICE_SCOPE_TIMEOUT_MULTIPLIER,
} from "../../dist/http/helpers/mission-control.js";

import { buildScopeDirective } from "../../dist/http/helpers/autopilot-slice-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? "task",
    title: overrides.title ?? "Test task",
    status: overrides.status ?? "todo",
    parentId: null,
    initiativeId: "init-1",
    workstreamId: overrides.workstreamId ?? "ws-1",
    milestoneId: overrides.milestoneId ?? "ms-1",
    priorityNum: 50,
    priorityLabel: "medium",
    dependencyIds: overrides.dependencyIds ?? [],
    dueDate: null,
    etaEndAt: null,
    expectedDurationHours: 2,
    expectedTokens: overrides.expectedTokens ?? null,
    expectedBudgetUsd: 10,
    assignedAgents: [],
    updatedAt: null,
  };
}

function buildGraph(nodes) {
  const nodeById = new Map();
  for (const n of nodes) nodeById.set(n.id, n);
  const recentTodos = nodes
    .filter((n) => n.type === "task" && (n.status === "todo" || n.status === "planned"))
    .map((n) => n.id);
  return { nodeById, recentTodos };
}

// ---------------------------------------------------------------------------
// SLICE_SCOPE_MAX_TASKS constants
// ---------------------------------------------------------------------------

test("SLICE_SCOPE_MAX_TASKS has correct caps", () => {
  assert.equal(SLICE_SCOPE_MAX_TASKS.task, 1);
  assert.equal(SLICE_SCOPE_MAX_TASKS.milestone, 15);
  assert.equal(SLICE_SCOPE_MAX_TASKS.workstream, 30);
});

test("SLICE_SCOPE_TIMEOUT_MULTIPLIER has correct values", () => {
  assert.equal(SLICE_SCOPE_TIMEOUT_MULTIPLIER.task, 1);
  assert.equal(SLICE_SCOPE_TIMEOUT_MULTIPLIER.milestone, 2.5);
  assert.equal(SLICE_SCOPE_TIMEOUT_MULTIPLIER.workstream, 4);
});

// ---------------------------------------------------------------------------
// selectSliceTasksByScope — task scope
// ---------------------------------------------------------------------------

test("task scope selects exactly one ready task from the workstream", () => {
  const tasks = Array.from({ length: 10 }, (_, i) =>
    makeNode({ id: `t-${i}`, workstreamId: "ws-1", milestoneId: "ms-1" })
  );
  const { nodeById, recentTodos } = buildGraph(tasks);
  const result = selectSliceTasksByScope({
    scope: "task",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 1);
  assert.ok(result.milestoneIds.length > 0);
});

test("task scope filters to correct workstream", () => {
  const tasks = [
    makeNode({ id: "t-ws1", workstreamId: "ws-1" }),
    makeNode({ id: "t-ws2", workstreamId: "ws-2" }),
  ];
  const { nodeById, recentTodos } = buildGraph(tasks);
  const result = selectSliceTasksByScope({
    scope: "task",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "t-ws1");
});

test("task scope excludes blocked tasks", () => {
  const dep = makeNode({ id: "dep-1", status: "todo" }); // not done — but ready itself
  const blocked = makeNode({ id: "t-blocked", dependencyIds: ["dep-1"] });
  const ready = makeNode({ id: "t-ready" });
  const { nodeById, recentTodos } = buildGraph([dep, blocked, ready]);
  const result = selectSliceTasksByScope({
    scope: "task",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  // dep-1 is the first ready task; t-blocked is excluded because dep-1 is not done.
  assert.equal(result.tasks.length, 1);
  const ids = result.tasks.map((t) => t.id);
  assert.ok(ids.includes("dep-1"));
  assert.ok(!ids.includes("t-blocked"));
});

// ---------------------------------------------------------------------------
// selectSliceTasksByScope — milestone scope
// ---------------------------------------------------------------------------

test("milestone scope selects tasks from specific milestone", () => {
  const ms1Tasks = Array.from({ length: 10 }, (_, i) =>
    makeNode({ id: `t-ms1-${i}`, milestoneId: "ms-1" })
  );
  const ms2Tasks = Array.from({ length: 5 }, (_, i) =>
    makeNode({ id: `t-ms2-${i}`, milestoneId: "ms-2" })
  );
  const { nodeById, recentTodos } = buildGraph([...ms1Tasks, ...ms2Tasks]);
  const result = selectSliceTasksByScope({
    scope: "milestone",
    workstreamId: "ws-1",
    milestoneId: "ms-2",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 5);
  assert.deepEqual(result.milestoneIds, ["ms-2"]);
  for (const t of result.tasks) {
    assert.equal(t.milestoneId, "ms-2");
  }
});

test("milestone scope without milestoneId picks first available", () => {
  const ms1Tasks = [
    makeNode({ id: "t-ms1-1", milestoneId: "ms-1" }),
    makeNode({ id: "t-ms1-2", milestoneId: "ms-1" }),
  ];
  const ms2Tasks = [
    makeNode({ id: "t-ms2-1", milestoneId: "ms-2" }),
  ];
  const { nodeById, recentTodos } = buildGraph([...ms1Tasks, ...ms2Tasks]);
  const result = selectSliceTasksByScope({
    scope: "milestone",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.ok(result.tasks.length > 0);
  assert.equal(result.milestoneIds.length, 1);
  // All tasks should be from the same milestone
  const msId = result.milestoneIds[0];
  for (const t of result.tasks) {
    assert.equal(t.milestoneId, msId);
  }
});

test("milestone scope caps at 15 tasks", () => {
  const tasks = Array.from({ length: 20 }, (_, i) =>
    makeNode({ id: `t-${i}`, milestoneId: "ms-1" })
  );
  const { nodeById, recentTodos } = buildGraph(tasks);
  const result = selectSliceTasksByScope({
    scope: "milestone",
    workstreamId: "ws-1",
    milestoneId: "ms-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 15);
});

// ---------------------------------------------------------------------------
// selectSliceTasksByScope — workstream scope
// ---------------------------------------------------------------------------

test("workstream scope selects tasks across milestones", () => {
  const ms1Tasks = Array.from({ length: 5 }, (_, i) =>
    makeNode({ id: `t-ms1-${i}`, milestoneId: "ms-1" })
  );
  const ms2Tasks = Array.from({ length: 5 }, (_, i) =>
    makeNode({ id: `t-ms2-${i}`, milestoneId: "ms-2" })
  );
  const { nodeById, recentTodos } = buildGraph([...ms1Tasks, ...ms2Tasks]);
  const result = selectSliceTasksByScope({
    scope: "workstream",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 10);
  assert.ok(result.milestoneIds.includes("ms-1"));
  assert.ok(result.milestoneIds.includes("ms-2"));
});

test("workstream scope caps at 30 tasks", () => {
  const tasks = Array.from({ length: 40 }, (_, i) =>
    makeNode({ id: `t-${i}`, milestoneId: `ms-${i % 3}` })
  );
  const { nodeById, recentTodos } = buildGraph(tasks);
  const result = selectSliceTasksByScope({
    scope: "workstream",
    workstreamId: "ws-1",
    recentTodos,
    nodeById,
    includeVerification: true,
  });
  assert.equal(result.tasks.length, 30);
});

// ---------------------------------------------------------------------------
// evaluateScopeCompletion
// ---------------------------------------------------------------------------

test("task scope always returns scopeComplete: true", () => {
  const { nodeById } = buildGraph([makeNode({ id: "t-1", status: "todo" })]);
  const result = evaluateScopeCompletion({
    scope: "task",
    milestoneIds: [],
    workstreamId: "ws-1",
    nodeById,
  });
  assert.equal(result.scopeComplete, true);
  assert.equal(result.remainingTasks, 0);
});

test("milestone scope returns incomplete when tasks remain", () => {
  const tasks = [
    makeNode({ id: "t-1", milestoneId: "ms-1", status: "done" }),
    makeNode({ id: "t-2", milestoneId: "ms-1", status: "todo" }),
    makeNode({ id: "t-3", milestoneId: "ms-2", status: "todo" }),
  ];
  const { nodeById } = buildGraph(tasks);
  const result = evaluateScopeCompletion({
    scope: "milestone",
    milestoneIds: ["ms-1"],
    workstreamId: "ws-1",
    nodeById,
  });
  assert.equal(result.scopeComplete, false);
  assert.equal(result.remainingTasks, 1);
});

test("milestone scope returns complete when all tasks done", () => {
  const tasks = [
    makeNode({ id: "t-1", milestoneId: "ms-1", status: "done" }),
    makeNode({ id: "t-2", milestoneId: "ms-1", status: "completed" }),
    makeNode({ id: "t-3", milestoneId: "ms-2", status: "todo" }),
  ];
  const { nodeById } = buildGraph(tasks);
  const result = evaluateScopeCompletion({
    scope: "milestone",
    milestoneIds: ["ms-1"],
    workstreamId: "ws-1",
    nodeById,
  });
  assert.equal(result.scopeComplete, true);
  assert.equal(result.remainingTasks, 0);
});

test("workstream scope counts all non-done tasks in workstream", () => {
  const tasks = [
    makeNode({ id: "t-1", workstreamId: "ws-1", milestoneId: "ms-1", status: "done" }),
    makeNode({ id: "t-2", workstreamId: "ws-1", milestoneId: "ms-1", status: "todo" }),
    makeNode({ id: "t-3", workstreamId: "ws-1", milestoneId: "ms-2", status: "in_progress" }),
    makeNode({ id: "t-4", workstreamId: "ws-2", milestoneId: "ms-3", status: "todo" }),
  ];
  const { nodeById } = buildGraph(tasks);
  const result = evaluateScopeCompletion({
    scope: "workstream",
    milestoneIds: ["ms-1", "ms-2"],
    workstreamId: "ws-1",
    nodeById,
  });
  assert.equal(result.scopeComplete, false);
  assert.equal(result.remainingTasks, 2);
});

// ---------------------------------------------------------------------------
// buildScopeDirective
// ---------------------------------------------------------------------------

test("buildScopeDirective returns empty for task scope", () => {
  const result = buildScopeDirective("task", { taskCount: 3 });
  assert.equal(result, "");
});

test("buildScopeDirective includes milestone title for milestone scope", () => {
  const result = buildScopeDirective("milestone", {
    milestoneTitles: ["Core Auth"],
    taskCount: 5,
  });
  assert.match(result, /Core Auth/);
  assert.match(result, /5 tasks/);
  assert.match(result, /milestone/i);
});

test("buildScopeDirective includes workstream title and milestone count for workstream scope", () => {
  const result = buildScopeDirective("workstream", {
    workstreamTitle: "Build Auth System",
    milestoneTitles: ["Core Auth", "Auth UI"],
    taskCount: 8,
  });
  assert.match(result, /Build Auth System/);
  assert.match(result, /8 tasks/);
  assert.match(result, /2 milestones/);
});

test("buildScopeDirective handles missing titles gracefully", () => {
  const milestone = buildScopeDirective("milestone", { taskCount: 3 });
  assert.match(milestone, /Unknown/);

  const workstream = buildScopeDirective("workstream", { taskCount: 5 });
  assert.match(workstream, /Unknown/);
});
