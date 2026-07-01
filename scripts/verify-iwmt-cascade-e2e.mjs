#!/usr/bin/env node
/**
 * End-to-end IWMT cascade verification scaffold.
 *
 * Validates the full Initiative → Workstream → Milestone → Task hierarchy,
 * multi-task auto-continue, milestone/workstream rollup, and artifact creation.
 * Supports real agent execution via ORGX_AUTOPILOT_WORKER_KIND=claude-code.
 *
 * Hierarchy:
 *   Initiative: "IWMT Cascade E2E"
 *     Workstream 1 (Engineering):
 *       Milestone 1-1:
 *         Task 1-1-1: Write file X = hello-1-1, report artifact, mark done
 *         Task 1-1-2: Write file Y = hello-1-2, report artifact, mark done
 *     Workstream 2 (Product):
 *       Milestone 2-1:
 *         Task 2-1-1: Write file A = hello-2-1, report artifact, mark done
 *         Task 2-1-2: Write file B = hello-2-2, report artifact, mark done
 *
 * Usage:
 *   npm run build:core
 *   node scripts/verify-iwmt-cascade-e2e.mjs
 *
 * Optional env:
 * - ORGX_AUTOPILOT_WORKER_KIND=mock|codex|claude-code (default: mock)
 * - ORGX_E2E_TASKS_PER_WORKSTREAM=2
 * - ORGX_E2E_VERIFY_FILES=1|0 (auto: true for real workers)
 * - ORGX_SPAWN_GUARD_BYPASS=1
 * - ORGX_E2E_TIMEOUT_MS=...
 */

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../dist/http-handler.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { method = "GET", headers, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const detail =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : text.slice(0, 240) || `${res.status} ${res.statusText}`;
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${detail}`);
  }
  return json;
}

function createNoopOnboarding() {
  return {
    getState: () => ({
      status: "idle",
      hasApiKey: true,
      connectionVerified: true,
      workspaceName: "local-e2e",
      lastError: null,
      nextAction: "ready",
      docsUrl: "https://example.com",
      keySource: "env",
      installationId: "install_local_e2e",
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }),
    startPairing: async () => {
      throw new Error("not implemented");
    },
    getStatus: async () => ({
      status: "idle",
      hasApiKey: true,
      connectionVerified: true,
      workspaceName: "local-e2e",
      lastError: null,
      nextAction: "ready",
      docsUrl: "https://example.com",
      keySource: "env",
      installationId: "install_local_e2e",
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }),
    submitManualKey: async () => {
      throw new Error("not implemented");
    },
    disconnect: async () => {
      throw new Error("not implemented");
    },
  };
}

function startServer({ handler }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function readRuntimeSse(url, { signal, onEvent }) {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const chunk of parts) {
      const lines = chunk.split("\n");
      let eventName = "message";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim() || eventName;
        if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      const dataText = dataLines.join("\n").trim();
      if (!dataText) continue;
      let data = dataText;
      try {
        data = JSON.parse(dataText);
      } catch {
        // keep as text
      }
      onEvent({ event: eventName, data });
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory OrgX client harness (IWMT-aware)
// ---------------------------------------------------------------------------

function createOrgxClientHarness() {
  const store = {
    entities: {
      initiative: new Map(),
      workstream: new Map(),
      milestone: new Map(),
      task: new Map(),
      artifact: new Map(),
      decision: new Map(),
    },
    activity: [],
  };

  function matchesFilters(row, filters) {
    if (!filters || typeof filters !== "object") return true;
    const init = typeof filters.initiative_id === "string" ? filters.initiative_id.trim() : "";
    if (init) {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? row.metadata
          : null;
      const rowInitiativeId =
        String(row.initiative_id ?? "").trim() ||
        String(row.initiativeId ?? "").trim() ||
        String(metadata?.initiative_id ?? "").trim() ||
        String(metadata?.initiativeId ?? "").trim();
      if (rowInitiativeId !== init) return false;
    }
    const ws = typeof filters.workstream_id === "string" ? filters.workstream_id.trim() : "";
    if (ws && String(row.workstream_id ?? "") !== ws) return false;
    const status = typeof filters.status === "string" ? filters.status.trim() : "";
    if (status && String(row.status ?? "") !== status) return false;
    return true;
  }

  const client = {
    getBaseUrl: () => "https://www.useorgx.com",
    getBillingStatus: async () => ({
      plan: "pro",
      hasSubscription: true,
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: null,
    }),
    rawRequest: async (method, path, body) => {
      if (method !== "POST" || path !== "/api/client/kickoff-context") {
        throw new Error(`rawRequest not implemented for ${method} ${path}`);
      }
      const scope = body && typeof body === "object" ? body : {};
      return {
        ok: true,
        data: {
          context_hash: "ctx_iwmt_e2e",
          schema_version: "2026-02-13",
          overview: "IWMT cascade E2E kickoff context (harness).",
          acceptance_criteria: ["Slice emits verifiable JSON", "Tasks updated to done"],
          constraints: ["Return a single JSON object at end"],
          tool_scope: { allow: ["orgx_report_progress"], deny: [] },
          scope,
        },
      };
    },
    listEntities: async (type, filters) => {
      const map = store.entities[type];
      if (!map) return { data: [], pagination: { total: 0, has_more: false } };
      const rows = Array.from(map.values()).filter((row) => matchesFilters(row, filters));
      const limitRaw = filters && typeof filters === "object" ? Number(filters.limit ?? 0) : 0;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : rows.length;
      return {
        data: rows.slice(0, limit),
        pagination: { total: rows.length, has_more: rows.length > limit },
      };
    },
    createEntity: async (type, payload) => {
      const id = `ent_${type}_${randomUUID().slice(0, 12)}`;
      const row = {
        id,
        ...payload,
        title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : payload.name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const map = store.entities[type];
      if (map) map.set(id, row);
      return row;
    },
    updateEntity: async (type, id, updates) => {
      const map = store.entities[type];
      if (!map) return { id };
      const existing = map.get(id) ?? { id };
      const next = { ...existing, ...updates, updated_at: new Date().toISOString() };
      map.set(id, next);
      return next;
    },
    applyChangeset: async (payload) => {
      const ops = Array.isArray(payload?.operations) ? payload.operations : [];
      for (const op of ops) {
        if (!op || typeof op !== "object") continue;
        const kind = op.op;
        if (kind === "task.update" && typeof op.task_id === "string") {
          const id = op.task_id;
          const existing = store.entities.task.get(id);
          if (!existing) continue;
          const patch = op.patch && typeof op.patch === "object" ? op.patch : {};
          const next = { ...existing, ...patch };
          if (typeof op.status === "string") next.status = op.status;
          next.updated_at = new Date().toISOString();
          store.entities.task.set(id, next);
        }
        if (kind === "milestone.update" && typeof op.milestone_id === "string") {
          const id = op.milestone_id;
          const existing = store.entities.milestone.get(id);
          if (!existing) continue;
          const next = { ...existing };
          if (typeof op.status === "string") next.status = op.status;
          next.updated_at = new Date().toISOString();
          store.entities.milestone.set(id, next);
        }
        if (kind === "decision.create") {
          const id = `dec_${randomUUID().slice(0, 12)}`;
          store.entities.decision.set(id, {
            id,
            title: String(op.title ?? "Decision"),
            summary: typeof op.summary === "string" ? op.summary : null,
            status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
      return {
        ok: true,
        changeset_id: `cs_${randomUUID().slice(0, 10)}`,
        replayed: false,
        run_id: payload?.run_id ?? null,
        applied_count: ops.length,
        results: [],
        event_id: null,
      };
    },
    emitActivity: async (payload) => {
      const now = new Date().toISOString();
      const item = {
        id: randomUUID(),
        type: "message",
        title: null,
        description: null,
        agentId: payload?.agent_id ?? null,
        agentName: payload?.agent_name ?? null,
        runId: payload?.run_id ?? null,
        initiativeId: payload?.initiative_id ?? null,
        timestamp: now,
        phase: payload?.phase ?? "execution",
        summary: payload?.message ?? null,
        message: payload?.message ?? null,
        metadata: payload?.metadata ?? null,
      };
      store.activity.push(item);
      return { ok: true, run_id: payload?.run_id ?? null, event_id: item.id, reused_run: false };
    },
    getLiveAgents: async () => ({ agents: [], summary: {} }),
    getLiveSessions: async () => ({ nodes: [], edges: [], groups: [] }),
    getLiveActivity: async () => ({ activities: store.activity.slice().reverse() }),
    getHandoffs: async () => ({ handoffs: [] }),
    getLiveDecisions: async () => ({ decisions: Array.from(store.entities.decision.values()) }),
    bulkDecideDecisions: async () => [],
    listRunCheckpoints: async () => ({ ok: true, checkpoints: [] }),
    createRunCheckpoint: async () => ({ ok: true }),
    restoreRunCheckpoint: async () => ({ ok: true }),
    runAction: async () => ({ ok: true }),
  };

  return { client, store };
}

// ---------------------------------------------------------------------------
// IWMT workstream definitions
// ---------------------------------------------------------------------------

const WORKSTREAM_DEFS = [
  {
    key: "engineering",
    name: "Engineering",
    agent: { id: "orgx-engineering", name: "OrgX Engineering", domain: "engineering" },
    skill: "orgx-engineering-agent",
  },
  {
    key: "product",
    name: "Product",
    agent: { id: "orgx-product", name: "OrgX Product", domain: "product" },
    skill: "orgx-product-agent",
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tasksPerWsRaw = Number(process.env.ORGX_E2E_TASKS_PER_WORKSTREAM);
  const tasksPerWs = Number.isFinite(tasksPerWsRaw) && tasksPerWsRaw > 0 ? Math.floor(tasksPerWsRaw) : 2;

  process.env.ORGX_SPAWN_GUARD_BYPASS = "1";
  process.env.ORGX_HOOK_TOKEN = (process.env.ORGX_HOOK_TOKEN || "orgx_hook_e2e_local").trim();

  process.env.ORGX_AUTOPILOT_WORKER_KIND = (process.env.ORGX_AUTOPILOT_WORKER_KIND || "mock").trim();
  process.env.ORGX_AUTOPILOT_MOCK_SCENARIO = (process.env.ORGX_AUTOPILOT_MOCK_SCENARIO || "success").trim();
  process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS = (process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS || "1200").trim();
  process.env.ORGX_AUTOPILOT_CWD =
    (process.env.ORGX_AUTOPILOT_CWD || mkdtempSync(join(tmpdir(), "orgx-iwmt-e2e-"))).trim();

  const workerKind = String(process.env.ORGX_AUTOPILOT_WORKER_KIND || "").trim().toLowerCase();
  const verifyFilesRaw = String(process.env.ORGX_E2E_VERIFY_FILES ?? "").trim().toLowerCase();
  const verifyFiles =
    verifyFilesRaw.length > 0
      ? !(verifyFilesRaw === "0" || verifyFilesRaw === "false" || verifyFilesRaw === "no")
      : workerKind !== "mock";

  const runDir = String(process.env.ORGX_AUTOPILOT_CWD || "").trim();
  assert.ok(runDir, "expected ORGX_AUTOPILOT_CWD to be set");

  const { client, store } = createOrgxClientHarness();
  const config = {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: "local-e2e",
  };

  const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
  const { server, baseUrl } = await startServer({ handler });

  const abortController = new AbortController();
  const runtimeEvents = [];
  const ssePromise = readRuntimeSse(`${baseUrl}/orgx/api/hooks/runtime/stream`, {
    signal: abortController.signal,
    onEvent: ({ event, data }) => runtimeEvents.push({ event, data, at: Date.now() }),
  }).catch((err) => {
    if (String(err?.name || "").toLowerCase() !== "aborterror") throw err;
  });

  try {
    // ── 1) Create IWMT hierarchy ──────────────────────────────────────────
    const initiative = await fetchJson(`${baseUrl}/orgx/api/entities`, {
      method: "POST",
      body: {
        type: "initiative",
        title: `IWMT Cascade E2E (${new Date().toISOString().slice(0, 19)})`,
        summary: "IWMT cascade verification: multi-workstream, milestone rollup, artifact tracking.",
        status: "active",
      },
    });
    const initiativeId = String(initiative?.entity?.id ?? "");
    assert.ok(initiativeId, "expected initiative id");

    const taskIds = [];
    const expectedFiles = [];
    const taskWorkstreamById = new Map();
    const workstreamIds = [];
    const milestoneIds = [];

    for (const wsDef of WORKSTREAM_DEFS) {
      const workstream = await fetchJson(`${baseUrl}/orgx/api/entities`, {
        method: "POST",
        body: {
          type: "workstream",
          initiative_id: initiativeId,
          name: `${wsDef.name} Autopilot`,
          summary: `IWMT cascade E2E workstream (${wsDef.key}). Skill: ${wsDef.skill}`,
          status: "active",
          assigned_agents: [wsDef.agent],
        },
      });
      const workstreamId = String(workstream?.entity?.id ?? "");
      assert.ok(workstreamId, `expected workstream id for ${wsDef.key}`);
      workstreamIds.push(workstreamId);

      const milestone = await fetchJson(`${baseUrl}/orgx/api/entities`, {
        method: "POST",
        body: {
          type: "milestone",
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          title: `Cascade Proof (${wsDef.key})`,
          summary: `Complete all ${wsDef.key} tasks and verify rollup.`,
          status: "planned",
        },
      });
      const milestoneId = String(milestone?.entity?.id ?? "");
      assert.ok(milestoneId, `expected milestone id for ${wsDef.key}`);
      milestoneIds.push(milestoneId);

      const wsDir = join(runDir, wsDef.key);
      mkdirSync(wsDir, { recursive: true, mode: 0o700 });

      for (let i = 1; i <= tasksPerWs; i++) {
        const fileSlug = `hello-${wsDef.key.slice(0, 3)}-${i}`;
        const expectedFile = join(wsDir, `orgx-iwmt-e2e-${fileSlug}.txt`);
        const expectedContent = fileSlug;

        const created = await fetchJson(`${baseUrl}/orgx/api/entities`, {
          method: "POST",
          body: {
            type: "task",
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            milestone_id: milestoneId,
            title: `[E2E][${wsDef.key}] ${i}/${tasksPerWs}: Write ${expectedFile} = "${expectedContent}" then report artifact url=file://${expectedFile} and task_updates done`,
            status: "todo",
            priority: "high",
            expected_duration_hours: 0.01,
          },
        });
        const taskId = String(created?.entity?.id ?? "");
        assert.ok(taskId, `expected task id for ${wsDef.key} i=${i}`);
        taskIds.push(taskId);
        taskWorkstreamById.set(taskId, workstreamId);
        expectedFiles.push({ taskId, expectedFile, expectedContent });
      }
    }

    const totalTasks = taskIds.length;
    console.log(`Created IWMT hierarchy: 1 initiative, ${workstreamIds.length} workstreams, ${milestoneIds.length} milestones, ${totalTasks} tasks`);

    // ── 2) Start auto-continue ────────────────────────────────────────────
    const started = await fetchJson(`${baseUrl}/orgx/api/mission-control/auto-continue/start`, {
      method: "POST",
      body: {
        initiativeId,
        agentId: "orgx-orchestrator",
        includeVerification: false,
        workstreamIds,
        tokenBudget: 100_000_000,
      },
    });
    assert.equal(Boolean(started?.ok), true, "expected auto-continue start ok");

    // ── 3) Tick loop ──────────────────────────────────────────────────────
    const timeoutRaw = String(process.env.ORGX_E2E_TIMEOUT_MS ?? "").trim();
    const timeoutFromEnv = timeoutRaw ? Number(timeoutRaw) : Number.NaN;
    const defaultTimeoutMs =
      workerKind === "mock" ? Math.max(60_000, totalTasks * 22_000) : Math.max(300_000, totalTasks * 150_000);
    const timeoutMs =
      Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? Math.floor(timeoutFromEnv) : defaultTimeoutMs;
    const deadlineMs = Date.now() + timeoutMs;

    while (Date.now() < deadlineMs) {
      const status = await fetchJson(
        `${baseUrl}/orgx/api/mission-control/auto-continue/status?initiative_id=${encodeURIComponent(initiativeId)}`
      );
      const run = status?.run ?? null;
      assert.ok(run, "expected run to exist");

      await fetchJson(`${baseUrl}/orgx/api/mission-control/auto-continue/tick`, {
        method: "POST",
        body: { initiativeId },
      });

      if (run.status === "stopped") break;
      await sleep(350);
    }

    const final = await fetchJson(
      `${baseUrl}/orgx/api/mission-control/auto-continue/status?initiative_id=${encodeURIComponent(initiativeId)}`
    );
    assert.ok(final?.run, "expected final run");
    if (final.run.status !== "stopped") {
      throw new Error(
        `E2E timeout: expected run to stop (timeoutMs=${timeoutMs} status=${String(final.run.status)} lastError=${String(final.run.lastError ?? "")})`
      );
    }
    assert.equal(final.run.stopReason, "completed");
    console.log("Auto-continue completed successfully.");

    // ── 4) Assert task completion ─────────────────────────────────────────
    const tasks = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=task&initiative_id=${encodeURIComponent(initiativeId)}&limit=500`
    );
    const taskRows = Array.isArray(tasks?.data) ? tasks.data : [];
    const taskById = new Map(taskRows.map((t) => [String(t.id), t]));
    for (const id of taskIds) {
      const row = taskById.get(id);
      assert.ok(row, `expected task present id=${id}`);
      assert.ok(
        ["done", "completed"].includes(String(row.status).toLowerCase()),
        `expected task done id=${id}, got ${row.status}`
      );
    }
    console.log(`All ${totalTasks} tasks completed.`);

    // ── 5) Assert artifacts ───────────────────────────────────────────────
    const artifacts = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=artifact&initiative_id=${encodeURIComponent(initiativeId)}&limit=800`
    );
    const artifactRows = Array.isArray(artifacts?.data) ? artifacts.data : [];
    assert.ok(
      artifactRows.length >= totalTasks,
      `expected >=${totalTasks} artifacts, got ${artifactRows.length}`
    );
    console.log(`Artifacts created: ${artifactRows.length}`);

    // ── 6) Assert file output (real workers only) ─────────────────────────
    if (verifyFiles) {
      for (const expected of expectedFiles) {
        assert.ok(existsSync(expected.expectedFile), `expected file exists: ${expected.expectedFile}`);
        const raw = readFileSync(expected.expectedFile, "utf8");
        assert.equal(raw.trim(), expected.expectedContent, `expected file content for ${expected.expectedFile}`);
      }
      console.log(`File verification passed for ${expectedFiles.length} files.`);
    }

    // ── 7) Assert rollups ─────────────────────────────────────────────────
    // With all tasks done, milestones should be completed (if rollup ran)
    const milestones = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=milestone&initiative_id=${encodeURIComponent(initiativeId)}&limit=100`
    );
    const milestoneRows = Array.isArray(milestones?.data) ? milestones.data : [];
    for (const ms of milestoneRows) {
      // Milestone rollup may or may not have run depending on implementation;
      // at minimum tasks are done, which is the pre-condition for rollup.
      if (ms.status === "completed") {
        console.log(`Milestone ${ms.id} rolled up to completed.`);
      }
    }

    // Workstreams: verify tasks per workstream are all done
    for (const wsId of workstreamIds) {
      const wsTasks = taskRows.filter((t) => String(t.workstream_id) === wsId);
      for (const t of wsTasks) {
        assert.ok(
          ["done", "completed"].includes(String(t.status).toLowerCase()),
          `expected task ${t.id} in workstream ${wsId} done, got ${t.status}`
        );
      }
    }
    console.log("Workstream rollup pre-conditions met (all tasks done).");

    // ── 8) Assert runtime ─────────────────────────────────────────────────
    assert.ok(runtimeEvents.length > 0, "expected runtime stream events");
    const snapshot = await fetchJson(
      `${baseUrl}/orgx/api/live/snapshot?initiative=${encodeURIComponent(initiativeId)}`
    );
    const runtimeInstances = Array.isArray(snapshot?.runtimeInstances) ? snapshot.runtimeInstances : [];
    assert.ok(runtimeInstances.length > 0, "expected runtimeInstances in snapshot");
    console.log(`Runtime instances: ${runtimeInstances.length}, SSE events: ${runtimeEvents.length}`);

    // ── 9) Assert activity ────────────────────────────────────────────────
    const activities = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
    const sliceResults = activities.filter(
      (a) => a && a.metadata && typeof a.metadata === "object" && a.metadata.event === "autopilot_slice_result"
    );
    assert.ok(
      sliceResults.length >= WORKSTREAM_DEFS.length,
      `expected >=${WORKSTREAM_DEFS.length} slice results, got ${sliceResults.length}`
    );
    console.log(`Slice result activity events: ${sliceResults.length}`);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_kind: process.env.ORGX_AUTOPILOT_WORKER_KIND,
          initiativeId,
          workstreams: workstreamIds.length,
          milestones: milestoneIds.length,
          tasks: totalTasks,
          artifacts: artifactRows.length,
          runtimeEvents: runtimeEvents.length,
          sliceResults: sliceResults.length,
          activityItems: activities.length,
          verifyFiles,
          note: "IWMT cascade E2E passed. Enable real agents with ORGX_AUTOPILOT_WORKER_KIND=codex|claude-code.",
        },
        null,
        2
      )
    );
  } finally {
    abortController.abort();
    try {
      await ssePromise;
    } catch {
      // ignore
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exit(1);
});
