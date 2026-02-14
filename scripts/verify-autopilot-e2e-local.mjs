#!/usr/bin/env node
/**
 * Local, end-to-end autopilot verification scaffold.
 *
 * Goal: verify "work actually completed" (tasks -> done, artifacts registered, runtime + activity
 * events emitted) by exercising the real HTTP handler + auto-continue loop against an in-memory
 * OrgX client harness and a real worker process (mock by default).
 *
 * This is not a unit test. It runs a local server, drives HTTP endpoints, and asserts outcomes.
 *
 * Usage:
 *   npm run build:core
 *   ORGX_AUTOPILOT_WORKER_KIND=mock node scripts/verify-autopilot-e2e-local.mjs
 *
 * Optional env:
 * - ORGX_AUTOPILOT_WORKER_KIND=mock|codex|claude-code
 * - ORGX_AUTOPILOT_MOCK_SLEEP_MS=1200
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=success
 * - ORGX_E2E_TASKS=3
 */

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler } from "../dist/http-handler.js";

const TASKS = Number.isFinite(Number(process.env.ORGX_E2E_TASKS))
  ? Math.max(1, Math.floor(Number(process.env.ORGX_E2E_TASKS)))
  : 3;

// Avoid spawn guard gating in local harness runs.
process.env.ORGX_SPAWN_GUARD_BYPASS = "1";

// Ensure the runtime hook token is stable and known to this script.
process.env.ORGX_HOOK_TOKEN = (process.env.ORGX_HOOK_TOKEN || "orgx_hook_e2e_local").trim();

// Default to mock slice worker for deterministic completion.
process.env.ORGX_AUTOPILOT_WORKER_KIND = (process.env.ORGX_AUTOPILOT_WORKER_KIND || "mock").trim();
process.env.ORGX_AUTOPILOT_MOCK_SCENARIO = (process.env.ORGX_AUTOPILOT_MOCK_SCENARIO || "success").trim();
process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS = (process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS || "1200").trim();
process.env.ORGX_AUTOPILOT_CWD =
  (process.env.ORGX_AUTOPILOT_CWD || mkdtempSync(join(tmpdir(), "orgx-autopilot-e2e-"))).trim();

function resolveExecutorSourceClient() {
  const raw = String(process.env.ORGX_AUTOPILOT_EXECUTOR || "").trim().toLowerCase();
  if (raw === "claude-code" || raw === "claude_code" || raw === "claude") return "claude-code";
  return "codex";
}

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
      json && typeof json === "object" && json && "error" in json && typeof json.error === "string"
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

  function normalizeTitle(type, payload) {
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (title) return title;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name) return name;
    return `${type} ${String(payload.id ?? "").slice(0, 8)}`;
  }

  function matchesFilters(row, filters) {
    if (!filters || typeof filters !== "object") return true;
    const init = typeof filters.initiative_id === "string" ? filters.initiative_id.trim() : "";
    if (init && String(row.initiative_id ?? "") !== init) return false;
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
          context_hash: "ctx_local_e2e",
          schema_version: "2026-02-13",
          overview: "Local E2E kickoff context (harness).",
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
        title: normalizeTitle(type, payload),
        name: typeof payload?.name === "string" ? payload.name : undefined,
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

async function startServer({ handler }) {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handler(req, res);
      if (!handled && !res.writableEnded) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not handled");
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err?.stack || err));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1");
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr !== "object" || !addr.port) throw new Error("failed to bind server");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

