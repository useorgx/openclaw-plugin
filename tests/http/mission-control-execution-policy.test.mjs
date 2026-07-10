import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMissionControlGraph,
  deriveExecutionPolicy,
} from "../../dist/http/helpers/mission-control.js";

test("execution policy preserves entity domain when assigned agents only have ids and names", async () => {
  const initiativeId = "11111111-1111-4111-8111-111111111111";
  const workstreamId = "22222222-2222-4222-8222-222222222222";
  const taskId = "33333333-3333-4333-8333-333333333333";
  const entities = {
    initiative: [{ id: initiativeId, title: "Revenue", status: "active" }],
    workstream: [
      {
        id: workstreamId,
        initiative_id: initiativeId,
        title: "First receipt",
        status: "active",
        metadata: {
          domain: "sales",
          assigned_agent_ids: ["sales-agent"],
          assigned_agent_names: ["Sage"],
        },
      },
    ],
    milestone: [],
    task: [
      {
        id: taskId,
        initiative_id: initiativeId,
        workstream_id: workstreamId,
        title: "Write and price the offer",
        status: "todo",
        metadata: {
          agent_domain: "sales",
          assigned_agent_ids: ["sales-agent"],
          assigned_agent_names: ["Sage"],
        },
      },
    ],
  };
  const client = {
    listEntities: async (type) => ({ data: entities[type] ?? [] }),
  };

  const graph = await buildMissionControlGraph(client, initiativeId);
  const task = graph.nodes.find((node) => node.id === taskId);
  const workstream = graph.nodes.find((node) => node.id === workstreamId);
  assert.ok(task);
  assert.ok(workstream);
  assert.deepEqual(task.assignedAgents, [
    { id: "sales-agent", name: "Sage", domain: "sales" },
  ]);
  assert.deepEqual(deriveExecutionPolicy(task, workstream), {
    domain: "sales",
    requiredSkills: ["orgx-sales-agent"],
    profile: null,
    sliceScopePreference: null,
    maxSliceTasks: null,
    maxParallelAgents: null,
    dependencyMode: null,
  });
});
