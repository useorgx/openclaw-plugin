#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://www.useorgx.com";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_POLL_INTERVAL_SEC = 10;
const DEFAULT_HEARTBEAT_SEC = 45;

async function createOrgXClient({ apiKey, baseUrl, userId }) {
  // Orchestration uses the shared OrgXClient implementation from the built plugin.
  // This keeps headers/timeouts consistent and prevents duplicate fetch logic in this script.
  try {
    const mod = await import(new URL("../dist/api.js", import.meta.url).href);
    const OrgXClient = mod?.OrgXClient;
    if (!OrgXClient) {
      throw new Error("dist/api.js does not export OrgXClient");
    }
    return new OrgXClient(apiKey, baseUrl, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load OrgXClient. Run "npm run build:core" first. (${message})`
    );
  }
}

const DEFAULT_TECHNICAL_WORKSTREAM_IDS = [
  "8832bb2b-f888-4119-a29c-31be9d61ac4f", // Agent Launcher & Runtime
  "55472b6d-7e72-4428-b836-c071f629775d", // Continuous Execution & Auto-Completion
  "73767c4d-34f9-4c45-a5d6-0b0360265462", // Real-Time Stream (SSE) Integration
  "49be6c2e-bb48-46d5-8baf-806c728ba492", // Plugin + Core Codebase Unification
  "8f730d2e-26ac-47ea-a241-18cdd909dc93", // Orchestration Client Dependency Injection
  "e3920cb7-1d12-49ea-b012-0a5ec47fac62", // Dashboard Bundle Endpoint
  "c93600c0-14aa-4523-a8d1-5dad4cf16b54", // Self-Healing Auth & Warm Cache
  "9f7308eb-282b-4e69-afdc-145a850665f2", // Deterministic Reporting Control Plane (4-Layer Core)
  "38d265f1-2f3f-4a50-a509-ad2ec2bcaf15", // Reporting Reliability Hardening (Hooks + Replay + SLO)
];

const DEFAULT_WORKSTREAM_CWDS = {
  "8832bb2b-f888-4119-a29c-31be9d61ac4f": "/Users/hopeatina/Code/orgx-openclaw-plugin",
  "55472b6d-7e72-4428-b836-c071f629775d": "/Users/hopeatina/Code/orgx/orgx",
  "73767c4d-34f9-4c45-a5d6-0b0360265462": "/Users/hopeatina/Code/orgx-openclaw-plugin",
  "49be6c2e-bb48-46d5-8baf-806c728ba492": "/Users/hopeatina/Code",
  "8f730d2e-26ac-47ea-a241-18cdd909dc93": "/Users/hopeatina/Code/orgx/orgx",
  "e3920cb7-1d12-49ea-b012-0a5ec47fac62": "/Users/hopeatina/Code/orgx-openclaw-plugin",
  "c93600c0-14aa-4523-a8d1-5dad4cf16b54": "/Users/hopeatina/Code/orgx-openclaw-plugin",
  "9f7308eb-282b-4e69-afdc-145a850665f2": "/Users/hopeatina/Code",
  "38d265f1-2f3f-4a50-a509-ad2ec2bcaf15": "/Users/hopeatina/Code",
};

const PRIORITY_RANK = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PHASE_BY_EVENT = {
  dispatch: "execution",
  success: "review",
  retry: "blocked",
  failure: "blocked",
  heartbeat: "execution",
  complete: "completed",
};

function usage() {
  return [
    "Usage: node scripts/run-codex-dispatch-job.mjs [options]",
    "",
    "Required:",
    "  --initiative_id=<uuid>           OrgX initiative ID",
    "",
    "Auth (env):",
    "  ORGX_API_KEY                      Per-user OrgX API key (oxk_...)",
    "Optional env: ORGX_USER_ID, ORGX_BASE_URL",
    "",
    "Options:",
    "  --plan_file=<path>                Original plan file path",
    "  --workstream_ids=<csv>            Limit to specific workstream IDs",
    "  --task_ids=<csv>                  Limit to specific task IDs",
    "  --all_workstreams=true            Ignore default technical subset",
    "  --concurrency=<n>                 Parallel codex workers (default 4)",
    "  --max_attempts=<n>                Max attempts per task (default 2)",
    "  --poll_interval_sec=<n>           Monitor loop interval (default 10)",
    "  --heartbeat_sec=<n>               Activity heartbeat cadence (default 45)",
    "  --state_file=<path>               Persist runtime job state JSON",
    "  --logs_dir=<path>                 Worker logs directory",
    "  --config_file=<path>              JSON overrides (cwd/prompt mapping)",
    "  --codex_bin=<command>             Codex executable (default codex)",
    "  --codex_args=\"--full-auto\"        Codex args string",
    "  --dry_run=true                    Do not execute codex or mutate DB",
    "  --auto_complete=true              Mark task done on successful worker run",
    "  --max_tasks=<n>                   Cap number of tasks to dispatch",
    "  --help                            Show this message",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (!key) continue;
    args[key] = rest.length > 0 ? rest.join("=") : "true";
  }
  return args;
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function parseBoolean(value, fallback = false) {
  const normalized = pickString(value)?.toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const raw = pickString(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function splitCsv(value) {
  const raw = pickString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitShellArgs(value, fallback = ["--full-auto"]) {
  const raw = pickString(value);
  if (!raw) return [...fallback];
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureDir(pathname) {
  mkdirSync(pathname, { recursive: true });
}

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function toDateEpoch(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const epoch = Date.parse(String(value));
  return Number.isFinite(epoch) ? epoch : Number.POSITIVE_INFINITY;
}

function priorityWeight(value) {
  const normalized = String(value ?? "").toLowerCase();
  return PRIORITY_RANK[normalized] ?? 9;
}

function stateWeight(status) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "in_progress") return 0;
  if (normalized === "todo") return 1;
  if (normalized === "blocked") return 2;
  return 9;
}

export function classifyTaskState(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  ) {
    return "done";
  }
  if (normalized === "blocked" || normalized === "at_risk") {
    return "blocked";
  }
  if (
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued" ||
    normalized === "retry_pending"
  ) {
    return "active";
  }
  return "todo";
}

export function summarizeTaskStatuses(taskStatuses = []) {
  const counts = {
    total: taskStatuses.length,
    done: 0,
    blocked: 0,
    active: 0,
    todo: 0,
  };

  for (const status of taskStatuses) {
    const bucket = classifyTaskState(status);
    counts[bucket] += 1;
  }

  return counts;
}

export function computeMilestoneRollup(taskStatuses = []) {
  const counts = summarizeTaskStatuses(taskStatuses);
  const progressPct = toPercent(counts.done, counts.total);
  let status = "planned";

  if (counts.total <= 0) {
    status = "planned";
  } else if (counts.done >= counts.total) {
    status = "completed";
  } else if (counts.blocked > 0 && counts.active === 0) {
    status = "at_risk";
  } else if (counts.active > 0 || counts.done > 0) {
    status = "in_progress";
  }

  return {
    ...counts,
    status,
    progressPct,
  };
}

export function computeWorkstreamRollup(taskStatuses = []) {
  const counts = summarizeTaskStatuses(taskStatuses);
  const progressPct = toPercent(counts.done, counts.total);
  let status = "not_started";

  if (counts.total <= 0) {
    status = "not_started";
  } else if (counts.done >= counts.total) {
    status = "done";
  } else if (counts.blocked > 0 && counts.active === 0) {
    status = "blocked";
  } else if (counts.active > 0 || counts.done > 0) {
    status = "active";
  }

  return {
    ...counts,
    status,
    progressPct,
  };
}

function sortTasks(items) {
  return [...items].sort((a, b) => {
    const statusDelta = stateWeight(a.status) - stateWeight(b.status);
    if (statusDelta !== 0) return statusDelta;
    const dueDelta = toDateEpoch(a.due_date) - toDateEpoch(b.due_date);
    if (dueDelta !== 0) return dueDelta;
    const priorityDelta = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (priorityDelta !== 0) return priorityDelta;
    const seqA = Number.isFinite(a.sequence) ? a.sequence : Number.POSITIVE_INFINITY;
    const seqB = Number.isFinite(b.sequence) ? b.sequence : Number.POSITIVE_INFINITY;
    if (seqA !== seqB) return seqA - seqB;
    return String(a.title ?? "").localeCompare(String(b.title ?? ""));
  });
}

function summarizeTask(task) {
  return `${task.title} (${task.id})`;
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function idempotencyKey(parts) {
  const raw = parts.filter(Boolean).join(":");
  const cleaned = raw.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 84);
  const suffix = stableHash(raw).slice(0, 20);
  return `${cleaned}:${suffix}`.slice(0, 120);
}

function resolvePlanFile(input) {
  const explicit = pickString(input);
  if (explicit) return resolve(explicit);
  return resolve(
    "/Users/hopeatina/Code/orgx-openclaw-plugin/docs/orgx-openclaw-launch-workstreams-plan-2026-02-14.md"
  );
}

function loadJsonFile(pathname) {
  if (!existsSync(pathname)) {
    throw new Error(`Config file not found: ${pathname}`);
  }
  return JSON.parse(readFileSync(pathname, "utf8"));
}

function maybeLoadConfig(pathname) {
  const resolved = pickString(pathname);
  if (!resolved) return {};
  return loadJsonFile(resolve(resolved));
}

function readPlan(planPath) {
  if (!existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }
  return readFileSync(planPath, "utf8");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractPlanContext(planText, task, maxChars = 2_800) {
  const sources = [
    pickString(task.title),
    pickString(task.workstream_name),
    pickString(task.milestone_title),
  ].filter(Boolean);

  for (const source of sources) {
    const pattern = new RegExp(`.{0,1200}${escapeRegex(source)}.{0,1600}`, "is");
    const matched = planText.match(pattern)?.[0];
    if (matched) return matched.slice(0, maxChars).trim();
  }

  return planText.slice(0, maxChars).trim();
}

function toWorkerCwd(task, jobConfig) {
  const override = jobConfig.workstreamCwds?.[task.workstream_id];
  if (override) return resolve(override);
  const mapped = DEFAULT_WORKSTREAM_CWDS[task.workstream_id];
  if (mapped) return resolve(mapped);
  return resolve(jobConfig.defaultCwd || "/Users/hopeatina/Code/orgx-openclaw-plugin");
}

export function buildCodexPrompt({
  task,
  planPath,
  planContext,
  initiativeId,
  jobId,
  attempt,
  totalTasks,
  completedTasks,
}) {
  return [
    "You are an implementation worker for the OrgX Saturday Launch initiative.",
    "",
    "Execution requirements:",
    "- Run in full-auto and complete this task end-to-end in the current workspace.",
    "- Keep scope constrained to this one task and its direct dependencies.",
    "- Run relevant validation/tests before finishing.",
    "- If blocked, produce concrete blocker details and proposed next action.",
    "- Do not perform unrelated refactors.",
    "",
    `Initiative ID: ${initiativeId}`,
    `Task ID: ${task.id}`,
    `Task Title: ${task.title}`,
    `Workstream: ${task.workstream_name ?? task.workstream_id}`,
    `Milestone: ${task.milestone_title ?? task.milestone_id ?? "unassigned"}`,
    `Task Due Date: ${task.due_date ?? "none"}`,
    `Priority: ${task.priority ?? "medium"}`,
    `Dispatcher Job ID: ${jobId}`,
    `Attempt: ${attempt}`,
    `Progress Snapshot: ${completedTasks}/${totalTasks} tasks complete`,
    "",
    `Original Plan Reference: ${planPath}`,
    "Relevant Plan Excerpt:",
    "```md",
    planContext || "No plan excerpt found.",
    "```",
    "",
    "Definition of done for this task:",
    "1. Code/config/docs changes are implemented.",
    "2. Relevant checks/tests are run and reported.",
    "3. Output includes: changed files, checks run, and final result.",
  ].join("\n");
}

async function listEntities({
  client,
  type,
  initiativeId,
  limit = 1_500,
}) {
  const response = await client.listEntities(type, {
    initiative_id: initiativeId,
    limit,
  });
  const rows = Array.isArray(response?.data) ? response.data : [];
  return rows;
}

export function createReporter({
  client,
  initiativeId,
  sourceClient,
  correlationId,
  planPath,
  planHash,
  jobId,
  dryRun,
}) {
  let runId;

  function withRunContext(payload) {
    if (runId) {
      return { ...payload, run_id: runId };
    }
    return {
      ...payload,
      correlation_id: correlationId,
      source_client: sourceClient,
    };
  }

  async function emit({
    message,
    phase = "execution",
    level = "info",
    progressPct,
    metadata = {},
    nextStep,
  }) {
    const payload = withRunContext({
      initiative_id: initiativeId,
      message,
      phase,
      level,
      progress_pct: progressPct,
      next_step: nextStep,
      metadata: {
        ...metadata,
        job_id: jobId,
        plan_file: planPath,
        plan_sha256: planHash,
      },
    });

    if (dryRun) {
      return { ok: true, dry_run: true, payload };
    }

    const response = await client.emitActivity(payload);
    if (response?.run_id) {
      runId = response.run_id;
    }
    return response;
  }

  async function applyChangeset({ idempotencyParts, operations }) {
    const payload = withRunContext({
      initiative_id: initiativeId,
      idempotency_key: idempotencyKey(idempotencyParts),
      operations,
    });

    if (dryRun) {
      return { ok: true, dry_run: true, payload };
    }

    const response = await client.applyChangeset(payload);
    if (response?.run_id) {
      runId = response.run_id;
    }
    return response;
  }

  async function taskStatus({
    taskId,
    status,
    attempt,
    reason,
    metadata = {},
  }) {
    const response = await applyChangeset({
      idempotencyParts: [
        "dispatch",
        jobId,
        taskId,
        status,
        String(attempt),
      ],
      operations: [
        {
          op: "task.update",
          task_id: taskId,
          status,
          description: reason,
        },
      ],
    });

    if (Object.keys(metadata).length > 0) {
      await emit({
        message: `Task ${taskId} -> ${status}`,
        phase: status === "done" ? "completed" : "execution",
        level: status === "blocked" ? "warn" : "info",
        metadata: {
          task_id: taskId,
          status,
          attempt,
          ...metadata,
        },
      }).catch(() => undefined);
    }

    return response;
  }

  async function milestoneStatus({
    milestoneId,
    milestoneName,
    status,
    statusChanged,
    progressPct,
    done,
    total,
    blocked,
    active,
    todo,
    triggerTaskId,
    attempt,
  }) {
    let response = { ok: true, skipped: "no_status_change" };
    if (statusChanged) {
      response = await applyChangeset({
        idempotencyParts: [
          "dispatch",
          jobId,
          "milestone",
          milestoneId,
          status,
          String(progressPct),
          String(done),
          String(total),
        ],
        operations: [
          {
            op: "milestone.update",
            milestone_id: milestoneId,
            status,
          },
        ],
      });
    }

    await emit({
      message: `Milestone ${milestoneName ?? milestoneId}: ${done}/${total} done (${progressPct}%), status ${status}.`,
      phase: phaseFromMilestoneStatus(status),
      level: levelFromMilestoneStatus(status),
      progressPct,
      metadata: {
        event: "milestone_rollup",
        milestone_id: milestoneId,
        milestone_name: milestoneName ?? milestoneId,
        status,
        status_changed: statusChanged,
        done,
        total,
        blocked,
        active,
        todo,
        trigger_task_id: triggerTaskId,
        attempt,
      },
    }).catch(() => undefined);

    return response;
  }

  async function workstreamStatus({
    workstreamId,
    workstreamName,
    status,
    statusChanged,
    progressPct,
    done,
    total,
    blocked,
    active,
    todo,
    triggerTaskId,
    attempt,
  }) {
    let response = { ok: true, skipped: "no_status_change" };
    if (statusChanged) {
      const payload = {
        type: "workstream",
        id: workstreamId,
        status,
      };

      if (dryRun) {
        response = { ok: true, dry_run: true, payload };
      } else {
        response = await client.updateEntity("workstream", workstreamId, { status });
      }
    }

    await emit({
      message: `Workstream ${workstreamName ?? workstreamId}: ${done}/${total} done (${progressPct}%), status ${status}.`,
      phase: phaseFromWorkstreamStatus(status),
      level: levelFromWorkstreamStatus(status),
      progressPct,
      metadata: {
        event: "workstream_rollup",
        workstream_id: workstreamId,
        workstream_name: workstreamName ?? workstreamId,
        status,
        status_changed: statusChanged,
        done,
        total,
        blocked,
        active,
        todo,
        trigger_task_id: triggerTaskId,
        attempt,
      },
    }).catch(() => undefined);

    return response;
  }

  return {
    emit,
    taskStatus,
    milestoneStatus,
    workstreamStatus,
    getRunId: () => runId,
  };
}

function buildInitialState({
  jobId,
  initiativeId,
  planPath,
  planHash,
  selectedWorkstreamIds,
  totalTasks,
}) {
  return {
    jobId,
    initiativeId,
    planPath,
    planHash,
    selectedWorkstreamIds,
    totalTasks,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    result: "running",
    completed: 0,
    failed: 0,
    skipped: 0,
    taskStates: {},
    activeWorkers: {},
    rollups: {
      milestones: {},
      workstreams: {},
    },
  };
}

function persistState(pathname, state) {
  const dir = dirname(pathname);
  ensureDir(dir);
  state.updatedAt = nowIso();
  writeFileSync(pathname, JSON.stringify(state, null, 2));
}

function spawnCodexWorker({
  task,
  prompt,
  codexBin,
  codexArgs,
  cwd,
  env,
  logFile,
}) {
  ensureDir(dirname(logFile));
  const stream = createWriteStream(logFile, { flags: "a" });
  stream.write(`\n==== ${nowIso()} :: ${summarizeTask(task)} ====\n`);

  const child = spawn(codexBin, [...codexArgs, prompt], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => stream.write(chunk));
  child.stderr?.on("data", (chunk) => stream.write(chunk));

  const done = new Promise((resolveDone) => {
    child.on("close", (code, signal) => {
      stream.write(
        `\n==== ${nowIso()} :: exit code=${String(code)} signal=${String(signal)} ====\n`
      );
      stream.end();
      resolveDone({
        code: Number.isInteger(code) ? code : -1,
        signal: signal ?? null,
      });
    });
    child.on("error", (error) => {
      stream.write(`\nworker error: ${error.message}\n`);
    });
  });

  return { child, done };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function defaultLogsDir() {
  return resolve(".orgx-codex-jobs");
}

export function buildTaskQueue({
  tasks,
  selectedWorkstreamIds,
  selectedTaskIds,
}) {
  const selectedWs = new Set(selectedWorkstreamIds);
  const selectedTasks = new Set(selectedTaskIds);

  const scoped = tasks.filter((task) => {
    const inWorkstream = selectedWs.size === 0 || selectedWs.has(task.workstream_id);
    const inTaskSet = selectedTasks.size === 0 || selectedTasks.has(task.id);
    return inWorkstream && inTaskSet;
  });

  return sortTasks(scoped);
}

function toPercent(doneCount, totalCount) {
  if (totalCount <= 0) return 0;
  return clampProgress((doneCount / totalCount) * 100) ?? 0;
}

function collectTaskStatuses(taskIds, taskStatusById) {
  return taskIds.map((taskId) => taskStatusById.get(taskId) ?? "todo");
}

function buildTaskIdsByParent(tasks, parentField) {
  const byParent = new Map();
  for (const task of tasks) {
    const parentId = pickString(task[parentField]);
    if (!parentId) continue;
    const list = byParent.get(parentId) ?? [];
    list.push(task.id);
    byParent.set(parentId, list);
  }
  return byParent;
}

function rollupChanged(previous, next) {
  if (!previous) return false;
  return (
    previous.status !== next.status ||
    previous.progressPct !== next.progressPct ||
    previous.total !== next.total ||
    previous.done !== next.done ||
    previous.active !== next.active ||
    previous.blocked !== next.blocked ||
    previous.todo !== next.todo
  );
}

function phaseFromMilestoneStatus(status) {
  if (status === "completed") return "completed";
  if (status === "at_risk") return "blocked";
  return "execution";
}

function levelFromMilestoneStatus(status) {
  return status === "at_risk" ? "warn" : "info";
}

function phaseFromWorkstreamStatus(status) {
  if (status === "done") return "completed";
  if (status === "blocked") return "blocked";
  return "execution";
}

function levelFromWorkstreamStatus(status) {
  return status === "blocked" ? "warn" : "info";
}

function backoffMs(attempt) {
  const pow = Math.max(0, attempt - 1);
  return Math.min(180_000, 15_000 * Math.pow(2, pow));
}

function mergeJobConfig(rawConfig = {}) {
  return {
    defaultCwd: pickString(rawConfig.defaultCwd),
    workstreamCwds: rawConfig.workstreamCwds ?? {},
    workstreamPrompt: rawConfig.workstreamPrompt ?? {},
    taskPrompt: rawConfig.taskPrompt ?? {},
  };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (parseBoolean(args.help, false)) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const initiativeId = pickString(args.initiative_id, env.ORGX_INITIATIVE_ID);
  if (!initiativeId) {
    throw new Error("initiative_id is required (arg or ORGX_INITIATIVE_ID).");
  }

  const apiKey = pickString(env.ORGX_API_KEY);
  if (!apiKey) {
    throw new Error("ORGX_API_KEY is required.");
  }

  const baseUrl = pickString(args.base_url, env.ORGX_BASE_URL, DEFAULT_BASE_URL)
    .replace(/\/+$/, "");
  const userId = pickString(args.user_id, env.ORGX_USER_ID);
  const sourceClient = pickString(args.source_client, env.ORGX_SOURCE_CLIENT, "codex");
  const correlationId = pickString(
    args.correlation_id,
    env.ORGX_CORRELATION_ID,
    `dispatch-${Date.now()}-${randomUUID().slice(0, 8)}`
  );

  const dryRun = parseBoolean(args.dry_run, false);
  const autoComplete = parseBoolean(args.auto_complete, true);
  const concurrency = Math.max(1, parseInteger(args.concurrency, DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, parseInteger(args.max_attempts, DEFAULT_MAX_ATTEMPTS));
  const pollIntervalMs = Math.max(
    1_000,
    parseInteger(args.poll_interval_sec, DEFAULT_POLL_INTERVAL_SEC) * 1_000
  );
  const heartbeatMs = Math.max(
    5_000,
    parseInteger(args.heartbeat_sec, DEFAULT_HEARTBEAT_SEC) * 1_000
  );

  const configFile = pickString(args.config_file);
  const jobConfig = mergeJobConfig(maybeLoadConfig(configFile));

  const allWorkstreams = parseBoolean(args.all_workstreams, false);
  const selectedWorkstreamIds = allWorkstreams
    ? []
    : splitCsv(args.workstream_ids).length > 0
      ? splitCsv(args.workstream_ids)
      : [...DEFAULT_TECHNICAL_WORKSTREAM_IDS];
  const selectedTaskIds = splitCsv(args.task_ids);

  const codexBin = pickString(args.codex_bin, env.ORGX_CODEX_BIN, "codex");
  const codexArgs = splitShellArgs(args.codex_args, ["--full-auto"]);

  const planPath = resolvePlanFile(args.plan_file);
  const planText = readPlan(planPath);
  const planHash = stableHash(planText);

  const logsRoot = resolve(pickString(args.logs_dir, env.ORGX_JOB_LOGS_DIR, defaultLogsDir()));
  const jobId = pickString(args.job_id, `codex-job-${Date.now()}`);
  const logsDir = join(logsRoot, jobId);
  ensureDir(logsDir);

  const stateFile = resolve(
    pickString(args.state_file, join(logsDir, "job-state.json"))
  );

  const client = await createOrgXClient({ apiKey, baseUrl, userId });

  const reporter = createReporter({
    client,
    initiativeId,
    sourceClient,
    correlationId,
    planPath,
    planHash,
    jobId,
    dryRun,
  });

  console.log(
    `[job] starting ${jobId} initiative=${initiativeId} dryRun=${String(dryRun)} concurrency=${concurrency}`
  );

  const [workstreams, milestones, tasks] = await Promise.all([
    listEntities({
      client,
      type: "workstream",
      initiativeId,
      limit: 500,
    }),
    listEntities({
      client,
      type: "milestone",
      initiativeId,
      limit: 4000,
    }),
    listEntities({
      client,
      type: "task",
      initiativeId,
      limit: 4000,
    }),
  ]);

  const queue = buildTaskQueue({
    tasks,
    selectedWorkstreamIds,
    selectedTaskIds,
  });

  const maxTasks = parseInteger(args.max_tasks, Number.POSITIVE_INFINITY);
  const limitedQueue = Number.isFinite(maxTasks) ? queue.slice(0, maxTasks) : queue;

  if (limitedQueue.length === 0) {
    await reporter.emit({
      message: "Dispatcher found no matching tasks to execute.",
      phase: "completed",
      level: "warn",
      progressPct: 100,
      metadata: {
        queue_size: 0,
        selected_workstreams: selectedWorkstreamIds,
      },
    });
    console.log("[job] no tasks to run");
    return { ok: true, jobId, totalTasks: 0 };
  }

  const selectedWorkstreamSet =
    selectedWorkstreamIds.length > 0 ? new Set(selectedWorkstreamIds) : null;
  const relevantWorkstreams = workstreams.filter((workstream) => {
    if (!selectedWorkstreamSet) return true;
    return selectedWorkstreamSet.has(workstream.id);
  });
  const emptyWorkstreams = relevantWorkstreams
    .filter(
      (workstream) => !limitedQueue.some((task) => task.workstream_id === workstream.id)
    )
    .map((workstream) => ({
      id: workstream.id,
      name: workstream.name,
    }));

  const totalTasks = limitedQueue.length;
  const state = buildInitialState({
    jobId,
    initiativeId,
    planPath,
    planHash,
    selectedWorkstreamIds,
    totalTasks,
  });

  const taskStatusById = new Map(
    tasks.map((task) => [task.id, String(task.status ?? "todo")])
  );
  const taskIdsByMilestone = buildTaskIdsByParent(tasks, "milestone_id");
  const taskIdsByWorkstream = buildTaskIdsByParent(tasks, "workstream_id");
  const milestoneNameById = new Map(
    milestones.map((milestone) => [
      milestone.id,
      pickString(milestone.title, milestone.name, milestone.id) ?? milestone.id,
    ])
  );
  const workstreamNameById = new Map(
    workstreams.map((workstream) => [
      workstream.id,
      pickString(workstream.name, workstream.title, workstream.id) ?? workstream.id,
    ])
  );

  const trackedMilestoneIds = new Set(
    limitedQueue
      .map((task) => pickString(task.milestone_id))
      .filter(Boolean)
  );
  const trackedWorkstreamIds = new Set(
    limitedQueue
      .map((task) => pickString(task.workstream_id))
      .filter(Boolean)
  );
  const milestoneRollups = new Map();
  const workstreamRollups = new Map();

  for (const milestoneId of trackedMilestoneIds) {
    const statuses = collectTaskStatuses(
      taskIdsByMilestone.get(milestoneId) ?? [],
      taskStatusById
    );
    const rollup = computeMilestoneRollup(statuses);
    milestoneRollups.set(milestoneId, rollup);
    state.rollups.milestones[milestoneId] = {
      ...rollup,
      updatedAt: nowIso(),
    };
  }
  for (const workstreamId of trackedWorkstreamIds) {
    const statuses = collectTaskStatuses(
      taskIdsByWorkstream.get(workstreamId) ?? [],
      taskStatusById
    );
    const rollup = computeWorkstreamRollup(statuses);
    workstreamRollups.set(workstreamId, rollup);
    state.rollups.workstreams[workstreamId] = {
      ...rollup,
      updatedAt: nowIso(),
    };
  }

  persistState(stateFile, state);

  async function syncParentRollups(task, attempt) {
    const milestoneId = pickString(task.milestone_id);
    if (milestoneId && trackedMilestoneIds.has(milestoneId)) {
      const next = computeMilestoneRollup(
        collectTaskStatuses(taskIdsByMilestone.get(milestoneId) ?? [], taskStatusById)
      );
      const previous = milestoneRollups.get(milestoneId);
      if (rollupChanged(previous, next)) {
        try {
          await reporter.milestoneStatus({
            milestoneId,
            milestoneName: milestoneNameById.get(milestoneId),
            status: next.status,
            statusChanged: previous.status !== next.status,
            progressPct: next.progressPct,
            done: next.done,
            total: next.total,
            blocked: next.blocked,
            active: next.active,
            todo: next.todo,
            triggerTaskId: task.id,
            attempt,
          });
          milestoneRollups.set(milestoneId, next);
          state.rollups.milestones[milestoneId] = {
            ...next,
            updatedAt: nowIso(),
          };
        } catch (error) {
          console.warn(
            `[job] milestone rollup update failed (${milestoneId}): ${error.message}`
          );
        }
      }
    }

    const workstreamId = pickString(task.workstream_id);
    if (workstreamId && trackedWorkstreamIds.has(workstreamId)) {
      const next = computeWorkstreamRollup(
        collectTaskStatuses(taskIdsByWorkstream.get(workstreamId) ?? [], taskStatusById)
      );
      const previous = workstreamRollups.get(workstreamId);
      if (rollupChanged(previous, next)) {
        try {
          await reporter.workstreamStatus({
            workstreamId,
            workstreamName: workstreamNameById.get(workstreamId),
            status: next.status,
            statusChanged: previous.status !== next.status,
            progressPct: next.progressPct,
            done: next.done,
            total: next.total,
            blocked: next.blocked,
            active: next.active,
            todo: next.todo,
            triggerTaskId: task.id,
            attempt,
          });
          workstreamRollups.set(workstreamId, next);
          state.rollups.workstreams[workstreamId] = {
            ...next,
            updatedAt: nowIso(),
          };
        } catch (error) {
          console.warn(
            `[job] workstream rollup update failed (${workstreamId}): ${error.message}`
          );
        }
      }
    }
  }

  await reporter.emit({
    message: `Codex dispatch job started for ${totalTasks} tasks.`,
    phase: "intent",
    level: "info",
    progressPct: 0,
    metadata: {
      total_tasks: totalTasks,
      selected_workstreams: selectedWorkstreamIds.length > 0
        ? selectedWorkstreamIds
        : "all",
      empty_workstreams: emptyWorkstreams,
      codex_bin: codexBin,
      codex_args: codexArgs,
    },
  });

  const pending = limitedQueue.map((task) => ({ task, availableAt: 0 }));
  const running = new Map();
  const completed = new Set();
  const failed = new Set();
  const attempts = new Map();
  const finishedEvents = [];

  let lastHeartbeatAt = 0;
  let completedCount = 0;

  while (pending.length > 0 || running.size > 0) {
    const now = Date.now();

    while (running.size < concurrency) {
      const nextIndex = pending.findIndex((item) => item.availableAt <= now);
      if (nextIndex === -1) break;

      const { task } = pending.splice(nextIndex, 1)[0];
      const nextAttempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, nextAttempt);

      const cwd = toWorkerCwd(task, jobConfig);
      const taskPlanContext = extractPlanContext(planText, task);
      const promptSuffix =
        pickString(jobConfig.workstreamPrompt?.[task.workstream_id]) ?? "";
      const taskPromptSuffix = pickString(jobConfig.taskPrompt?.[task.id]) ?? "";
      const prompt = buildCodexPrompt({
        task,
        planPath,
        planContext:
          [taskPlanContext, promptSuffix, taskPromptSuffix].filter(Boolean).join("\n\n"),
        initiativeId,
        jobId,
        attempt: nextAttempt,
        totalTasks,
        completedTasks: completedCount,
      });

      const workerLogPath = join(logsDir, `${task.id}-attempt-${nextAttempt}.log`);
      const workerEnv = {
        ...env,
        ORGX_INITIATIVE_ID: initiativeId,
        ORGX_TASK_ID: task.id,
        ORGX_CORRELATION_ID: correlationId,
        ORGX_SOURCE_CLIENT: sourceClient,
        ORGX_PLAN_FILE: planPath,
        ORGX_DISPATCH_JOB_ID: jobId,
      };

      await reporter.emit({
        message: `Dispatching ${summarizeTask(task)} (attempt ${nextAttempt}/${maxAttempts})`,
        phase: PHASE_BY_EVENT.dispatch,
        level: "info",
        progressPct: toPercent(completedCount, totalTasks),
        metadata: {
          event: "dispatch",
          task_id: task.id,
          task_title: task.title,
          workstream_id: task.workstream_id,
          cwd,
          attempt: nextAttempt,
          max_attempts: maxAttempts,
          worker_log: workerLogPath,
        },
      }).catch((error) => {
        console.warn(`[job] activity emit failed before dispatch ${task.id}: ${error.message}`);
      });

      if (autoComplete) {
        try {
          await reporter.taskStatus({
            taskId: task.id,
            status: "in_progress",
            attempt: nextAttempt,
            reason: `Dispatched by ${jobId} attempt ${nextAttempt}`,
            metadata: {
              event: "status_update",
              from: task.status,
              to: "in_progress",
            },
          });
          taskStatusById.set(task.id, "in_progress");
          await syncParentRollups(task, nextAttempt);
        } catch (error) {
          console.warn(
            `[job] task status update failed (${task.id} -> in_progress): ${error.message}`
          );
        }
      }

      if (dryRun) {
        finishedEvents.push({
          task,
          attempt: nextAttempt,
          result: { code: 0, signal: null },
          dryRun: true,
          logPath: workerLogPath,
        });
        continue;
      }

      const worker = spawnCodexWorker({
        task,
        prompt,
        codexBin,
        codexArgs,
        cwd,
        env: workerEnv,
        logFile: workerLogPath,
      });

      running.set(task.id, {
        task,
        attempt: nextAttempt,
        startedAt: nowIso(),
        logPath: workerLogPath,
        pid: worker.child.pid,
      });

      state.activeWorkers[task.id] = {
        pid: worker.child.pid,
        attempt: nextAttempt,
        startedAt: nowIso(),
        logPath: workerLogPath,
      };
      persistState(stateFile, state);

      worker.done.then((result) => {
        finishedEvents.push({
          task,
          attempt: nextAttempt,
          result,
          logPath: workerLogPath,
        });
      });
    }

    while (finishedEvents.length > 0) {
      const finished = finishedEvents.shift();
      if (!finished) continue;
      const { task, attempt, result, logPath } = finished;
      running.delete(task.id);
      delete state.activeWorkers[task.id];

      const isSuccess = result.code === 0;
      if (isSuccess) {
        completed.add(task.id);
        completedCount += 1;
        state.completed = completed.size;
        state.taskStates[task.id] = {
          status: "done",
          attempts: attempt,
          exitCode: result.code,
          finishedAt: nowIso(),
          logPath,
        };

        if (autoComplete) {
          try {
            await reporter.taskStatus({
              taskId: task.id,
              status: "done",
              attempt,
              reason: `Worker success from ${jobId}`,
              metadata: {
                event: "status_update",
                to: "done",
                exit_code: result.code,
              },
            });
            taskStatusById.set(task.id, "done");
            await syncParentRollups(task, attempt);
          } catch (error) {
            console.warn(
              `[job] task status update failed (${task.id} -> done): ${error.message}`
            );
          }
        }

        await reporter.emit({
          message: `Completed ${summarizeTask(task)} (attempt ${attempt})`,
          phase: PHASE_BY_EVENT.success,
          level: "info",
          progressPct: toPercent(completedCount, totalTasks),
          metadata: {
            event: "success",
            task_id: task.id,
            attempt,
            exit_code: result.code,
            worker_log: logPath,
          },
        }).catch((error) => {
          console.warn(`[job] activity emit failed on success ${task.id}: ${error.message}`);
        });
      } else {
        const retryable = attempt < maxAttempts;
        const nextAvailableAt = Date.now() + backoffMs(attempt);
        state.taskStates[task.id] = {
          status: retryable ? "retry_pending" : "blocked",
          attempts: attempt,
          exitCode: result.code,
          signal: result.signal,
          finishedAt: nowIso(),
          logPath,
        };

        if (retryable) {
          pending.push({ task, availableAt: nextAvailableAt });
          await reporter.emit({
            message: `Retry scheduled for ${summarizeTask(task)} after non-zero exit (${result.code}).`,
            phase: PHASE_BY_EVENT.retry,
            level: "warn",
            progressPct: toPercent(completedCount, totalTasks),
            metadata: {
              event: "retry",
              task_id: task.id,
              attempt,
              next_attempt: attempt + 1,
              available_at: new Date(nextAvailableAt).toISOString(),
              exit_code: result.code,
              worker_log: logPath,
            },
          }).catch((error) => {
            console.warn(`[job] activity emit failed on retry ${task.id}: ${error.message}`);
          });
        } else {
          failed.add(task.id);
          state.failed = failed.size;
          if (autoComplete) {
            try {
              await reporter.taskStatus({
                taskId: task.id,
                status: "blocked",
                attempt,
                reason: `Worker failed after ${attempt} attempts (exit ${result.code})`,
                metadata: {
                  event: "status_update",
                  to: "blocked",
                  exit_code: result.code,
                },
              });
              taskStatusById.set(task.id, "blocked");
              await syncParentRollups(task, attempt);
            } catch (error) {
              console.warn(
                `[job] task status update failed (${task.id} -> blocked): ${error.message}`
              );
            }
          }

          await reporter.emit({
            message: `Task blocked after ${attempt} attempts: ${summarizeTask(task)}.`,
            phase: PHASE_BY_EVENT.failure,
            level: "error",
            progressPct: toPercent(completedCount, totalTasks),
            metadata: {
              event: "failed",
              task_id: task.id,
              attempt,
              exit_code: result.code,
              signal: result.signal,
              worker_log: logPath,
            },
            nextStep: "Review worker log and unblock before rerun.",
          }).catch((error) => {
            console.warn(`[job] activity emit failed on failure ${task.id}: ${error.message}`);
          });
        }
      }
      persistState(stateFile, state);
    }

    const nowForHeartbeat = Date.now();
    if (nowForHeartbeat - lastHeartbeatAt >= heartbeatMs) {
      lastHeartbeatAt = nowForHeartbeat;
      const runningIds = [...running.keys()];
      await reporter.emit({
        message: `Heartbeat: ${completed.size}/${totalTasks} completed, ${runningIds.length} running, ${pending.length} queued, ${failed.size} blocked.`,
        phase: PHASE_BY_EVENT.heartbeat,
        level: failed.size > 0 ? "warn" : "info",
        progressPct: toPercent(completedCount, totalTasks),
        metadata: {
          event: "heartbeat",
          completed: completed.size,
          total: totalTasks,
          running: runningIds,
          queued: pending.length,
          blocked: failed.size,
        },
      }).catch((error) => {
        console.warn(`[job] heartbeat emit failed: ${error.message}`);
      });
      persistState(stateFile, state);
    }

    if (pending.length === 0 && running.size === 0) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  const success = failed.size === 0;
  state.result = success ? "completed" : "completed_with_blockers";
  state.finishedAt = nowIso();
  state.completed = completed.size;
  state.failed = failed.size;
  persistState(stateFile, state);

  await reporter.emit({
    message: success
      ? `Dispatch job completed successfully. ${completed.size}/${totalTasks} tasks completed.`
      : `Dispatch job finished with blockers. ${completed.size}/${totalTasks} completed, ${failed.size} blocked.`,
    phase: PHASE_BY_EVENT.complete,
    level: success ? "info" : "warn",
    progressPct: toPercent(completed.size, totalTasks),
    metadata: {
      event: "job_complete",
      completed: completed.size,
      total: totalTasks,
      blocked: failed.size,
      state_file: stateFile,
      run_id: reporter.getRunId(),
    },
    nextStep: success
      ? "Validate merged outputs and close launch milestone."
      : "Unblock failed tasks and rerun with --task_ids.",
  }).catch((error) => {
    console.warn(`[job] final emit failed: ${error.message}`);
  });

  console.log(
    `[job] done result=${state.result} completed=${completed.size}/${totalTasks} blocked=${failed.size} state=${stateFile}`
  );

  if (!success) {
    process.exitCode = 2;
  }

  return {
    ok: success,
    jobId,
    totalTasks,
    completed: completed.size,
    blocked: failed.size,
    stateFile,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[job] fatal: ${error.message}`);
    process.exit(1);
  });
}
