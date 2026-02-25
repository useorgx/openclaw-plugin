import test from "node:test";
import assert from "node:assert/strict";

import { buildPlanScaffold } from "../../scripts/run-codex-dispatch-job.mjs";

test("buildPlanScaffold maps dependency-map workstreams and dependency gaps", () => {
  const plan = [
    "## Workstream Dependency Map",
    "1. `Agent Launcher & Runtime`",
    "- Depends on: `Auth & User Identity`.",
    "2. `Continuous Execution & Auto-Completion`",
    "- Depends on: `Agent Launcher & Runtime`, `Missing Stream`.",
  ].join("\n");

  const scaffold = buildPlanScaffold(plan, {
    workstreams: [
      { id: "ws-auth", name: "Auth & User Identity" },
      { id: "ws-launch", name: "Agent Launcher & Runtime" },
      { id: "ws-auto", name: "Continuous Execution & Auto-Completion" },
    ],
    tasks: [
      { id: "t-1", workstream_id: "ws-launch" },
      { id: "t-2", workstream_id: "ws-launch" },
      { id: "t-3", workstream_id: "ws-auto" },
    ],
  });

  assert.equal(scaffold.source, "workstream_dependency_map");
  assert.equal(scaffold.planWorkstreamCount, 2);
  assert.equal(scaffold.matchedWorkstreamCount, 2);
  assert.equal(scaffold.missingWorkstreamCount, 0);
  assert.equal(scaffold.blockedByDependencyCount, 1);
  assert.equal(scaffold.matchedWithTasksCount, 2);
  assert.equal(scaffold.matchedWithoutTasksCount, 0);

  const auto = scaffold.units.find(
    (unit) => unit.title === "Continuous Execution & Auto-Completion"
  );
  assert.deepEqual(auto?.missingDependencies, ["Missing Stream"]);
  assert.equal(auto?.taskCount, 1);
});

test("buildPlanScaffold reports none source when plan has no dependency map", () => {
  const scaffold = buildPlanScaffold("# No dependency map");

  assert.equal(scaffold.source, "none");
  assert.equal(scaffold.planWorkstreamCount, 0);
  assert.deepEqual(scaffold.units, []);
});
