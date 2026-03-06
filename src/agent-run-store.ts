import {
  existsSync,
  readFileSync,
} from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync } from "./fs-utils.js";
import {
  clearStoreFileSync,
  ensureStoreDirSync,
  parseJsonSafe,
} from "./stores/json-store.js";
import {
  getStateDb,
  readStateMeta,
  writeStateMeta,
} from "./stores/sqlite-state.js";

export type AgentRunStatus = "running" | "stopped";

export type AgentRunRecord = {
  runId: string;
  agentId: string;
  pid: number | null;
  message: string | null;
  provider: string | null;
  model: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  status: AgentRunStatus;
};

type PersistedAgentRuns = {
  updatedAt: string;
  runs: Record<string, AgentRunRecord>;
};

type AgentRunRow = {
  run_id: string;
  agent_id: string;
  pid: number | null;
  message: string | null;
  provider: string | null;
  model: string | null;
  initiative_id: string | null;
  initiative_title: string | null;
  workstream_id: string | null;
  task_id: string | null;
  started_at: string;
  stopped_at: string | null;
  status: string;
  updated_at: string;
};

const MAX_RUNS = 240;
const AGENT_RUN_IMPORT_META_KEY = "agent_runs_imported_v1";

function runDir(): string {
  return getOrgxPluginConfigDir();
}

function runFile(): string {
  return getOrgxPluginConfigPath("agent-runs.json");
}

function ensureRunDir(): void {
  ensureStoreDirSync(runDir());
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : fallback;
}

function normalizeNullableTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function normalizeRecord(input: AgentRunRecord): AgentRunRecord {
  const now = new Date().toISOString();
  return {
    runId: input.runId.trim(),
    agentId: input.agentId.trim(),
    pid: typeof input.pid === "number" && Number.isFinite(input.pid) ? input.pid : null,
    message: normalizeNullableString(input.message),
    provider: normalizeNullableString(input.provider),
    model: normalizeNullableString(input.model),
    initiativeId: normalizeNullableString(input.initiativeId),
    initiativeTitle: normalizeNullableString(input.initiativeTitle),
    workstreamId: normalizeNullableString(input.workstreamId),
    taskId: normalizeNullableString(input.taskId),
    startedAt: normalizeTimestamp(input.startedAt, now),
    stoppedAt: normalizeNullableTimestamp(input.stoppedAt),
    status: input.status === "stopped" ? "stopped" : "running",
  };
}

function legacyReadAgentRuns(): PersistedAgentRuns {
  const file = runFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), runs: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedAgentRuns>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { updatedAt: new Date().toISOString(), runs: {} };
    }
    const runs = parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {};
    const normalizedRuns: Record<string, AgentRunRecord> = {};
    for (const [runKey, runValue] of Object.entries(runs)) {
      if (!runValue || typeof runValue !== "object") continue;
      const input = runValue as Partial<AgentRunRecord>;
      const normalized = normalizeRecord({
        runId: typeof input.runId === "string" ? input.runId : runKey,
        agentId: typeof input.agentId === "string" ? input.agentId : "",
        pid: typeof input.pid === "number" ? input.pid : null,
        message: typeof input.message === "string" ? input.message : null,
        provider: typeof input.provider === "string" ? input.provider : null,
        model: typeof input.model === "string" ? input.model : null,
        initiativeId: typeof input.initiativeId === "string" ? input.initiativeId : null,
        initiativeTitle:
          typeof input.initiativeTitle === "string" ? input.initiativeTitle : null,
        workstreamId: typeof input.workstreamId === "string" ? input.workstreamId : null,
        taskId: typeof input.taskId === "string" ? input.taskId : null,
        startedAt: typeof input.startedAt === "string" ? input.startedAt : "",
        stoppedAt: typeof input.stoppedAt === "string" ? input.stoppedAt : null,
        status: input.status === "stopped" ? "stopped" : "running",
      });
      if (!normalized.runId || !normalized.agentId) continue;
      normalizedRuns[normalized.runId] = normalized;
    }
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      runs: normalizedRuns,
    };
  } catch {
    return { updatedAt: new Date().toISOString(), runs: {} };
  }
}

function rowToRecord(row: AgentRunRow): AgentRunRecord {
  return normalizeRecord({
    runId: row.run_id,
    agentId: row.agent_id,
    pid: typeof row.pid === "number" ? row.pid : null,
    message: row.message,
    provider: row.provider,
    model: row.model,
    initiativeId: row.initiative_id,
    initiativeTitle: row.initiative_title,
    workstreamId: row.workstream_id,
    taskId: row.task_id,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    status: row.status === "stopped" ? "stopped" : "running",
  });
}

function writeAgentRunRecord(record: AgentRunRecord): void {
  const normalized = normalizeRecord(record);
  getStateDb()
    .prepare<
      [
        string,
        string,
        number | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string,
        string
      ]
    >(
      `INSERT INTO agent_runs (
         run_id,
         agent_id,
         pid,
         message,
         provider,
         model,
         initiative_id,
         initiative_title,
         workstream_id,
         task_id,
         started_at,
         stopped_at,
         status,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         pid = excluded.pid,
         message = excluded.message,
         provider = excluded.provider,
         model = excluded.model,
         initiative_id = excluded.initiative_id,
         initiative_title = excluded.initiative_title,
         workstream_id = excluded.workstream_id,
         task_id = excluded.task_id,
         started_at = excluded.started_at,
         stopped_at = excluded.stopped_at,
         status = excluded.status,
         updated_at = excluded.updated_at`
    )
    .run(
      normalized.runId,
      normalized.agentId,
      normalized.pid,
      normalized.message,
      normalized.provider,
      normalized.model,
      normalized.initiativeId,
      normalized.initiativeTitle,
      normalized.workstreamId,
      normalized.taskId,
      normalized.startedAt,
      normalized.stoppedAt,
      normalized.status,
      new Date().toISOString()
    );
}