async function readRuntimeSse(url, { signal, onEvent }) {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) throw new Error(`SSE failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("SSE body missing");

  const decoder = new TextDecoder();
  let buffer = "";

  // Node fetch gives a web ReadableStream.
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let eventName = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || eventName;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
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

async function main() {
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
    onEvent: ({ event, data }) => {
      runtimeEvents.push({ event, data, at: Date.now() });
    },
  }).catch((err) => {
    // If the server is closing, this is expected.
    if (String(err?.name || "").toLowerCase() !== "aborterror") {
      throw err;
    }
  });

  try {
    // 1) Create minimal Mission Control graph: initiative -> workstream -> milestone -> tasks.
    const initiative = await fetchJson(`${baseUrl}/orgx/api/entities`, {
      method: "POST",
      body: {
        type: "initiative",
        title: `Local Autopilot E2E (${new Date().toISOString().slice(0, 19)})`,
        summary: "Local autopilot verification scaffold run.",
        status: "active",
      },
    });
    const initiativeId = String(initiative?.entity?.id ?? "");
    assert.ok(initiativeId, "expected initiative id");

    const workstream = await fetchJson(`${baseUrl}/orgx/api/entities`, {
      method: "POST",
      body: {
        type: "workstream",
        initiative_id: initiativeId,
        name: "Engineering Autopilot",
        summary: "E2E verification workstream",
        status: "active",
        assigned_agents: [{ id: "orgx-engineering-agent", name: "OrgX Engineering", domain: "engineering" }],
      },
    });
    const workstreamId = String(workstream?.entity?.id ?? "");
    assert.ok(workstreamId, "expected workstream id");

    const milestone = await fetchJson(`${baseUrl}/orgx/api/entities`, {
      method: "POST",
      body: {
        type: "milestone",
        initiative_id: initiativeId,
        workstream_id: workstreamId,
        title: "Autopilot Proof",
        summary: "Complete tasks via slices and record verifiable outcomes.",
        status: "planned",
      },
    });
    const milestoneId = String(milestone?.entity?.id ?? "");
    assert.ok(milestoneId, "expected milestone id");

    const taskIds = [];
    for (let i = 1; i <= TASKS; i += 1) {
      const created = await fetchJson(`${baseUrl}/orgx/api/entities`, {
        method: "POST",
        body: {
          type: "task",
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          milestone_id: milestoneId,
          title: `[E2E] Task ${i}: produce a verifiable artifact + mark done`,
          status: "todo",
          priority: "high",
          // Keep modeled token estimates small so the verification focuses on completion semantics.
          expected_duration_hours: 0.05,
        },
      });
      const id = String(created?.entity?.id ?? "");
      assert.ok(id, `expected task id for task ${i}`);
      taskIds.push(id);
    }

    // 2) Start auto-continue loop for just this workstream.
    const started = await fetchJson(`${baseUrl}/orgx/api/mission-control/auto-continue/start`, {
      method: "POST",
      body: {
        initiativeId,
        agentId: "orgx-engineering-agent",
        includeVerification: false,
        workstreamIds: [workstreamId],
        tokenBudget: 1_000_000,
      },
    });
    assert.equal(Boolean(started?.ok), true, "expected auto-continue start ok");

    // 3) Tick until completed; inject progress updates for each slice run.
    const postedProgressForRun = new Set();
    const deadlineMs = Date.now() + Math.max(45_000, TASKS * 18_000);

    while (Date.now() < deadlineMs) {
      const status = await fetchJson(
        `${baseUrl}/orgx/api/mission-control/auto-continue/status?initiative_id=${encodeURIComponent(
          initiativeId
        )}`
      );
      const run = status?.run ?? null;
      assert.ok(run, "expected run to exist");

      if (run.activeRunId && run.activeTaskId && !postedProgressForRun.has(run.activeRunId)) {
        postedProgressForRun.add(run.activeRunId);

        const sourceClient = resolveExecutorSourceClient();
        await fetchJson(`${baseUrl}/orgx/api/hooks/runtime`, {
          method: "POST",
          headers: { "x-orgx-hook-token": process.env.ORGX_HOOK_TOKEN },
          body: {
            source_client: sourceClient,
            event: "progress",
            run_id: run.activeRunId,
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            task_id: run.activeTaskId,
            agent_id: "orgx-engineering-agent",
            agent_name: "OrgX Engineering",
            phase: "execution",
            progress_pct: 38,
            message: "E2E injected progress (38%)",
          },
        });
        await sleep(250);
        await fetchJson(`${baseUrl}/orgx/api/hooks/runtime`, {
          method: "POST",
          headers: { "x-orgx-hook-token": process.env.ORGX_HOOK_TOKEN },
          body: {
            source_client: sourceClient,
            event: "progress",
            run_id: run.activeRunId,
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            task_id: run.activeTaskId,
            agent_id: "orgx-engineering-agent",
            agent_name: "OrgX Engineering",
            phase: "execution",
            progress_pct: 55,
            message: "E2E injected progress (55%)",
          },
        });
      }

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
    assert.equal(final.run.status, "stopped");
    assert.equal(final.run.stopReason, "completed");

    // 4) Verify tasks are done.
    const tasks = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=task&initiative_id=${encodeURIComponent(initiativeId)}&limit=200`
    );
    const taskRows = Array.isArray(tasks?.data) ? tasks.data : [];
    const taskById = new Map(taskRows.map((t) => [String(t.id), t]));
    for (const id of taskIds) {
      const row = taskById.get(id);
      assert.ok(row, `expected task present id=${id}`);
      assert.ok(["done", "completed"].includes(String(row.status).toLowerCase()), `expected task done id=${id}`);
    }

    // 5) Verify artifacts were created.
    const artifacts = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=artifact&initiative_id=${encodeURIComponent(initiativeId)}&limit=200`
    );
    const artifactRows = Array.isArray(artifacts?.data) ? artifacts.data : [];
    assert.ok(artifactRows.length >= TASKS, `expected >=${TASKS} artifacts, got ${artifactRows.length}`);

    // 6) Verify runtime stream saw updates and snapshot contains progress.
    const sawSessionStart = runtimeEvents.some((e) => e.event === "runtime.updated");
    assert.ok(sawSessionStart, "expected runtime stream events");

    const snapshot = await fetchJson(`${baseUrl}/orgx/api/live/snapshot?initiative=${encodeURIComponent(initiativeId)}`);
    const runtimeInstances = Array.isArray(snapshot?.runtimeInstances) ? snapshot.runtimeInstances : [];
    assert.ok(runtimeInstances.length > 0, "expected runtimeInstances in snapshot");
    assert.ok(runtimeInstances.some((r) => Number(r.progressPct) === 55), "expected a 55% progress instance");
    assert.ok(
      runtimeInstances.some((r) => String(r.sourceClient ?? "").toLowerCase() === resolveExecutorSourceClient()),
      `expected at least one runtime instance for executor=${resolveExecutorSourceClient()}`
    );

    // 7) Verify activity contains autopilot slice results.
    const activities = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
    const sliceResults = activities.filter(
      (a) => a && a.metadata && typeof a.metadata === "object" && a.metadata.event === "autopilot_slice_result"
    );
    assert.ok(sliceResults.length >= TASKS, `expected >=${TASKS} slice results, got ${sliceResults.length}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_kind: process.env.ORGX_AUTOPILOT_WORKER_KIND,
          executor: resolveExecutorSourceClient(),
          initiativeId,
          workstreamId,
          milestoneId,
          tasks: TASKS,
          artifacts: artifactRows.length,
          runtimeEvents: runtimeEvents.length,
          activityItems: activities.length,
          note: "This is a local harness run; real agents can be verified by setting ORGX_AUTOPILOT_WORKER_KIND=codex|claude-code and configuring their binaries/args.",
        },
        null,
        2
      )
    );

    // Keep lint-ish tools happy: assert the harness store isn't empty.
    assert.ok(store.entities.task.size >= TASKS);
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
