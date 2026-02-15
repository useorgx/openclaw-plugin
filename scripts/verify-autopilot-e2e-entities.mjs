#!/usr/bin/env node
/**
 * Local, end-to-end autopilot verification scaffold (multi-domain entities).
 *
 * Focus: "invoked with entities, it does the entity work and records updates as it goes"
 * across multiple workstreams/domains. Uses the real HTTP handler + auto-continue loop
 * against an in-memory OrgX client harness.
 *
 * Defaults to a deterministic mock worker, but can run real Codex/Claude slice workers
 * (hello-worldy: write files with exact expected content).
 *
 * Usage:
 *   npm run build:core
 *   node scripts/verify-autopilot-e2e-entities.mjs
 *
 * Optional env:
 * - ORGX_AUTOPILOT_WORKER_KIND=mock|codex|claude-code
 * - ORGX_AUTOPILOT_EXECUTOR=codex|claude-code (affects source_client attribution)
 * - ORGX_E2E_DOMAINS=engineering,product,design,marketing,operations,sales
 * - ORGX_E2E_TASKS_PER_DOMAIN=1
 * - ORGX_E2E_INJECT_PROGRESS=1|0
 * - ORGX_E2E_VERIFY_FILES=1|0 (defaults to workerKind !== mock)
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

function resolveExecutorSourceClient() {
  const raw = String(process.env.ORGX_AUTOPILOT_EXECUTOR || "").trim().toLowerCase();
  if (raw === "claude-code" || raw === "claude_code" || raw === "claude") return "claude-code";
  return "codex";
}

function titleCaseFromSlug(value) {
  const parts = String(value || "")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return String(value || "");
  return parts
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function resolveOrgxAgentForDomain(domain) {
  const normalized = String(domain || "").trim().toLowerCase();
  if (!normalized) return { id: "orgx", name: "OrgX" };
  const slug = normalized === "orchestration" ? "orchestrator" : normalized;
  if (slug === "orgx") return { id: "orgx", name: "OrgX" };
  if (slug.startsWith("orgx-")) return { id: slug, name: `OrgX ${titleCaseFromSlug(slug.slice(5))}` };
  return { id: `orgx-${slug}`, name: `OrgX ${titleCaseFromSlug(slug)}` };
}

const ORGX_SKILL_BY_DOMAIN = {
  engineering: "orgx-engineering-agent",
  product: "orgx-product-agent",
  marketing: "orgx-marketing-agent",
  sales: "orgx-sales-agent",
  operations: "orgx-operations-agent",
  design: "orgx-design-agent",
  orchestration: "orgx-orchestrator-agent",
};

function parseDomains(raw) {
  const cleaned = String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["engineering", "product", "design", "marketing", "operations", "sales"];
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

async function main() {
  const domains = parseDomains(process.env.ORGX_E2E_DOMAINS);
  const tasksPerDomainRaw = Number(process.env.ORGX_E2E_TASKS_PER_DOMAIN);
  const tasksPerDomain =
    Number.isFinite(tasksPerDomainRaw) && tasksPerDomainRaw > 0 ? Math.floor(tasksPerDomainRaw) : 1;

  // Avoid spawn guard gating in local harness runs.
  process.env.ORGX_SPAWN_GUARD_BYPASS = "1";
  process.env.ORGX_HOOK_TOKEN = (process.env.ORGX_HOOK_TOKEN || "orgx_hook_e2e_local").trim();

  process.env.ORGX_AUTOPILOT_WORKER_KIND = (process.env.ORGX_AUTOPILOT_WORKER_KIND || "mock").trim();
  process.env.ORGX_AUTOPILOT_MOCK_SCENARIO = (process.env.ORGX_AUTOPILOT_MOCK_SCENARIO || "success").trim();
  process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS = (process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS || "1200").trim();
  process.env.ORGX_AUTOPILOT_CWD =
    (process.env.ORGX_AUTOPILOT_CWD || mkdtempSync(join(tmpdir(), "orgx-autopilot-e2e-"))).trim();

  const workerKind = String(process.env.ORGX_AUTOPILOT_WORKER_KIND || "").trim().toLowerCase();
  const verifyFilesRaw = String(process.env.ORGX_E2E_VERIFY_FILES ?? "").trim().toLowerCase();
  const verifyFiles =
    verifyFilesRaw.length > 0
      ? !(verifyFilesRaw === "0" || verifyFilesRaw === "false" || verifyFilesRaw === "no")
      : workerKind !== "mock";

  const injectProgressRaw = String(process.env.ORGX_E2E_INJECT_PROGRESS ?? "").trim().toLowerCase();
  const injectProgress =
    injectProgressRaw.length > 0
      ? !(injectProgressRaw === "0" || injectProgressRaw === "false" || injectProgressRaw === "no")
      : true;

  const runDir = String(process.env.ORGX_AUTOPILOT_CWD || "").trim();
  assert.ok(runDir, "expected ORGX_AUTOPILOT_CWD to be set");

  const { client } = createOrgxClientHarness();
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
    // 1) Create minimal graph: initiative -> workstreams(domains) -> milestones -> tasks.
    const initiative = await fetchJson(`${baseUrl}/orgx/api/entities`, {
      method: "POST",
      body: {
        type: "initiative",
        title: `Local Autopilot Entity E2E (${new Date().toISOString().slice(0, 19)})`,
        summary: "Local autopilot multi-domain verification scaffold run.",
        status: "active",
      },
    });
    const initiativeId = String(initiative?.entity?.id ?? "");
    assert.ok(initiativeId, "expected initiative id");

    const taskIds = [];
    const expectedFiles = [];
    const taskDomainById = new Map();
    const taskWorkstreamById = new Map();
    const workstreamIds = [];

    for (const domain of domains) {
      const agent = resolveOrgxAgentForDomain(domain);
      const skill = ORGX_SKILL_BY_DOMAIN[domain] ?? ORGX_SKILL_BY_DOMAIN.engineering;

      const workstream = await fetchJson(`${baseUrl}/orgx/api/entities`, {
        method: "POST",
        body: {
          type: "workstream",
          initiative_id: initiativeId,
          name: `${domain[0]?.toUpperCase() ?? ""}${domain.slice(1)} Autopilot`,
          summary: `E2E verification workstream (${domain}). Required skill: ${skill}`,
          status: "active",
          assigned_agents: [{ id: agent.id, name: agent.name, domain }],
        },
      });
      const workstreamId = String(workstream?.entity?.id ?? "");
      assert.ok(workstreamId, `expected workstream id for domain=${domain}`);
      workstreamIds.push(workstreamId);

      const milestone = await fetchJson(`${baseUrl}/orgx/api/entities`, {
        method: "POST",
        body: {
          type: "milestone",
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          title: `Autopilot Proof (${domain})`,
          summary: `Complete tasks via slices and record verifiable outcomes (${domain}).`,
          status: "planned",
        },
      });
      const milestoneId = String(milestone?.entity?.id ?? "");
      assert.ok(milestoneId, `expected milestone id for domain=${domain}`);

      const domainDir = join(runDir, domain);
      mkdirSync(domainDir, { recursive: true, mode: 0o700 });

      for (let i = 1; i <= tasksPerDomain; i += 1) {
        const expectedFile = join(domainDir, `orgx-autopilot-e2e-${domain}-hello-${String(i).padStart(2, "0")}.txt`);
        const expectedContent = `${domain}-hello-${i}`;
        const created = await fetchJson(`${baseUrl}/orgx/api/entities`, {
          method: "POST",
          body: {
            type: "task",
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            milestone_id: milestoneId,
            title: `[E2E][${domain}] ${i}/${tasksPerDomain}: Write ${expectedFile} = "${expectedContent}" then report artifact url=file://${expectedFile} and task_updates done`,
            status: "todo",
            priority: "high",
            expected_duration_hours: 0.01,
          },
        });
        const id = String(created?.entity?.id ?? "");
        assert.ok(id, `expected task id for domain=${domain} i=${i}`);
        taskIds.push(id);
        taskDomainById.set(id, domain);
        taskWorkstreamById.set(id, workstreamId);
        expectedFiles.push({ taskId: id, expectedFile, expectedContent });
      }
    }

    // 2) Start auto-continue loop for the created workstreams.
    const started = await fetchJson(`${baseUrl}/orgx/api/mission-control/auto-continue/start`, {
      method: "POST",
      body: {
        initiativeId,
        agentId: "orgx-orchestrator",
        includeVerification: false,
        workstreamIds,
        // Modeled tokens are an internal guardrail; keep this very high so multi-domain
        // verification doesn't stop early due to budget modeling drift.
        tokenBudget: 100_000_000,
      },
    });
    assert.equal(Boolean(started?.ok), true, "expected auto-continue start ok");

    // 3) Tick until completed; optionally inject progress for each slice run.
    const posted38ForRun = new Set();
    const posted55ForRun = new Set();
    const timeoutRaw = String(process.env.ORGX_E2E_TIMEOUT_MS ?? "").trim();
    const timeoutFromEnv = timeoutRaw ? Number(timeoutRaw) : Number.NaN;
    const tasksTotal = domains.length * tasksPerDomain;
    const defaultTimeoutMs =
      workerKind === "mock" ? Math.max(60_000, tasksTotal * 22_000) : Math.max(300_000, tasksTotal * 150_000);
    const timeoutMs =
      Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? Math.floor(timeoutFromEnv) : defaultTimeoutMs;
    const deadlineMs = Date.now() + timeoutMs;

    while (Date.now() < deadlineMs) {
      const status = await fetchJson(
        `${baseUrl}/orgx/api/mission-control/auto-continue/status?initiative_id=${encodeURIComponent(initiativeId)}`
      );
      const run = status?.run ?? null;
      assert.ok(run, "expected run to exist");

      if (injectProgress && run.activeRunId && run.activeTaskId) {
        const runId = String(run.activeRunId);
        const taskId = String(run.activeTaskId);
        const domain = taskDomainById.get(taskId) ?? "engineering";
        const activeWorkstreamId = taskWorkstreamById.get(taskId) ?? null;
        const agent = resolveOrgxAgentForDomain(domain);
        const sourceClient = resolveExecutorSourceClient();

        if (!posted38ForRun.has(runId)) {
          await fetchJson(`${baseUrl}/orgx/api/hooks/runtime`, {
            method: "POST",
            headers: { "x-orgx-hook-token": process.env.ORGX_HOOK_TOKEN },
            body: {
              source_client: sourceClient,
              event: "progress",
              run_id: runId,
              initiative_id: initiativeId,
              workstream_id: activeWorkstreamId,
              task_id: taskId,
              agent_id: agent.id,
              agent_name: agent.name,
              phase: "execution",
              progress_pct: 38,
              message: `E2E injected progress (${domain}) (38%)`,
            },
          });
          posted38ForRun.add(runId);
        }

        if (!posted55ForRun.has(runId)) {
          await sleep(150);
          await fetchJson(`${baseUrl}/orgx/api/hooks/runtime`, {
            method: "POST",
            headers: { "x-orgx-hook-token": process.env.ORGX_HOOK_TOKEN },
            body: {
              source_client: sourceClient,
              event: "progress",
              run_id: runId,
              initiative_id: initiativeId,
              workstream_id: activeWorkstreamId,
              task_id: taskId,
              agent_id: agent.id,
              agent_name: agent.name,
              phase: "execution",
              progress_pct: 55,
              message: `E2E injected progress (${domain}) (55%)`,
            },
          });
          posted55ForRun.add(runId);
        }
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
    if (final.run.status !== "stopped") {
      throw new Error(
        `E2E timeout: expected run to stop (timeoutMs=${timeoutMs} status=${String(final.run.status)} activeRunId=${String(
          final.run.activeRunId ?? ""
        )} lastError=${String(final.run.lastError ?? "")})`
      );
    }
    assert.equal(final.run.stopReason, "completed");

    // 4) Verify tasks are done.
    const tasks = await fetchJson(
      `${baseUrl}/orgx/api/entities?type=task&initiative_id=${encodeURIComponent(initiativeId)}&limit=500`
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
      `${baseUrl}/orgx/api/entities?type=artifact&initiative_id=${encodeURIComponent(initiativeId)}&limit=800`
    );
    const artifactRows = Array.isArray(artifacts?.data) ? artifacts.data : [];
    assert.ok(artifactRows.length >= taskIds.length, `expected >=${taskIds.length} artifacts, got ${artifactRows.length}`);

    // 5b) Verify deliverables exist on disk for real workers.
    if (verifyFiles) {
      for (const expected of expectedFiles) {
        assert.ok(existsSync(expected.expectedFile), `expected file exists: ${expected.expectedFile}`);
        const raw = readFileSync(expected.expectedFile, "utf8");
        assert.equal(raw.trim(), expected.expectedContent, `expected file content for ${expected.expectedFile}`);
      }
    }

    // 6) Verify runtime + snapshot include updates.
    assert.ok(runtimeEvents.length > 0, "expected runtime stream events");
    const snapshot = await fetchJson(`${baseUrl}/orgx/api/live/snapshot?initiative=${encodeURIComponent(initiativeId)}`);
    const runtimeInstances = Array.isArray(snapshot?.runtimeInstances) ? snapshot.runtimeInstances : [];
    assert.ok(runtimeInstances.length > 0, "expected runtimeInstances in snapshot");
    if (injectProgress) {
      assert.ok(runtimeInstances.some((r) => Number(r.progressPct) === 55), "expected a 55% progress instance");
    }

    // 7) Verify slice results include domain + required skill mapping.
    const activities = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
    const sliceResults = activities.filter(
      (a) => a && a.metadata && typeof a.metadata === "object" && a.metadata.event === "autopilot_slice_result"
    );
    assert.ok(sliceResults.length >= domains.length, `expected >=${domains.length} slice results, got ${sliceResults.length}`);

    for (const domain of domains) {
      const required = ORGX_SKILL_BY_DOMAIN[domain] ?? ORGX_SKILL_BY_DOMAIN.engineering;
      const expectedAgentId = resolveOrgxAgentForDomain(domain).id;
      const found = sliceResults.find((item) => {
        const md = item?.metadata ?? {};
        const mdDomain = typeof md.domain === "string" ? md.domain : null;
        const mdSkills = Array.isArray(md.required_skills) ? md.required_skills.map(String) : [];
        const mdAgentId = typeof md.agent_id === "string" ? md.agent_id : null;
        return mdDomain === domain && mdAgentId === expectedAgentId && mdSkills.includes(required);
      });
      assert.ok(found, `expected sliceResult for domain=${domain} agent=${expectedAgentId} skill=${required}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_kind: process.env.ORGX_AUTOPILOT_WORKER_KIND,
          executor: resolveExecutorSourceClient(),
          initiativeId,
          domains,
          workstreams: workstreamIds.length,
          tasks: taskIds.length,
          artifacts: artifactRows.length,
          runtimeEvents: runtimeEvents.length,
          activityItems: activities.length,
          note: "Local harness run. Enable real agents with ORGX_AUTOPILOT_WORKER_KIND=codex|claude-code and configure binaries/args.",
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
