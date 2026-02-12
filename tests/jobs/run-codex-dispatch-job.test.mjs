import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  buildTaskQueue,
  extractPlanContext,
  buildCodexPrompt,
  deriveTaskExecutionPolicy,
  isSpawnGuardRetryable,
  evaluateResourceGuard,
  detectMcpHandshakeFailure,
  shouldKillWorker,
  deriveResumePlan,
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
  const tasks = [
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
        id: "t5",
        title: "already done",
        status: "done",
        priority: "high",
        due_date: "2026-02-01",
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
    ];

  const queue = buildTaskQueue({
    tasks,
    selectedWorkstreamIds: ["wsA"],
    selectedTaskIds: [],
  });

  assert.deepEqual(
    queue.map((task) => task.id),
    ["t1", "t3", "t2"]
  );

  const queueWithDone = buildTaskQueue({
    tasks,
    selectedWorkstreamIds: ["wsA"],
    selectedTaskIds: [],
    includeDone: true,
  });

  assert.deepEqual(
    queueWithDone.map((task) => task.id),
    ["t1", "t3", "t2", "t5"]
  );

  const queueExplicitDone = buildTaskQueue({
    tasks,
    selectedWorkstreamIds: ["wsA"],
    selectedTaskIds: ["t5"],
  });

  assert.ok(queueExplicitDone.some((task) => task.id === "t5"));
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
    taskDomain: "engineering",
    requiredSkills: ["orgx-engineering-agent"],
    spawnGuardResult: { modelTier: "sonnet", allowed: true },
  });

  assert.match(prompt, /Original Plan Reference:/);
  assert.match(prompt, /Inject OrgXClient into orchestration/);
  assert.match(prompt, /two-tool reporting contract/i);
  assert.match(prompt, /codex-job-abc123/);
  assert.match(prompt, /Spawn domain:\s+engineering/);
  assert.match(prompt, /\$orgx-engineering-agent/);
  assert.match(prompt, /Spawn guard model tier:\s+sonnet/);
});

