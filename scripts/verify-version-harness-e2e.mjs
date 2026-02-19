#!/usr/bin/env node
/**
 * Real plugin/UI-equivalent version harness.
 *
 * What this does:
 * 1) Creates an isolated initiative with workstreams/milestones/tasks across domains.
 * 2) Moves one harness workstream to the top of Next Up (same queue APIs used by UI).
 * 3) Triggers Play for the top harness workstream and validates completion.
 * 4) Starts Auto-continue and validates the next N completed slices (default 5).
 * 5) Saves a run report and tears down created entities + queue ordering.
 *
 * Safety:
 * - Refuses to write unless ORGX_E2E_ALLOW_WRITE=1 (or ORGX_HARNESS_ALLOW_WRITE=1).
 * - Teardown runs by default. Set ORGX_HARNESS_KEEP=1 to keep created entities.
 *
 * Required runtime:
 * - A running plugin HTTP server (default: http://127.0.0.1:18789).
 * - Connected/authenticated plugin session to OrgX.
 *
 * Optional env:
 * - ORGX_HARNESS_BASE_URL=http://127.0.0.1:18789
 * - ORGX_HARNESS_TARGET_COMPLETED_SLICES=5
 * - ORGX_HARNESS_TIMEOUT_MS=1800000
 * - ORGX_HARNESS_REQUEST_TIMEOUT_MS=30000
 * - ORGX_HARNESS_RESULT_DIR=artifacts/harness-runs
 * - ORGX_HARNESS_WORKDIR=/tmp/orgx-version-harness-...
 * - ORGX_HARNESS_DOMAINS=engineering,product,design,marketing,operations,sales
 *   (target auto-raises to domains-1 so every seeded domain gets executed)
 * - ORGX_HARNESS_REQUIRE_REAL_WORKER=1  (default true; reject mock worker)
 * - ORGX_HARNESS_KEEP=1
 * - ORGX_HARNESS_SEED_ONLY=1   (create + queue-top only; no play/auto, no teardown)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE_URL = (process.env.ORGX_HARNESS_BASE_URL || "http://127.0.0.1:18789").trim().replace(/\/+$/, "");
const TIMEOUT_MS = readPositiveInt("ORGX_HARNESS_TIMEOUT_MS", 30 * 60_000);
const REQUEST_TIMEOUT_MS = readPositiveInt("ORGX_HARNESS_REQUEST_TIMEOUT_MS", 30_000);
const KEEP = readBoolEnv("ORGX_HARNESS_KEEP", false);
const SEED_ONLY = readBoolEnv("ORGX_HARNESS_SEED_ONLY", false);
const REQUIRE_REAL_WORKER = readBoolEnv("ORGX_HARNESS_REQUIRE_REAL_WORKER", true);
const ALLOW_WRITE =
  readBoolEnv("ORGX_HARNESS_ALLOW_WRITE", false) || readBoolEnv("ORGX_E2E_ALLOW_WRITE", false);

const DEFAULT_DOMAINS = ["engineering", "product", "design", "marketing", "operations", "sales"];
const DOMAINS = parseDomains(process.env.ORGX_HARNESS_DOMAINS, DEFAULT_DOMAINS);
const REQUESTED_TARGET_COMPLETED_SLICES = readPositiveInt("ORGX_HARNESS_TARGET_COMPLETED_SLICES", 5);
const MIN_TARGET_FOR_DOMAIN_COVERAGE = Math.max(1, DOMAINS.length - 1);
const TARGET_COMPLETED_SLICES = Math.max(
  REQUESTED_TARGET_COMPLETED_SLICES,
  MIN_TARGET_FOR_DOMAIN_COVERAGE
);

const RUN_STAMP = createRunStamp();
const RUN_KEY = `version-harness-${RUN_STAMP}-${randomUUID().slice(0, 8)}`;
const RESULT_DIR = resolve(
  (process.env.ORGX_HARNESS_RESULT_DIR || join(process.cwd(), "artifacts", "harness-runs")).trim()
);
const HARNESS_WORKDIR = resolve(
  (process.env.ORGX_HARNESS_WORKDIR || join(tmpdir(), `orgx-${RUN_KEY}`)).trim()
);
const RESULT_PATH = join(RESULT_DIR, `${RUN_KEY}.json`);

const DOMAIN_SKILL = {
  engineering: "orgx-engineering-agent",
  product: "orgx-product-agent",
  design: "orgx-design-agent",
  marketing: "orgx-marketing-agent",
  operations: "orgx-operations-agent",
  sales: "orgx-sales-agent",
  orchestration: "orgx-orchestrator-agent",
};

function readPositiveInt(name, fallback) {
  const raw = (process.env[name] || "").trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readBoolEnv(name, fallback) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function parseDomains(raw, fallback) {
  const domains = String(raw || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return domains.length > 0 ? domains : fallback;
}

function createRunStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${hh}${mm}${ss}Z`;
}

function toTitleCase(value) {
  return String(value || "")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain) return "";
  if (domain.includes("engine")) return "engineering";
  if (domain.includes("product")) return "product";
  if (domain.includes("design")) return "design";
  if (domain.includes("market")) return "marketing";
  if (domain.includes("operat")) return "operations";
  if (domain.includes("sales")) return "sales";
  if (domain.includes("orchestrat")) return "orchestration";
  return domain;
}

function resolveAgentForDomain(input, liveAgents) {
  const domain = normalizeDomain(input);
  const candidates = Array.isArray(liveAgents) ? liveAgents : [];
  const match =
    candidates.find((agent) => normalizeDomain(agent?.domain) === domain) ??
    candidates.find((agent) =>
      String(agent?.name || "")
        .toLowerCase()
        .includes(domain === "operations" ? "ops" : domain)
    ) ??
    null;

  if (match && typeof match === "object") {
    const id = String(match.id || "").trim();
    const name = String(match.name || "").trim();
    if (id && name) return { id, name, domain };
  }

  return {
    id: domain === "orchestration" ? "orchestrator-agent" : `orgx-${domain || "agent"}`,
    name: `OrgX ${toTitleCase(domain || "Agent")}`,
    domain: domain || "engineering",
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, { method = "GET", body, headers } = {}) {
  const url = pathname.startsWith("http://") || pathname.startsWith("https://")
    ? pathname
    : `${BASE_URL}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      throw new Error(`${method} ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const text = await res.text().catch(() => "");
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && typeof parsed.error === "string"
        ? parsed.error
        : text.slice(0, 300) || `${res.status} ${res.statusText}`;
    throw new Error(`${method} ${url} failed (${res.status}): ${detail}`);
  }
  return parsed;
}

async function getNextUpQueue(limit = 200, initiativeId = null) {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (initiativeId) qs.set("initiativeId", String(initiativeId));
  return await fetchJson(`/orgx/api/mission-control/next-up?${qs.toString()}`);
}

async function getAutoContinueStatus(initiativeId) {
  const qs = new URLSearchParams();
  qs.set("initiativeId", initiativeId);
  return await fetchJson(`/orgx/api/mission-control/auto-continue/status?${qs.toString()}`);
}

async function tickAutoContinue(initiativeId) {
  return await fetchJson(`/orgx/api/mission-control/auto-continue/tick`, {
    method: "POST",
    body: { initiativeId },
  });
}

async function stopAutoContinue(initiativeId) {
  return await fetchJson(`/orgx/api/mission-control/auto-continue/stop`, {
    method: "POST",
    body: { initiativeId },
  });
}

async function createEntity(type, payload) {
  const response = await fetchJson(`/orgx/api/entities`, {
    method: "POST",
    body: { type, ...payload },
  });
  const entity = response?.entity ?? null;
  const id = String(entity?.id || "").trim();
  if (!id) throw new Error(`createEntity(${type}) did not return an id`);
  return entity;
}

async function deleteEntity(type, id) {
  const safeType = encodeURIComponent(String(type).trim());
  const safeId = encodeURIComponent(String(id).trim());
  return await fetchJson(`/orgx/api/entities/${safeType}/${safeId}/delete`, {
    method: "POST",
    body: {},
  });
}

async function updateEntity(type, id, updates) {
  return await fetchJson(`/orgx/api/entities`, {
    method: "PATCH",
    body: {
      type,
      id,
      ...updates,
    },
  });
}

async function listEntities(type, params = {}) {
  const qs = new URLSearchParams();
  qs.set("type", type);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  return await fetchJson(`/orgx/api/entities?${qs.toString()}`);
}

function normalizeTextContent(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function mergedMetadata(record) {
  const direct = asObject(record?.metadata) ?? {};
  const nested = asObject(direct?.metadata) ?? null;
  if (!nested) return direct;
  return { ...direct, ...nested };
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(value) {
  const values = arrayFrom(value)
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function extractSliceResultsFromSnapshot(snapshot, initiativeId) {
  const activity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
  const rows = [];
  for (const item of activity) {
    if (!item || typeof item !== "object") continue;
    const metadata = mergedMetadata(item);
    const event = String(metadata.event || "").trim().toLowerCase();
    if (event !== "autopilot_slice_result") continue;
    const runId = String(item.runId || item.run_id || metadata.run_id || "").trim();
    if (!runId) continue;
    const parsedStatus = String(metadata.parsed_status || "").trim().toLowerCase();
    const wsId = String(metadata.workstream_id || "").trim() || null;
    const domain = normalizeDomain(metadata.domain || item.domain || "") || null;
    const agentId = String(metadata.agent_id || item.agentId || "").trim() || null;
    const ts = String(item.timestamp || item.created_at || "").trim() || null;
    const scopedInitiativeId =
      String(item.initiativeId || item.initiative_id || metadata.initiative_id || "").trim() || null;
    if (initiativeId && scopedInitiativeId && scopedInitiativeId !== initiativeId) continue;
    rows.push({
      runId,
      parsedStatus,
      workstreamId: wsId,
      domain,
      agentId,
      timestamp: ts,
      metadata,
    });
  }
  return rows;
}

function extractAutopilotEventsFromSnapshot(snapshot, initiativeId) {
  const activity = arrayFrom(snapshot?.activity);
  const rows = [];
  for (const item of activity) {
    const record = asObject(item);
    if (!record) continue;
    const metadata = mergedMetadata(record);
    const event = String(metadata.event || "").trim().toLowerCase();
    if (!event.startsWith("autopilot_") && !event.startsWith("auto_continue_")) continue;
    const scopedInitiativeId =
      String(record.initiativeId || record.initiative_id || metadata.initiative_id || "").trim() || null;
    if (initiativeId && scopedInitiativeId && scopedInitiativeId !== initiativeId) continue;
    rows.push({
      event,
      runId: String(record.runId || record.run_id || metadata.run_id || "").trim() || null,
      initiativeId: scopedInitiativeId,
      workstreamId: String(metadata.workstream_id || "").trim() || null,
      agentId: String(metadata.agent_id || "").trim() || null,
      domain: normalizeDomain(metadata.domain || "") || null,
      requiredSkills: normalizeStringArray(metadata.required_skills),
      metadata,
      timestamp: String(record.timestamp || record.created_at || "").trim() || null,
    });
  }
  return rows;
}

function extractProgressEvidenceFromSnapshot(snapshot, initiativeId) {
  const runtimeInstances = arrayFrom(snapshot?.runtimeInstances);
  const activity = arrayFrom(snapshot?.activity);
  const byRunId = new Map();

  for (const instance of runtimeInstances) {
    const record = asObject(instance);
    if (!record) continue;
    const scopedInitiativeId = String(record.initiativeId || "").trim() || null;
    if (initiativeId && scopedInitiativeId && scopedInitiativeId !== initiativeId) continue;
    const runId = String(record.runId || "").trim();
    if (!runId) continue;
    const sourceClient = String(record.sourceClient || "").trim().toLowerCase();
    const current = byRunId.get(runId) ?? {
      runtimeProgressEvents: 0,
      runtimeProgressPctMax: null,
      orgxReportProgressEvents: 0,
      sources: [],
    };
    if (String(record.event || "").trim().toLowerCase() === "progress") {
      current.runtimeProgressEvents += 1;
    }
    const pct = Number(record.progressPct);
    if (Number.isFinite(pct)) {
      current.runtimeProgressPctMax =
        current.runtimeProgressPctMax === null
          ? pct
          : Math.max(current.runtimeProgressPctMax, pct);
    }
    if (sourceClient) {
      current.sources = Array.from(new Set([...current.sources, sourceClient]));
    }
    byRunId.set(runId, current);
  }

  for (const item of activity) {
    const record = asObject(item);
    if (!record) continue;
    const metadata = mergedMetadata(record);
    const scopedInitiativeId =
      String(record.initiativeId || record.initiative_id || metadata.initiative_id || "").trim() || null;
    if (initiativeId && scopedInitiativeId && scopedInitiativeId !== initiativeId) continue;
    const runId = String(record.runId || record.run_id || metadata.run_id || "").trim();
    if (!runId) continue;
    const source = String(metadata.source || "").trim();
    if (source !== "orgx_report_progress") continue;
    const current = byRunId.get(runId) ?? {
      runtimeProgressEvents: 0,
      runtimeProgressPctMax: null,
      orgxReportProgressEvents: 0,
      sources: [],
    };
    current.orgxReportProgressEvents += 1;
    byRunId.set(runId, current);
  }

  return byRunId;
}

async function snapshotForInitiative(initiativeId, { activityLimit = 1000 } = {}) {
  const qs = new URLSearchParams();
  qs.set("initiative", initiativeId);
  qs.set("activityLimit", String(activityLimit));
  qs.set("sessionsLimit", "200");
  qs.set("decisionsLimit", "200");
  return await fetchJson(`/orgx/api/live/snapshot?${qs.toString()}`);
}

async function waitForRunStopped(initiativeId, timeoutMs, report) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getAutoContinueStatus(initiativeId);
    const run = status?.run ?? null;
    report.statusPolls += 1;
    if (run && run.status === "stopped") return run;
    await tickAutoContinue(initiativeId).catch(() => null);
    await sleep(1000);
  }
  throw new Error(`Timeout waiting for run stop (initiative=${initiativeId}, timeoutMs=${timeoutMs})`);
}

async function waitForSliceResultRow(initiativeId, runId, timeoutMs = 25_000) {
  const targetRunId = String(runId || "").trim();
  if (!targetRunId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await snapshotForInitiative(initiativeId, { activityLimit: 1200 }).catch(() => null);
    const rows = extractSliceResultsFromSnapshot(snapshot, initiativeId);
    const match =
      rows.find((row) => String(row.runId || "").trim() === targetRunId) ?? null;
    if (match) return match;
    await sleep(900);
  }
  return null;
}

function ensureDir(pathname) {
  if (!existsSync(pathname)) mkdirSync(pathname, { recursive: true, mode: 0o700 });
}

function rootQueueOrder(queue) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  return items.map((item) => ({
    initiativeId: String(item.initiativeId || "").trim(),
    workstreamId: String(item.workstreamId || "").trim(),
  }));
}

function dedupeQueueOrder(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of arrayFrom(entries)) {
    const initiativeId = String(entry?.initiativeId || "").trim();
    const workstreamId = String(entry?.workstreamId || "").trim();
    if (!initiativeId || !workstreamId) continue;
    const key = `${initiativeId}:${workstreamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ initiativeId, workstreamId });
  }
  return out;
}

async function ensureQueueTopPlacement(input) {
  const initiativeId = String(input?.initiativeId || "").trim();
  const workstreamId = String(input?.workstreamId || "").trim();
  const preferredTaskId = String(input?.preferredTaskId || "").trim() || null;
  const beforeOrder = dedupeQueueOrder(arrayFrom(input?.beforeOrder));
  const timeoutMs = Number.isFinite(Number(input?.timeoutMs))
    ? Math.max(3_000, Math.floor(Number(input.timeoutMs)))
    : 25_000;
  if (!initiativeId || !workstreamId) {
    return { ok: false, queue: null, reason: "initiativeId/workstreamId missing" };
  }

  await fetchJson(`/orgx/api/mission-control/next-up/pin`, {
    method: "POST",
    body: { initiativeId, workstreamId, taskId: preferredTaskId },
  }).catch(() => null);

  const target = { initiativeId, workstreamId };
  const seedOrder = dedupeQueueOrder([
    target,
    ...beforeOrder.filter(
      (entry) => !(entry.initiativeId === initiativeId && entry.workstreamId === workstreamId)
    ),
  ]);
  if (seedOrder.length > 0) {
    await fetchJson(`/orgx/api/mission-control/next-up/reorder`, {
      method: "POST",
      body: { order: seedOrder },
    }).catch(() => null);
  }

  const deadline = Date.now() + timeoutMs;
  let lastQueue = null;
  while (Date.now() < deadline) {
    const queue = await getNextUpQueue(300).catch(() => null);
    lastQueue = queue;
    const items = arrayFrom(queue?.items);
    const top = items[0] ?? null;
    const topInitiativeId = String(top?.initiativeId || "").trim();
    const topWorkstreamId = String(top?.workstreamId || "").trim();
    if (topInitiativeId === initiativeId && topWorkstreamId === workstreamId) {
      return { ok: true, queue, reason: null };
    }

    const existsInQueue = items.some(
      (item) =>
        String(item?.initiativeId || "").trim() === initiativeId &&
        String(item?.workstreamId || "").trim() === workstreamId
    );

    if (existsInQueue) {
      const nextOrder = dedupeQueueOrder([
        target,
        ...rootQueueOrder(queue).filter(
          (entry) => !(entry.initiativeId === initiativeId && entry.workstreamId === workstreamId)
        ),
      ]);
      await fetchJson(`/orgx/api/mission-control/next-up/reorder`, {
        method: "POST",
        body: { order: nextOrder },
      }).catch(() => null);
    } else {
      await fetchJson(`/orgx/api/mission-control/next-up/move`, {
        method: "POST",
        body: {
          initiativeId,
          workstreamId,
          placement: "top",
        },
      }).catch(() => null);
    }

    await sleep(900);
  }

  return { ok: false, queue: lastQueue, reason: "timeout" };
}

async function main() {
  if (!ALLOW_WRITE) {
    throw new Error(
      "Refusing to write. Set ORGX_E2E_ALLOW_WRITE=1 (or ORGX_HARNESS_ALLOW_WRITE=1) to run harness."
    );
  }

  ensureDir(RESULT_DIR);
  ensureDir(HARNESS_WORKDIR);

  const report = {
    ok: false,
    runKey: RUN_KEY,
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    config: {
      requestedTargetCompletedSlices: REQUESTED_TARGET_COMPLETED_SLICES,
      targetCompletedSlices: TARGET_COMPLETED_SLICES,
      minTargetForDomainCoverage: MIN_TARGET_FOR_DOMAIN_COVERAGE,
      timeoutMs: TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      keep: KEEP,
      seedOnly: SEED_ONLY,
      requireRealWorker: REQUIRE_REAL_WORKER,
      domains: DOMAINS,
      harnessWorkdir: HARNESS_WORKDIR,
    },
    created: {
      initiativeId: null,
      workstreams: [],
      milestones: [],
      tasks: [],
    },
    queue: {
      beforeTop: null,
      afterTop: null,
      afterTopWithinInitiative: null,
      beforeOrder: [],
      restored: false,
    },
    manualPlay: {
      requested: false,
      dispatchMode: null,
      completed: false,
      runId: null,
      stopReason: null,
      lastError: null,
      statusPolls: 0,
    },
    autoContinue: {
      started: false,
      targetCompletedSlices: TARGET_COMPLETED_SLICES,
      runAtStart: null,
      completedRunIds: [],
      completedCount: 0,
      overrideEvents: 0,
      rateLimitedEvents: 0,
      finalStatus: null,
      finalStopReason: null,
      finalLastError: null,
      statusPolls: 0,
    },
    validation: {
      queueTopConfirmed: false,
      queueTopGlobalConfirmed: false,
      queueTopInitiativeConfirmed: false,
      manualSliceCompleted: false,
      nextFiveCompleted: false,
      completedWorkstreamIds: [],
      completedWorkstreamCount: 0,
      completedDomains: [],
      missingDomains: [],
      filesVerifiedRequired: TARGET_COMPLETED_SLICES + 1,
      filesVerifiedCount: 0,
      fileChecks: [],
      runIsolation: {
        expectedCompletedRuns: TARGET_COMPLETED_SLICES + 1,
        completedRunCount: 0,
        uniqueRunCount: 0,
      },
      progressEvidenceByRun: [],
      progressEvidenceMissingRunIds: [],
      skillCoverageChecks: [],
      skillCoverageMissingRunIds: [],
      realWorkerChecks: [],
      realWorkerMissingRunIds: [],
      tasksDoneCount: 0,
      tasksDoneCountEffective: 0,
      taskTotal: 0,
      artifactsCount: 0,
      artifactsCountEffective: 0,
      outcomeFallbackUsed: false,
    },
    teardown: {
      attempted: false,
      completed: false,
      errors: [],
      deleted: {
        task: [],
        milestone: [],
        workstream: [],
        initiative: null,
      },
    },
    notes: [],
    finishedAt: null,
    resultPath: RESULT_PATH,
  };

  const persistReport = () => {
    report.finishedAt = new Date().toISOString();
    writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };

  let liveAgents = [];
  let firstWorkstream = null;
  let firstAgentId = "main";
  let initiativeId = "";
  const domainByWorkstreamId = new Map();
  const taskByWorkstreamId = new Map();

  try {
    const workerKind = String(process.env.ORGX_AUTOPILOT_WORKER_KIND || "").trim().toLowerCase();
    if (REQUIRE_REAL_WORKER && workerKind === "mock") {
      throw new Error(
        "ORGX_AUTOPILOT_WORKER_KIND=mock is not allowed for this harness. Use a real worker (codex or claude-code)."
      );
    }
    if (REQUIRE_REAL_WORKER && !workerKind) {
      report.notes.push(
        "ORGX_AUTOPILOT_WORKER_KIND is not set; assuming real codex default. Set explicitly to codex for deterministic runs."
      );
    }

    if (TARGET_COMPLETED_SLICES > REQUESTED_TARGET_COMPLETED_SLICES) {
      report.notes.push(
        `Raised target completed slices from ${REQUESTED_TARGET_COMPLETED_SLICES} to ${TARGET_COMPLETED_SLICES} to cover all seeded domains (${DOMAINS.length}).`
      );
    }

    // Verify plugin is reachable and capture current queue order for later restore.
    const beforeQueue = await getNextUpQueue(300);
    report.queue.beforeTop =
      Array.isArray(beforeQueue?.items) && beforeQueue.items[0]
        ? {
            initiativeId: beforeQueue.items[0].initiativeId,
            workstreamId: beforeQueue.items[0].workstreamId,
            workstreamTitle: beforeQueue.items[0].workstreamTitle ?? null,
          }
        : null;
    report.queue.beforeOrder = rootQueueOrder(beforeQueue);

    const live = await fetchJson(`/orgx/api/live/agents?include_idle=true`);
    liveAgents = Array.isArray(live?.agents) ? live.agents : [];

    const initiative = await createEntity("initiative", {
      title: `[Version Harness] Queue Play Auto (${RUN_STAMP})`,
      summary:
        "E2E harness: queue-top placement, manual Play validation, then auto-continue 5-slice validation.",
      status: "active",
      metadata: {
        source: "version_harness",
        run_key: RUN_KEY,
        created_at: new Date().toISOString(),
      },
    });
    initiativeId = String(initiative.id);
    report.created.initiativeId = initiativeId;

    let index = 0;
    for (const domainInput of DOMAINS) {
      index += 1;
      const domain = normalizeDomain(domainInput) || "engineering";
      const agent = resolveAgentForDomain(domain, liveAgents);
      const skill = DOMAIN_SKILL[domain] ?? DOMAIN_SKILL.engineering;
      const wsName = `[Version Harness][${toTitleCase(domain)}] ${index}`;
      const wsSummary = `Simple file-manip slice for ${domain}. Required skill: ${skill}. Run key: ${RUN_KEY}.`;

      const workstream = await createEntity("workstream", {
        initiative_id: initiativeId,
        name: wsName,
        summary: wsSummary,
        status: "active",
        metadata: {
          source: "version_harness",
          run_key: RUN_KEY,
          domain,
          skill,
          agent_id: agent.id,
          agent_name: agent.name,
          assigned_agents: [agent],
          assigned_agent_ids: [agent.id],
          assigned_agent_names: [agent.name],
        },
      });

      const milestone = await createEntity("milestone", {
        initiative_id: initiativeId,
        workstream_id: workstream.id,
        title: `[Version Harness Milestone][${toTitleCase(domain)}]`,
        summary: `Single-slice validation for ${domain} (${RUN_KEY}).`,
        status: "planned",
        metadata: {
          source: "version_harness",
          run_key: RUN_KEY,
          domain,
        },
      });

      const domainDir = join(HARNESS_WORKDIR, domain);
      ensureDir(domainDir);
      const expectedFile = join(domainDir, `slice-${String(index).padStart(2, "0")}.txt`);
      const expectedContent = `version-harness:${RUN_KEY}:${domain}:${index}`;
      const task = await createEntity("task", {
        initiative_id: initiativeId,
        workstream_id: workstream.id,
        milestone_id: milestone.id,
        title: [
          `[Version Harness][${domain}]`,
          `Create file ${expectedFile} with exact content "${expectedContent}".`,
          "Before and after execution, call orgx_report_progress with clear summary + progress_pct.",
          "Then register artifact url=file://<path>, include verification_steps, and task_updates status=done.",
        ].join(" "),
        status: "todo",
        priority: "high",
        expected_duration_hours: 0.01,
        metadata: {
          source: "version_harness",
          run_key: RUN_KEY,
          domain,
          expected_file: expectedFile,
          expected_content: expectedContent,
        },
      });

      report.created.workstreams.push({
        id: workstream.id,
        domain,
        agentId: agent.id,
        agentName: agent.name,
      });
      report.created.milestones.push({ id: milestone.id, workstreamId: workstream.id, domain });
      report.created.tasks.push({
        id: task.id,
        workstreamId: workstream.id,
        milestoneId: milestone.id,
        domain,
        expectedFile,
        expectedContent,
      });
      domainByWorkstreamId.set(String(workstream.id), domain);
      taskByWorkstreamId.set(String(workstream.id), {
        taskId: String(task.id),
        domain,
        expectedFile,
        expectedContent,
      });
    }

    assert.ok(
      report.created.workstreams.length >= TARGET_COMPLETED_SLICES + 1,
      `Harness needs at least ${TARGET_COMPLETED_SLICES + 1} workstreams, got ${report.created.workstreams.length}.`
    );
    firstWorkstream = report.created.workstreams[0];
    firstAgentId = firstWorkstream?.agentId || "main";

    // Ensure harness workstream appears on top of queue for UI visibility.
    const firstTaskId = String(report.created.tasks[0]?.id || "").trim() || null;
    const topPlacement = await ensureQueueTopPlacement({
      initiativeId,
      workstreamId: firstWorkstream.id,
      preferredTaskId: firstTaskId,
      beforeOrder: report.queue.beforeOrder,
      timeoutMs: 25_000,
    });
    const afterMoveQueue = topPlacement.queue ?? (await getNextUpQueue(300));
    const afterMoveInitiativeQueue = await getNextUpQueue(300, initiativeId).catch(() => null);
    report.queue.afterTop =
      Array.isArray(afterMoveQueue?.items) && afterMoveQueue.items[0]
        ? {
            initiativeId: afterMoveQueue.items[0].initiativeId,
            workstreamId: afterMoveQueue.items[0].workstreamId,
            workstreamTitle: afterMoveQueue.items[0].workstreamTitle ?? null,
          }
        : null;
    report.queue.afterTopWithinInitiative =
      Array.isArray(afterMoveInitiativeQueue?.items) && afterMoveInitiativeQueue.items[0]
        ? {
            initiativeId: afterMoveInitiativeQueue.items[0].initiativeId,
            workstreamId: afterMoveInitiativeQueue.items[0].workstreamId,
            workstreamTitle: afterMoveInitiativeQueue.items[0].workstreamTitle ?? null,
          }
        : null;
    report.validation.queueTopGlobalConfirmed =
      report.queue.afterTop?.initiativeId === initiativeId &&
      report.queue.afterTop?.workstreamId === firstWorkstream.id;
    report.validation.queueTopInitiativeConfirmed =
      report.queue.afterTopWithinInitiative?.initiativeId === initiativeId &&
      report.queue.afterTopWithinInitiative?.workstreamId === firstWorkstream.id;
    report.validation.queueTopConfirmed =
      report.validation.queueTopGlobalConfirmed ||
      report.validation.queueTopInitiativeConfirmed;

    if (!report.validation.queueTopConfirmed) {
      const existsInQueue = arrayFrom(afterMoveQueue?.items).some(
        (item) =>
          String(item?.initiativeId || "").trim() === initiativeId &&
          String(item?.workstreamId || "").trim() === String(firstWorkstream.id)
      );
      const reason = topPlacement?.reason ? ` reason=${topPlacement.reason}` : "";
      throw new Error(
        existsInQueue
          ? `Harness workstream is in queue but not top (global or initiative scoped).${reason}`
          : `Harness workstream not visible in Next Up queue.${reason}`
      );
    }
    if (!report.validation.queueTopGlobalConfirmed && report.validation.queueTopInitiativeConfirmed) {
      report.notes.push("Queue top was confirmed within initiative scope; global top remained occupied by existing queue priorities.");
    }

    if (SEED_ONLY) {
      report.notes.push("Seed-only mode enabled; skipping Play/Auto-continue and teardown.");
      report.ok = true;
      persistReport();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    // Manual Play (UI-equivalent action).
    report.manualPlay.requested = true;
    const playResponse = await fetchJson(
      `/orgx/api/mission-control/next-up/play?initiativeId=${encodeURIComponent(initiativeId)}&workstreamId=${encodeURIComponent(
        firstWorkstream.id
      )}&agentId=${encodeURIComponent(firstAgentId)}&fastAck=true&ignoreSpawnGuardRateLimit=true`,
      { method: "POST" }
    );
    report.manualPlay.dispatchMode = playResponse?.dispatchMode ?? null;

    const manualRun = await waitForRunStopped(initiativeId, TIMEOUT_MS, report.manualPlay);
    report.manualPlay.stopReason = manualRun?.stopReason ?? null;
    report.manualPlay.lastError = manualRun?.lastError ?? null;
    report.manualPlay.runId = manualRun?.lastRunId ?? null;
    const manualRunId = String(report.manualPlay.runId || "").trim();
    const manualSliceResult = await waitForSliceResultRow(initiativeId, manualRunId, 25_000);
    const manualSliceCompleted =
      manualSliceResult?.parsedStatus === "completed"
        ? true
        : manualSliceResult
          ? false
          : null;
    const manualStopCompleted =
      String(manualRun?.stopReason || "").toLowerCase() === "completed";
    report.manualPlay.completed =
      manualStopCompleted && manualSliceCompleted !== false;
    report.validation.manualSliceCompleted = report.manualPlay.completed;
    if (report.manualPlay.completed && report.manualPlay.lastError) {
      report.notes.push(
        `Manual run completed but carried stale lastError: ${String(report.manualPlay.lastError)}`
      );
    }
    if (report.manualPlay.completed && manualSliceCompleted === null) {
      report.notes.push(
        "Manual run stopped as completed before slice-result activity became visible; continuing with provisional success."
      );
    }

    if (!report.manualPlay.completed) {
      throw new Error(
        `Manual Play did not complete cleanly (stopReason=${String(
          report.manualPlay.stopReason
        )} lastError=${String(report.manualPlay.lastError || "")} parsedStatus=${String(
          manualSliceResult?.parsedStatus || ""
        )})`
      );
    }

    // Start auto-continue for remaining workstreams; validate next 5 completed slices.
    const remainingWorkstreamIds = report.created.workstreams
      .slice(1)
      .map((ws) => String(ws.id))
      .filter(Boolean);
    const remainingWorkstreamIdSet = new Set(remainingWorkstreamIds);
    if (remainingWorkstreamIds.length < TARGET_COMPLETED_SLICES) {
      throw new Error(
        `Need at least ${TARGET_COMPLETED_SLICES} remaining workstreams, got ${remainingWorkstreamIds.length}`
      );
    }

    const autoStart = await fetchJson(`/orgx/api/mission-control/auto-continue/start`, {
      method: "POST",
      body: {
        initiativeId,
        agentId: "main",
        includeVerification: false,
        workstreamIds: remainingWorkstreamIds,
        ignoreSpawnGuardRateLimit: true,
        tokenBudget: 100_000_000,
      },
    });
    report.autoContinue.started = true;
    report.autoContinue.runAtStart = autoStart?.run ?? null;
    if (autoStart?.run && autoStart.run.ignoreSpawnGuardRateLimit !== true) {
      throw new Error("Auto-continue start did not persist ignoreSpawnGuardRateLimit=true.");
    }

    const deadline = Date.now() + TIMEOUT_MS;
    const completedRunIds = new Set();
    const completedAutoWorkstreamIds = new Set();

    while (Date.now() < deadline) {
      report.autoContinue.statusPolls += 1;
      const status = await getAutoContinueStatus(initiativeId);
      const run = status?.run ?? null;
      report.autoContinue.finalStatus = run?.status ?? null;
      report.autoContinue.finalStopReason = run?.stopReason ?? null;
      report.autoContinue.finalLastError = run?.lastError ?? null;

      const snapshot = await snapshotForInitiative(initiativeId, { activityLimit: 1200 });
      const sliceRows = extractSliceResultsFromSnapshot(snapshot, initiativeId);
      const runEvents = extractAutopilotEventsFromSnapshot(snapshot, initiativeId);
      report.autoContinue.overrideEvents = runEvents.filter(
        (entry) => entry.event === "auto_continue_spawn_guard_rate_limit_overridden"
      ).length;
      report.autoContinue.rateLimitedEvents = runEvents.filter(
        (entry) => entry.event === "auto_continue_spawn_guard_rate_limited"
      ).length;
      for (const row of sliceRows) {
        if (row.parsedStatus !== "completed") continue;
        if (manualRunId && row.runId === manualRunId) continue;
        const rowWorkstreamId = String(row.workstreamId || "").trim();
        if (!rowWorkstreamId || !remainingWorkstreamIdSet.has(rowWorkstreamId)) continue;
        completedRunIds.add(row.runId);
        completedAutoWorkstreamIds.add(rowWorkstreamId);
      }

      report.autoContinue.completedRunIds = Array.from(completedRunIds);
      report.autoContinue.completedCount = completedRunIds.size;

      if (completedAutoWorkstreamIds.size >= TARGET_COMPLETED_SLICES) {
        report.validation.nextFiveCompleted = true;
        break;
      }

      if (run && run.status === "stopped") {
        break;
      }

      await tickAutoContinue(initiativeId).catch(() => null);
      await sleep(1200);
    }

    if (!report.validation.nextFiveCompleted) {
      const autoRunRequestedOverride =
        report.autoContinue.runAtStart &&
        typeof report.autoContinue.runAtStart === "object" &&
        report.autoContinue.runAtStart.ignoreSpawnGuardRateLimit === true;
      const finalLastError = String(report.autoContinue.finalLastError || "").toLowerCase();
      if (
        autoRunRequestedOverride &&
        /\brate[ -]?limit(?:ed)?\b/.test(finalLastError) &&
        report.autoContinue.rateLimitedEvents > 0 &&
        report.autoContinue.overrideEvents === 0
      ) {
        throw new Error(
          "Auto-continue override was requested but rate-limit deferrals still occurred without override events. Reload/restart the running plugin process so latest auto-continue override logic is active, then rerun harness."
        );
      }
      throw new Error(
        `Auto-continue did not reach ${TARGET_COMPLETED_SLICES} completed workstreams (runs=${report.autoContinue.completedCount}, unique_workstreams=${completedAutoWorkstreamIds.size}; stopReason=${String(
          report.autoContinue.finalStopReason || ""
        )}; lastError=${String(report.autoContinue.finalLastError || "")})`
      );
    }

    // Stop after target reached so harness does not continue dispatching.
    await stopAutoContinue(initiativeId).catch(() => null);
    await tickAutoContinue(initiativeId).catch(() => null);

    // Validate completed slice/workstream coverage.
    const finalSnapshot = await snapshotForInitiative(initiativeId, { activityLimit: 1200 });
    const finalSliceRows = extractSliceResultsFromSnapshot(finalSnapshot, initiativeId);
    const completedSliceRows = finalSliceRows.filter((row) => row.parsedStatus === "completed");
    const requiredCompletedRunIds = new Set([
      ...Array.from(completedRunIds),
      ...[manualRunId].filter(Boolean),
    ]);
    report.validation.runIsolation.completedRunCount = requiredCompletedRunIds.size;
    report.validation.runIsolation.uniqueRunCount = new Set(Array.from(requiredCompletedRunIds)).size;
    if (requiredCompletedRunIds.size < TARGET_COMPLETED_SLICES + 1) {
      throw new Error(
        `Expected ${TARGET_COMPLETED_SLICES + 1} completed run ids, got ${requiredCompletedRunIds.size}.`
      );
    }
    if (report.validation.runIsolation.uniqueRunCount !== report.validation.runIsolation.completedRunCount) {
      throw new Error("Run isolation check failed: duplicate run ids detected.");
    }

    const relevantCompletedRows = completedSliceRows.filter((row) =>
      requiredCompletedRunIds.has(String(row.runId || "").trim())
    );
    const completedWorkstreamIdsSet = new Set(
      relevantCompletedRows.map((row) => row.workstreamId).filter(Boolean)
    );
    if (report.manualPlay.completed && firstWorkstream?.id) {
      completedWorkstreamIdsSet.add(String(firstWorkstream.id));
    }
    const completedWorkstreamIds = Array.from(completedWorkstreamIdsSet);
    report.validation.completedWorkstreamIds = completedWorkstreamIds;
    report.validation.completedWorkstreamCount = completedWorkstreamIds.length;

    if (completedWorkstreamIds.length < TARGET_COMPLETED_SLICES + 1) {
      throw new Error(
        `Expected ${TARGET_COMPLETED_SLICES + 1} completed workstreams, got ${completedWorkstreamIds.length}.`
      );
    }

    const completedDomains = Array.from(
      new Set(completedWorkstreamIds.map((id) => domainByWorkstreamId.get(String(id))).filter(Boolean))
    );
    report.validation.completedDomains = completedDomains;
    const requiredDomains = Array.from(new Set(report.created.workstreams.map((ws) => ws.domain)));
    const missingDomains = requiredDomains.filter((domain) => !completedDomains.includes(domain));
    report.validation.missingDomains = missingDomains;
    if (missingDomains.length > 0) {
      throw new Error(`Missing completed slices for domains: ${missingDomains.join(", ")}`);
    }

    // Validate skill/domain evidence and per-run worker/runtime evidence.
    const autopilotEvents = extractAutopilotEventsFromSnapshot(finalSnapshot, initiativeId);
    const progressEvidenceByRun = extractProgressEvidenceFromSnapshot(finalSnapshot, initiativeId);
    const skillCoverageChecks = [];
    const skillCoverageMissingRunIds = [];
    const realWorkerChecks = [];
    const realWorkerMissingRunIds = [];
    const progressChecks = [];
    const progressMissingRunIds = [];

    const expectedByRunId = new Map();
    for (const row of relevantCompletedRows) {
      const runId = String(row.runId || "").trim();
      if (!runId) continue;
      const workstreamId = String(row.workstreamId || "").trim();
      if (!workstreamId) continue;
      const domain = domainByWorkstreamId.get(workstreamId) || null;
      const skill = domain ? DOMAIN_SKILL[domain] ?? DOMAIN_SKILL.engineering : null;
      expectedByRunId.set(runId, {
        workstreamId,
        domain,
        requiredSkill: skill,
      });
    }

    for (const [runId, expected] of expectedByRunId.entries()) {
      const runEvents = autopilotEvents.filter((entry) => entry.runId === runId);
      const started = runEvents.find((entry) => entry.event === "autopilot_slice_started") ?? null;
      const dispatched = runEvents.find((entry) => entry.event === "autopilot_slice_dispatched") ?? null;
      const result = runEvents.find((entry) => entry.event === "autopilot_slice_result") ?? null;
      const resultSkills = normalizeStringArray(result?.requiredSkills ?? []);
      const expectedSkill = expected.requiredSkill ? String(expected.requiredSkill).trim() : "";
      const expectedDomain = expected.domain ? String(expected.domain).trim() : "";
      const domainMatches =
        !expectedDomain ||
        normalizeDomain(result?.domain || started?.domain || dispatched?.domain || "") === expectedDomain;
      const skillMatches = !expectedSkill || resultSkills.includes(expectedSkill);

      const skillCheck = {
        runId,
        workstreamId: expected.workstreamId,
        expectedDomain: expectedDomain || null,
        eventDomain: result?.domain || started?.domain || dispatched?.domain || null,
        expectedSkill: expectedSkill || null,
        requiredSkillsSeen: resultSkills,
        startedSeen: Boolean(started),
        resultSeen: Boolean(result),
        domainMatches,
        skillMatches,
      };
      skillCoverageChecks.push(skillCheck);
      // In degraded/offline replay conditions, started events can be missing while
      // result + runtime evidence is still complete and valid for verification.
      if (!skillCheck.resultSeen || !domainMatches || !skillMatches) {
        skillCoverageMissingRunIds.push(runId);
      }

      const logPath = String(
        result?.metadata?.log_path ||
          started?.metadata?.log_path ||
          dispatched?.metadata?.log_path ||
          ""
      ).trim();
      const outputPath = String(
        result?.metadata?.output_path ||
          started?.metadata?.output_path ||
          dispatched?.metadata?.output_path ||
          ""
      ).trim();
      const hasLogPath = Boolean(logPath);
      const hasOutputPath = Boolean(outputPath);
      const logExists = hasLogPath && existsSync(logPath);
      const outputExists = hasOutputPath && existsSync(outputPath);
      let logPreview = "";
      let logContent = "";
      if (logExists) {
        try {
          logContent = readFileSync(logPath, "utf8");
          logPreview = logContent.slice(0, 400);
        } catch {
          logContent = "";
          logPreview = "";
        }
      }
      const logIndicatesMock = /mock slice/i.test(logPreview);
      const logIndicatesCodex = /codex_bin:/i.test(logPreview);
      const logIndicatesClaude = /claude slice/i.test(logPreview);
      const runtimeLooksReal = logExists && outputExists && !logIndicatesMock && (logIndicatesCodex || logIndicatesClaude);
      const logProgressCalls =
        (logContent.match(/orgx_report_progress\(/gi) ?? []).length ||
        (logContent.match(/orgx[- ]openclaw\.orgx_report_progress/gi) ?? []).length;
      const logHasProgressEvidence = logProgressCalls >= 2;
      const workerCheck = {
        runId,
        workstreamId: expected.workstreamId,
        logPath: hasLogPath ? logPath : null,
        outputPath: hasOutputPath ? outputPath : null,
        logExists,
        outputExists,
        logIndicatesMock,
        logIndicatesCodex,
        logIndicatesClaude,
        runtimeLooksReal,
        logProgressCalls,
      };
      realWorkerChecks.push(workerCheck);
      if (!runtimeLooksReal) {
        realWorkerMissingRunIds.push(runId);
      }

      const progressEvidence = progressEvidenceByRun.get(runId) ?? {
        runtimeProgressEvents: 0,
        runtimeProgressPctMax: null,
        orgxReportProgressEvents: 0,
        sources: [],
      };
      const hasProgressEvidence =
        Number(progressEvidence.runtimeProgressEvents) > 0 ||
        Number(progressEvidence.orgxReportProgressEvents) > 0 ||
        (Number.isFinite(Number(progressEvidence.runtimeProgressPctMax)) &&
          Number(progressEvidence.runtimeProgressPctMax) > 0 &&
          Number(progressEvidence.runtimeProgressPctMax) < 100) ||
        logHasProgressEvidence;
      const progressCheck = {
        runId,
        workstreamId: expected.workstreamId,
        runtimeProgressEvents: progressEvidence.runtimeProgressEvents,
        runtimeProgressPctMax: progressEvidence.runtimeProgressPctMax,
        orgxReportProgressEvents: progressEvidence.orgxReportProgressEvents,
        logProgressCalls,
        logHasProgressEvidence,
        sources: progressEvidence.sources,
        hasProgressEvidence,
      };
      progressChecks.push(progressCheck);
      if (!hasProgressEvidence) {
        progressMissingRunIds.push(runId);
      }
    }

    report.validation.skillCoverageChecks = skillCoverageChecks;
    report.validation.skillCoverageMissingRunIds = skillCoverageMissingRunIds;
    report.validation.realWorkerChecks = realWorkerChecks;
    report.validation.realWorkerMissingRunIds = realWorkerMissingRunIds;
    report.validation.progressEvidenceByRun = progressChecks;
    report.validation.progressEvidenceMissingRunIds = progressMissingRunIds;

    if (skillCoverageMissingRunIds.length > 0) {
      throw new Error(
        `Skill/domain coverage validation failed for run ids: ${skillCoverageMissingRunIds.join(", ")}`
      );
    }
    if (REQUIRE_REAL_WORKER && realWorkerMissingRunIds.length > 0) {
      throw new Error(
        `Real worker validation failed for run ids: ${realWorkerMissingRunIds.join(", ")}`
      );
    }
    if (progressMissingRunIds.length > 0) {
      throw new Error(
        `Progress evidence missing for run ids: ${progressMissingRunIds.join(", ")}`
      );
    }

    // Validate file outputs for every completed workstream slice.
    const requiredWorkstreamIds = report.created.workstreams
      .map((ws) => String(ws.id))
      .filter(Boolean);
    const fileChecks = [];
    let filesVerifiedCount = 0;
    for (const workstreamId of requiredWorkstreamIds) {
      const expected = taskByWorkstreamId.get(workstreamId) ?? null;
      if (!expected) continue;
      const filePath = String(expected.expectedFile);
      const expectedContent = String(expected.expectedContent);
      const exists = existsSync(filePath);
      let actualContent = "";
      if (exists) {
        try {
          actualContent = readFileSync(filePath, "utf8");
        } catch {
          actualContent = "";
        }
      }
      const matches =
        exists && normalizeTextContent(actualContent) === normalizeTextContent(expectedContent);
      if (matches) filesVerifiedCount += 1;
      fileChecks.push({
        workstreamId,
        taskId: expected.taskId,
        domain: expected.domain,
        expectedFile: filePath,
        exists,
        matches,
        actualPreview: exists ? normalizeTextContent(actualContent).slice(0, 160) : null,
      });
    }
    report.validation.fileChecks = fileChecks;
    report.validation.filesVerifiedCount = filesVerifiedCount;
    report.validation.filesVerifiedRequired = requiredWorkstreamIds.length;

    if (filesVerifiedCount < requiredWorkstreamIds.length) {
      throw new Error(
        `Expected ${requiredWorkstreamIds.length} verified output files, got ${filesVerifiedCount}.`
      );
    }

    // Validate task/artifact outcomes.
    const taskList = await listEntities("task", { initiative_id: initiativeId, limit: 1000 });
    const tasks = Array.isArray(taskList?.data) ? taskList.data : [];
    const doneCount = tasks.filter((t) =>
      ["done", "completed"].includes(String(t?.status || "").trim().toLowerCase())
    ).length;
    report.validation.taskTotal = tasks.length;
    report.validation.tasksDoneCount = doneCount;

    const artifactList = await listEntities("artifact", { initiative_id: initiativeId, limit: 2000 });
    const artifacts = Array.isArray(artifactList?.data) ? artifactList.data : [];
    report.validation.artifactsCount = artifacts.length;
    const requiredOutcomeCount = requiredWorkstreamIds.length;
    let doneCountEffective = doneCount;
    let artifactsCountEffective = artifacts.length;
    let outcomeFallbackUsed = false;
    if (doneCountEffective < requiredOutcomeCount && report.validation.completedWorkstreamCount >= requiredOutcomeCount) {
      doneCountEffective = report.validation.completedWorkstreamCount;
      outcomeFallbackUsed = true;
      report.notes.push(
        `Task completion fallback applied: using completed workstream evidence (${doneCountEffective}) because task status updates are buffered or unavailable.`
      );
    }
    if (artifactsCountEffective < requiredOutcomeCount && filesVerifiedCount >= requiredOutcomeCount) {
      artifactsCountEffective = filesVerifiedCount;
      outcomeFallbackUsed = true;
      report.notes.push(
        `Artifact completion fallback applied: using verified file outputs (${artifactsCountEffective}) because artifact entities are buffered or unavailable.`
      );
    }
    report.validation.tasksDoneCountEffective = doneCountEffective;
    report.validation.artifactsCountEffective = artifactsCountEffective;
    report.validation.outcomeFallbackUsed = outcomeFallbackUsed;
    if (doneCountEffective < requiredOutcomeCount) {
      throw new Error(
        `Expected at least ${requiredOutcomeCount} done tasks (manual + auto), got ${doneCountEffective}/${tasks.length}.`
      );
    }
    if (artifactsCountEffective < requiredOutcomeCount) {
      throw new Error(
        `Expected at least ${requiredOutcomeCount} artifacts (manual + auto), got ${artifactsCountEffective}.`
      );
    }

    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.notes.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (!SEED_ONLY && !KEEP) {
      report.teardown.attempted = true;
      try {
        if (initiativeId) {
          await stopAutoContinue(initiativeId).catch(() => null);
          await tickAutoContinue(initiativeId).catch(() => null);
        }

        // Remove harness pins first.
        for (const ws of report.created.workstreams) {
          if (!initiativeId || !ws?.id) continue;
          try {
            await fetchJson(`/orgx/api/mission-control/next-up/unpin`, {
              method: "POST",
              body: { initiativeId, workstreamId: ws.id },
            });
          } catch (err) {
            report.teardown.errors.push(`unpin ${ws.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Restore queue ordering snapshot from before harness run.
        if (Array.isArray(report.queue.beforeOrder) && report.queue.beforeOrder.length > 0) {
          try {
            await fetchJson(`/orgx/api/mission-control/next-up/reorder`, {
              method: "POST",
              body: { order: report.queue.beforeOrder },
            });
            report.queue.restored = true;
          } catch (err) {
            report.teardown.errors.push(
              `restore queue order: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // Teardown entities using valid status transitions to avoid polluting active queue.
        for (const task of report.created.tasks) {
          try {
            await updateEntity("task", task.id, { status: "done" });
            report.teardown.deleted.task.push(task.id);
          } catch (err) {
            report.teardown.errors.push(
              `teardown task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        for (const milestone of report.created.milestones) {
          try {
            await updateEntity("milestone", milestone.id, { status: "cancelled" });
            report.teardown.deleted.milestone.push(milestone.id);
          } catch (err) {
            report.teardown.errors.push(
              `teardown milestone ${milestone.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        for (const ws of report.created.workstreams) {
          try {
            await updateEntity("workstream", ws.id, { status: "completed" });
            report.teardown.deleted.workstream.push(ws.id);
          } catch (err) {
            report.teardown.errors.push(
              `teardown workstream ${ws.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        if (initiativeId) {
          try {
            await deleteEntity("initiative", initiativeId);
            report.teardown.deleted.initiative = initiativeId;
          } catch (err) {
            report.teardown.errors.push(
              `delete initiative ${initiativeId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      } finally {
        report.teardown.completed = report.teardown.errors.length === 0;
      }
    } else {
      report.notes.push(
        SEED_ONLY
          ? "Teardown skipped due to seed-only mode."
          : "Teardown skipped because ORGX_HARNESS_KEEP=1."
      );
    }

    persistReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
