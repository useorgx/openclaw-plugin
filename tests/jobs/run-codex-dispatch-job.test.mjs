import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  buildTaskQueue,
  extractPlanContext,
  buildCodexPrompt,
  createReporter,
  classifyTaskState,
  summarizeTaskStatuses,
  computeMilestoneRollup,
  computeWorkstreamRollup,
} from "../../scripts/run-codex-dispatch-job.mjs";

test("parseArgs parses --key=value pairs", () => {
  const args = parseArgs([
    "--initiative_id=aa6d16dc-d450-417f-8a17-fd89bd597195",
    "--concurrency=6",
    "--dry_run=true",
  ]);

  assert.equal(args.initiative_id, "aa6d16dc-d450-417f-8a17-fd89bd597195");
  assert.equal(args.concurrency, "6");
  assert.equal(args.dry_run, "true");
});

test("buildTaskQueue filters by workstream/task and sorts by due + priority", () => {
  const queue = buildTaskQueue({
    tasks: [
      {
        id: "t3",
        title: "later due",
        status: "todo",
        priority: "high",
        due_date: "2026-02-15",
        workstream_id: "wsA",
      },
      {
        id: "t1",
        title: "earlier due",
        status: "todo",
        priority: "medium",
        due_date: "2026-02-10",
        workstream_id: "wsA",
      },
      {
        id: "t2",
        title: "blocked item",
        status: "blocked",
        priority: "high",
        due_date: "2026-02-09",
        workstream_id: "wsA",
      },
      {
        id: "t4",
        title: "other workstream",
        status: "todo",
        priority: "high",
        due_date: "2026-02-08",
        workstream_id: "wsB",
      },
    ],
    selectedWorkstreamIds: ["wsA"],
    selectedTaskIds: [],
  });

  assert.deepEqual(
    queue.map((task) => task.id),
    ["t1", "t3", "t2"]
  );
});

test("extractPlanContext prefers task/workstream match", () => {
  const plan = [
    "# Saturday Launch",
    "## Workstream: Agent Launcher & Runtime",
    "- Task: Implement one-click agent launch",
    "- Task: Add real-time status",
  ].join("\n");

  const context = extractPlanContext(plan, {
    title: "Implement one-click agent launch",
    workstream_name: "Agent Launcher & Runtime",
    milestone_title: "Agent Launch Working",
  });

  assert.match(context, /one-click agent launch/i);
  assert.match(context, /Agent Launcher & Runtime/i);
});

test("buildCodexPrompt includes task and plan references", () => {
  const prompt = buildCodexPrompt({
    task: {
      id: "15f34642-4fc5-47a0-b604-f0056c1958c6",
      title: "Inject OrgXClient into orchestration",
      workstream_id: "8f730d2e-26ac-47ea-a241-18cdd909dc93",
      workstream_name: "Orchestration Client Dependency Injection",
      milestone_id: "ab60e457-95cc-4b3e-80f2-62053d4e73a3",
      milestone_title: "Launch Verification",
      due_date: "2026-02-12",
      priority: "high",
    },
    planPath:
      "/Users/hopeatina/Code/orgx-openclaw-plugin/docs/orgx-openclaw-launch-workstreams-plan-2026-02-14.md",
    planContext: "Use the two-tool reporting contract.",
    initiativeId: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    jobId: "codex-job-abc123",
    attempt: 1,
    totalTasks: 29,
    completedTasks: 3,
  });

  assert.match(prompt, /Original Plan Reference:/);
  assert.match(prompt, /Inject OrgXClient into orchestration/);
  assert.match(prompt, /two-tool reporting contract/i);
  assert.match(prompt, /codex-job-abc123/);
});

test("createReporter routes mutations through injected OrgXClient", async () => {
  const calls = {
    activity: [],
    changesets: [],
    updates: [],
  };

  const client = {
    emitActivity: async (payload) => {
      calls.activity.push(payload);
      return { ok: true, run_id: "run_1" };
    },
    applyChangeset: async (payload) => {
      calls.changesets.push(payload);
      return { ok: true, run_id: "run_1" };
    },
    updateEntity: async (type, id, updates) => {
      calls.updates.push({ type, id, updates });
      return { ok: true, id };
    },
  };

  const reporter = createReporter({
    client,
    initiativeId: "init_1",
    sourceClient: "codex",
    correlationId: "corr_1",
    planPath: "/tmp/plan.md",
    planHash: "hash_1",
    jobId: "job_1",
    dryRun: false,
  });

  await reporter.emit({ message: "hello", phase: "intent", level: "info", progressPct: 0 });

  assert.equal(calls.activity.length, 1);
  assert.equal(calls.activity[0].initiative_id, "init_1");
  assert.equal(calls.activity[0].correlation_id, "corr_1");
  assert.equal(calls.activity[0].source_client, "codex");

  await reporter.taskStatus({
    taskId: "task_1",
    status: "done",
    attempt: 1,
    reason: "ok",
  });

  assert.equal(calls.changesets.length, 1);
  assert.equal(calls.changesets[0].initiative_id, "init_1");
  assert.equal(calls.changesets[0].run_id, "run_1");
  assert.equal(calls.changesets[0].operations[0].op, "task.update");

  await reporter.workstreamStatus({
    workstreamId: "ws_1",
    workstreamName: "Workstream",
    status: "active",
    statusChanged: true,
    progressPct: 0,
    done: 0,
    total: 1,
    blocked: 0,
    active: 0,
    todo: 1,
    triggerTaskId: "task_1",
    attempt: 1,
  });

  assert.equal(calls.updates.length, 1);
  assert.deepEqual(calls.updates[0], {
    type: "workstream",
    id: "ws_1",
    updates: { status: "active" },
  });
});

test("classifyTaskState buckets task lifecycle states", () => {
  assert.equal(classifyTaskState("done"), "done");
  assert.equal(classifyTaskState("completed"), "done");
  assert.equal(classifyTaskState("blocked"), "blocked");
  assert.equal(classifyTaskState("in_progress"), "active");
  assert.equal(classifyTaskState("retry_pending"), "active");
  assert.equal(classifyTaskState("todo"), "todo");
});

test("summarizeTaskStatuses returns deterministic counts", () => {
  const counts = summarizeTaskStatuses([
    "done",
    "completed",
    "blocked",
    "in_progress",
    "todo",
    "not_started",
  ]);
  assert.deepEqual(counts, {
    total: 6,
    done: 2,
    blocked: 1,
    active: 1,
    todo: 2,
  });
});

test("computeMilestoneRollup derives status + percent from task states", () => {
  const inProgress = computeMilestoneRollup([
    "done",
    "in_progress",
    "todo",
  ]);
  assert.equal(inProgress.status, "in_progress");
  assert.equal(inProgress.progressPct, 33);

  const atRisk = computeMilestoneRollup([
    "done",
    "blocked",
    "todo",
  ]);
  assert.equal(atRisk.status, "at_risk");
  assert.equal(atRisk.progressPct, 33);

  const completed = computeMilestoneRollup(["done", "completed"]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progressPct, 100);
});

test("computeWorkstreamRollup derives status + percent from task states", () => {
  const active = computeWorkstreamRollup(["done", "in_progress", "todo"]);
  assert.equal(active.status, "active");
  assert.equal(active.progressPct, 33);

  const blocked = computeWorkstreamRollup(["done", "blocked", "todo"]);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.progressPct, 33);

  const complete = computeWorkstreamRollup(["done", "completed"]);
  assert.equal(complete.status, "done");
  assert.equal(complete.progressPct, 100);
});