test("buildCodexPrompt embeds skill docs when provided", () => {
  const prompt = buildCodexPrompt({
    task: {
      id: "task_1",
      title: "Task",
      workstream_id: "ws_1",
      milestone_id: "ms_1",
    },
    planPath: "/tmp/plan.md",
    planContext: "plan excerpt",
    initiativeId: "init_1",
    jobId: "job_1",
    attempt: 1,
    totalTasks: 1,
    completedTasks: 0,
    taskDomain: "engineering",
    requiredSkills: ["orgx-engineering-agent"],
    spawnGuardResult: { modelTier: "sonnet", allowed: true },
    skillDocs: [
      {
        skill: "orgx-engineering-agent",
        path: "/tmp/skill.md",
        content: "# Skill content",
      },
    ],
  });

  assert.match(prompt, /Embedded skill docs:/);
  assert.match(prompt, /orgx-engineering-agent/);
  assert.match(prompt, /\/tmp\/skill\.md/);
  assert.match(prompt, /# Skill content/);
});

test("deriveTaskExecutionPolicy infers domain and required skill", () => {
  const policy = deriveTaskExecutionPolicy({
    title: "Investigate incident response and oncall reliability",
    workstream_name: "Ops Hardening",
  });

  assert.equal(policy.domain, "operations");
  assert.ok(policy.requiredSkills.includes("orgx-operations-agent"));
});

test("isSpawnGuardRetryable returns true when rate-limit check fails", () => {
  assert.equal(
    isSpawnGuardRetryable({
      allowed: false,
      checks: {
        rateLimit: { passed: false, current: 10, max: 10 },
        qualityGate: { passed: true, score: 5, threshold: 3 },
        taskAssigned: { passed: true },
      },
    }),
    true
  );
  assert.equal(
    isSpawnGuardRetryable({
      allowed: false,
      checks: {
        rateLimit: { passed: true, current: 1, max: 10 },
        qualityGate: { passed: false, score: 2, threshold: 3 },
        taskAssigned: { passed: true },
      },
    }),
    false
  );
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

  await reporter.requestDecision({
    title: "Unblock dispatch",
    summary: "Guard rejected spawn.",
    urgency: "high",
    options: ["Retry", "Pause"],
    blocking: true,
    idempotencyParts: ["task_1", "blocked"],
    metadata: { task_id: "task_1" },
  });

  assert.equal(calls.changesets.length, 2);
  assert.equal(calls.changesets[1].operations[0].op, "decision.create");

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

test("evaluateResourceGuard throttles when load or memory exceeds thresholds", () => {
  const throttled = evaluateResourceGuard(
    {
      cpuCount: 4,
      load1: 5,
      freeMemBytes: 256 * 1024 * 1024,
      totalMemBytes: 8 * 1024 * 1024 * 1024,
    },
    {
      maxLoadRatio: 0.9,
      minFreeMemBytes: 512 * 1024 * 1024,
      minFreeMemRatio: 0.05,
    }
  );

  assert.equal(throttled.throttle, true);
  assert.ok(throttled.reasons.some((reason) => reason.includes("load ratio")));
  assert.ok(throttled.reasons.some((reason) => reason.includes("free memory")));

  const ok = evaluateResourceGuard(
    {
      cpuCount: 8,
      load1: 1,
      freeMemBytes: 4 * 1024 * 1024 * 1024,
      totalMemBytes: 8 * 1024 * 1024 * 1024,
    },
    {
      maxLoadRatio: 0.9,
      minFreeMemBytes: 512 * 1024 * 1024,
      minFreeMemRatio: 0.05,
    }
  );
  assert.equal(ok.throttle, false);
});

test("detectMcpHandshakeFailure extracts server and reason from worker logs", () => {
  const payload = [
    "OpenAI Codex v0.98.0",
    "mcp: Github failed: MCP client for `Github` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response",
    "other output",
  ].join("\n");

  const detected = detectMcpHandshakeFailure(payload);
  assert.ok(detected);
  assert.equal(detected.kind, "mcp_handshake");
  assert.equal(detected.server?.toLowerCase(), "github");
  assert.match(detected.line, /handshaking with mcp server failed/i);
});

test("shouldKillWorker triggers when timeout or log stall is exceeded", () => {
  const now = 1_000_000;
  const decisionTimeout = shouldKillWorker(
    {
      nowEpochMs: now,
      startedAtEpochMs: now - 11_000,
      logUpdatedAtEpochMs: now - 1_000,
    },
    { timeoutMs: 10_000, stallMs: 60_000 }
  );
  assert.equal(decisionTimeout.kill, true);
  assert.equal(decisionTimeout.kind, "timeout");

  const decisionStall = shouldKillWorker(
    {
      nowEpochMs: now,
      startedAtEpochMs: now - 5_000,
      logUpdatedAtEpochMs: now - 70_000,
    },
    { timeoutMs: 60_000, stallMs: 60_000 }
  );
  assert.equal(decisionStall.kill, true);
  assert.equal(decisionStall.kind, "log_stall");

  const ok = shouldKillWorker(
    {
      nowEpochMs: now,
      startedAtEpochMs: now - 5_000,
      logUpdatedAtEpochMs: now - 1_000,
    },
    { timeoutMs: 60_000, stallMs: 60_000 }
  );
  assert.equal(ok.kill, false);
});

test("deriveResumePlan skips done/blocked tasks unless selected or retry_blocked", () => {
  const queue = [
    { id: "t1", title: "done", status: "todo" },
    { id: "t2", title: "blocked", status: "todo" },
    { id: "t3", title: "todo", status: "todo" },
  ];

  const resumeState = {
    taskStates: {
      t1: { status: "done", attempts: 1 },
      t2: { status: "blocked", attempts: 2 },
    },
  };

  const noRetry = deriveResumePlan({
    queue,
    resumeState,
    retryBlocked: false,
    selectedTaskIds: [],
  });
  assert.deepEqual(
    noRetry.pending.map((task) => task.id),
    ["t3"]
  );

  const withRetry = deriveResumePlan({
    queue,
    resumeState,
    retryBlocked: true,
    selectedTaskIds: [],
  });
  assert.deepEqual(
    withRetry.pending.map((task) => task.id),
    ["t2", "t3"]
  );

  const selectedOverrides = deriveResumePlan({
    queue,
    resumeState,
    retryBlocked: false,
    selectedTaskIds: ["t1", "t2"],
  });
  assert.deepEqual(
    selectedOverrides.pending.map((task) => task.id),
    ["t1", "t2", "t3"]
  );
});