function pruneAgentRuns(): void {
  getStateDb()
    .prepare<[number]>(
      `DELETE FROM agent_runs
       WHERE run_id NOT IN (
         SELECT run_id
         FROM agent_runs
         ORDER BY started_at DESC, updated_at DESC
         LIMIT ?
       )`
    )
    .run(MAX_RUNS);
}

function ensureAgentRunStoreMigrated(): void {
  const migrated = readStateMeta<boolean>(AGENT_RUN_IMPORT_META_KEY);
  if (migrated) return;

  const countRow = getStateDb()
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM agent_runs")
    .get();
  if ((countRow?.count ?? 0) > 0) {
    writeStateMeta(AGENT_RUN_IMPORT_META_KEY, true);
    return;
  }

  const legacy = legacyReadAgentRuns();
  const records = Object.values(legacy.runs)
    .map((record) => normalizeRecord(record))
    .filter((record) => Boolean(record.runId) && Boolean(record.agentId));
  const transaction = getStateDb().transaction((items: AgentRunRecord[]) => {
    for (const item of items) {
      writeAgentRunRecord(item);
    }
    pruneAgentRuns();
    writeStateMeta(AGENT_RUN_IMPORT_META_KEY, true);
  });
  transaction(records);
}

function readAgentRunRows(limit = MAX_RUNS): AgentRunRow[] {
  ensureAgentRunStoreMigrated();
  return getStateDb()
    .prepare<[number], AgentRunRow>(
      `SELECT
         run_id,
         agent_id,
         pid,
         message,
         provider,
         model,
         initiative_id,
         initiative_title,
         workstream_id,
         task_id,
         started_at,
         stopped_at,
         status,
         updated_at
       FROM agent_runs
       ORDER BY started_at DESC, updated_at DESC
       LIMIT ?`
    )
    .all(Math.max(1, limit));
}

export function readAgentRuns(): PersistedAgentRuns {
  const rows = readAgentRunRows();
  const runs: Record<string, AgentRunRecord> = {};
  let updatedAt = new Date(0).toISOString();
  for (const row of rows) {
    const record = rowToRecord(row);
    runs[record.runId] = record;
    if (Date.parse(row.updated_at) > Date.parse(updatedAt)) {
      updatedAt = row.updated_at;
    }
  }
  return {
    updatedAt: rows.length > 0 ? updatedAt : new Date().toISOString(),
    runs,
  };
}

export function getAgentRun(runId: string): AgentRunRecord | null {
  const id = runId.trim();
  if (!id) return null;
  ensureAgentRunStoreMigrated();
  const row = getStateDb()
    .prepare<[string], AgentRunRow>(
      `SELECT
         run_id,
         agent_id,
         pid,
         message,
         provider,
         model,
         initiative_id,
         initiative_title,
         workstream_id,
         task_id,
         started_at,
         stopped_at,
         status,
         updated_at
       FROM agent_runs
       WHERE run_id = ?`
    )
    .get(id);
  return row ? rowToRecord(row) : null;
}

export function upsertAgentRun(input: Omit<AgentRunRecord, "startedAt" | "stoppedAt" | "status"> & {
  startedAt?: string;
  stoppedAt?: string | null;
  status?: AgentRunStatus;
}): PersistedAgentRuns {
  const runId = input.runId.trim();
  const agentId = input.agentId.trim();
  if (!runId || !agentId) {
    return readAgentRuns();
  }

  ensureRunDir();
  ensureAgentRunStoreMigrated();
  const existing = getAgentRun(runId);
  const startedAt =
    typeof input.startedAt === "string" && input.startedAt.trim().length > 0
      ? input.startedAt
      : existing?.startedAt ?? new Date().toISOString();

  const record = normalizeRecord({
    runId,
    agentId,
    pid: input.pid ?? null,
    message: input.message ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    initiativeId: input.initiativeId ?? null,
    initiativeTitle: input.initiativeTitle ?? null,
    workstreamId: input.workstreamId ?? null,
    taskId: input.taskId ?? null,
    startedAt,
    stoppedAt: input.stoppedAt ?? existing?.stoppedAt ?? null,
    status: input.status ?? existing?.status ?? "running",
  });

  const transaction = getStateDb().transaction((item: AgentRunRecord) => {
    writeAgentRunRecord(item);
    pruneAgentRuns();
  });
  transaction(record);
  return readAgentRuns();
}

export function markAgentRunStopped(runId: string): AgentRunRecord | null {
  const id = runId.trim();
  if (!id) return null;
  const existing = getAgentRun(id);
  if (!existing) return null;

  const next = upsertAgentRun({
    ...existing,
    runId: id,
    agentId: existing.agentId,
    pid: existing.pid ?? null,
    message: existing.message ?? null,
    provider: existing.provider ?? null,
    model: existing.model ?? null,
    initiativeId: existing.initiativeId ?? null,
    initiativeTitle: existing.initiativeTitle ?? null,
    workstreamId: existing.workstreamId ?? null,
    taskId: existing.taskId ?? null,
    stoppedAt: new Date().toISOString(),
    status: "stopped",
  });

  const updated = next.runs[id];
  return updated ? normalizeRecord(updated) : null;
}

export function clearAgentRuns(): void {
  getStateDb().prepare("DELETE FROM agent_runs").run();
  clearStoreFileSync(runFile());
}
