import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

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

export type RuntimeSourceClient =
  | "openclaw"
  | "codex"
  | "claude-code"
  | "api"
  | "unknown";

export type RuntimeInstanceState = "active" | "stale" | "stopped" | "error";

export type RuntimeHookEvent =
  | "session_start"
  | "heartbeat"
  | "progress"
  | "task_update"
  | "session_stop"
  | "error";

export type RuntimeHookPayload = {
  source_client?: string | null;
  event?: string | null;
  run_id?: string | null;
  correlation_id?: string | null;
  initiative_id?: string | null;
  workstream_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  phase?: string | null;
  progress_pct?: number | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  timestamp?: string | null;
};

export type RuntimeInstanceRecord = {
  id: string;
  sourceClient: RuntimeSourceClient;
  displayName: string;
  providerLogo: "codex" | "openai" | "anthropic" | "openclaw" | "orgx" | "unknown";
  state: RuntimeInstanceState;
  event: RuntimeHookEvent;
  runId: string | null;
  correlationId: string | null;
  initiativeId: string | null;
  workstreamId: string | null;
  taskId: string | null;
  agentId: string | null;
  agentName: string | null;
  phase: string | null;
  progressPct: number | null;
  currentTask: string | null;
  lastHeartbeatAt: string | null;
  lastEventAt: string;
  lastMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type PersistedRuntimeInstances = {
  updatedAt: string;
  instances: Record<string, RuntimeInstanceRecord>;
};

type RuntimeInstanceRow = {
  id: string;
  source_client: string;
  display_name: string;
  provider_logo: string;
  state: string;
  event: string;
  run_id: string | null;
  correlation_id: string | null;
  initiative_id: string | null;
  workstream_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  phase: string | null;
  progress_pct: number | null;
  current_task: string | null;
  last_heartbeat_at: string | null;
  last_event_at: string;
  last_message: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_INSTANCES = 600;
export const DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS = 90_000;
const RUNTIME_IMPORT_META_KEY = "runtime_instances_imported_v1";

function runtimeDir(): string {
  return getOrgxPluginConfigDir();
}

function runtimeFile(): string {
  return getOrgxPluginConfigPath("runtime-instances.json");
}

function hookTokenFile(): string {
  return getOrgxPluginConfigPath("runtime-hook-token.txt");
}

function ensureRuntimeDir(): void {
  ensureStoreDirSync(runtimeDir());
}

function writeHookTokenFile(token: string): void {
  ensureRuntimeDir();
  writeFileSync(hookTokenFile(), `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeSourceClient(value: unknown): RuntimeSourceClient {
  const normalized = normalizeNullableString(value)?.toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "codex") return "codex";
  if (normalized === "claude-code") return "claude-code";
  if (normalized === "api") return "api";
  return "unknown";
}

function normalizeHookEvent(value: unknown): RuntimeHookEvent {
  const normalized = normalizeNullableString(value)?.toLowerCase();
  if (normalized === "session_start") return "session_start";
  if (normalized === "heartbeat") return "heartbeat";
  if (normalized === "progress") return "progress";
  if (normalized === "task_update") return "task_update";
  if (normalized === "session_stop") return "session_stop";
  if (normalized === "error") return "error";
  return "heartbeat";
}

function toProviderLogo(
  sourceClient: RuntimeSourceClient
): RuntimeInstanceRecord["providerLogo"] {
  if (sourceClient === "codex") return "openai";
  if (sourceClient === "claude-code") return "anthropic";
  if (sourceClient === "openclaw") return "openclaw";
  if (sourceClient === "api") return "orgx";
  return "unknown";
}

function normalizeProviderLogo(
  value: unknown,
  sourceClient: RuntimeSourceClient
): RuntimeInstanceRecord["providerLogo"] {
  const normalized = normalizeNullableString(value)?.toLowerCase();
  if (normalized === "codex") return sourceClient === "codex" ? "openai" : "codex";
  if (normalized === "openai") return "openai";
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "orgx") return "orgx";
  if (normalized === "unknown") return "unknown";
  return toProviderLogo(sourceClient);
}

function toDisplayName(sourceClient: RuntimeSourceClient): string {
  if (sourceClient === "codex") return "Codex";
  if (sourceClient === "claude-code") return "Claude Code";
  if (sourceClient === "openclaw") return "OpenClaw";
  if (sourceClient === "api") return "OrgX API";
  return "Runtime";
}

function normalizeState(value: unknown): RuntimeInstanceState {
  const normalized = normalizeNullableString(value)?.toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "stale") return "stale";
  if (normalized === "stopped") return "stopped";
  if (normalized === "error") return "error";
  return "active";
}

function normalizeIsoTimestamp(value: unknown, fallbackIso: string): string {
  const text = normalizeNullableString(value);
  if (!text) return fallbackIso;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallbackIso;
  return new Date(parsed).toISOString();
}

function sanitizeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:_-]+/g, "-");
}

function deriveInstanceId(input: {
  sourceClient: RuntimeSourceClient;
  runId: string | null;
  correlationId: string | null;
  agentId: string | null;
  initiativeId: string | null;
}): string {
  const source = sanitizeIdPart(input.sourceClient);
  const runId = normalizeNullableString(input.runId);
  if (runId) return `runtime:${source}:run:${sanitizeIdPart(runId)}`;
  const correlationId = normalizeNullableString(input.correlationId);
  if (correlationId) return `runtime:${source}:corr:${sanitizeIdPart(correlationId)}`;
  const agentId = normalizeNullableString(input.agentId);
  const initiativeId = normalizeNullableString(input.initiativeId);
  if (agentId && initiativeId) {
    return `runtime:${source}:agent:${sanitizeIdPart(agentId)}:initiative:${sanitizeIdPart(
      initiativeId
    )}`;
  }
  if (agentId) return `runtime:${source}:agent:${sanitizeIdPart(agentId)}`;
  return `runtime:${source}:default`;
}

function normalizeProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeRecord(input: RuntimeInstanceRecord): RuntimeInstanceRecord {
  const sourceClient = normalizeSourceClient(input.sourceClient);
  return {
    id: normalizeNullableString(input.id) ?? input.id,
    sourceClient,
    displayName: normalizeNullableString(input.displayName) ?? "Runtime",
    providerLogo: normalizeProviderLogo(input.providerLogo, sourceClient),
    state: normalizeState(input.state),
    event: normalizeHookEvent(input.event),
    runId: normalizeNullableString(input.runId),
    correlationId: normalizeNullableString(input.correlationId),
    initiativeId: normalizeNullableString(input.initiativeId),
    workstreamId: normalizeNullableString(input.workstreamId),
    taskId: normalizeNullableString(input.taskId),
    agentId: normalizeNullableString(input.agentId),
    agentName: normalizeNullableString(input.agentName),
    phase: normalizeNullableString(input.phase),
    progressPct: normalizeProgress(input.progressPct),
    currentTask: normalizeNullableString(input.currentTask),
    lastHeartbeatAt: normalizeNullableString(input.lastHeartbeatAt),
    lastEventAt: input.lastEventAt,
    lastMessage: normalizeNullableString(input.lastMessage),
    metadata: normalizeObject(input.metadata),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function legacyReadRuntimeInstances(): PersistedRuntimeInstances {
  const file = runtimeFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), instances: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedRuntimeInstances>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { updatedAt: new Date().toISOString(), instances: {} };
    }
    const instances =
      parsed.instances && typeof parsed.instances === "object"
        ? parsed.instances
        : {};
    return {
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      instances: instances as Record<string, RuntimeInstanceRecord>,
    };
  } catch {
    return { updatedAt: new Date().toISOString(), instances: {} };
  }
}

function rowToRecord(row: RuntimeInstanceRow): RuntimeInstanceRecord {
  return normalizeRecord({
    id: row.id,
    sourceClient: normalizeSourceClient(row.source_client),
    displayName: row.display_name,
    providerLogo: normalizeProviderLogo(row.provider_logo, normalizeSourceClient(row.source_client)),
    state: normalizeState(row.state),
    event: normalizeHookEvent(row.event),
    runId: row.run_id,
    correlationId: row.correlation_id,
    initiativeId: row.initiative_id,
    workstreamId: row.workstream_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    phase: row.phase,
    progressPct: typeof row.progress_pct === "number" ? row.progress_pct : null,
    currentTask: row.current_task,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastEventAt: row.last_event_at,
    lastMessage: row.last_message,
    metadata:
      typeof row.metadata_json === "string"
        ? normalizeObject(parseJsonSafe<Record<string, unknown>>(row.metadata_json))
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function writeRuntimeRecord(record: RuntimeInstanceRecord): void {
  const normalized = normalizeRecord(record);
  getStateDb()
    .prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string
      ]
    >(
      `INSERT INTO runtime_instances (
         id,
         source_client,
         display_name,
         provider_logo,
         state,
         event,
         run_id,
         correlation_id,
         initiative_id,
         workstream_id,
         task_id,
         agent_id,
         agent_name,
         phase,
         progress_pct,
         current_task,
         last_heartbeat_at,
         last_event_at,
         last_message,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_client = excluded.source_client,
         display_name = excluded.display_name,
         provider_logo = excluded.provider_logo,
         state = excluded.state,
         event = excluded.event,
         run_id = excluded.run_id,
         correlation_id = excluded.correlation_id,
         initiative_id = excluded.initiative_id,
         workstream_id = excluded.workstream_id,
         task_id = excluded.task_id,
         agent_id = excluded.agent_id,
         agent_name = excluded.agent_name,
         phase = excluded.phase,
         progress_pct = excluded.progress_pct,
         current_task = excluded.current_task,
         last_heartbeat_at = excluded.last_heartbeat_at,
         last_event_at = excluded.last_event_at,
         last_message = excluded.last_message,
         metadata_json = excluded.metadata_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`
    )
    .run(
      normalized.id,
      normalized.sourceClient,
      normalized.displayName,
      normalized.providerLogo,
      normalized.state,
      normalized.event,
      normalized.runId,
      normalized.correlationId,
      normalized.initiativeId,
      normalized.workstreamId,
      normalized.taskId,
      normalized.agentId,
      normalized.agentName,
      normalized.phase,
      normalized.progressPct,
      normalized.currentTask,
      normalized.lastHeartbeatAt,
      normalized.lastEventAt,
      normalized.lastMessage,
      normalized.metadata ? JSON.stringify(normalized.metadata) : null,
      normalized.createdAt,
      normalized.updatedAt
    );
}

function pruneRuntimeStore(): void {
  getStateDb()
    .prepare<[number]>(
      `DELETE FROM runtime_instances
       WHERE id NOT IN (
         SELECT id
         FROM runtime_instances
         ORDER BY last_event_at DESC, updated_at DESC
         LIMIT ?
       )`
    )
    .run(MAX_INSTANCES);
}

function readRuntimeRows(limit?: number): RuntimeInstanceRow[] {
  ensureRuntimeStoreMigrated();
  const max = Math.max(1, limit ?? MAX_INSTANCES);
  return getStateDb()
    .prepare<[number], RuntimeInstanceRow>(
      `SELECT
         id,
         source_client,
         display_name,
         provider_logo,
         state,
         event,
         run_id,
         correlation_id,
         initiative_id,
         workstream_id,
         task_id,
         agent_id,
         agent_name,
         phase,
         progress_pct,
         current_task,
         last_heartbeat_at,
         last_event_at,
         last_message,
         metadata_json,
         created_at,
         updated_at
       FROM runtime_instances
       ORDER BY last_event_at DESC, updated_at DESC
       LIMIT ?`
    )
    .all(max);
}

function ensureRuntimeStoreMigrated(): void {
  const migrated = readStateMeta<boolean>(RUNTIME_IMPORT_META_KEY);
  if (migrated) return;

  const db = getStateDb();
  const countRow = db
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM runtime_instances")
    .get();
  if ((countRow?.count ?? 0) > 0) {
    writeStateMeta(RUNTIME_IMPORT_META_KEY, true);
    return;
  }

  const legacy = legacyReadRuntimeInstances();
  const records = Object.values(legacy.instances)
    .map((record) => normalizeRecord(record))
    .filter((record) => Boolean(record.id));

  const transaction = db.transaction((items: RuntimeInstanceRecord[]) => {
    for (const item of items) {
      writeRuntimeRecord(item);
    }
    pruneRuntimeStore();
    writeStateMeta(RUNTIME_IMPORT_META_KEY, true);
  });
  transaction(records);
}

export function readRuntimeInstances(): PersistedRuntimeInstances {
  const rows = readRuntimeRows(MAX_INSTANCES);
  const instances: Record<string, RuntimeInstanceRecord> = {};
  let updatedAt = new Date(0).toISOString();
  for (const row of rows) {
    const record = rowToRecord(row);
    instances[record.id] = record;
    if (Date.parse(record.updatedAt) > Date.parse(updatedAt)) {
      updatedAt = record.updatedAt;
    }
  }
  return {
    updatedAt: rows.length > 0 ? updatedAt : new Date().toISOString(),
    instances,
  };
}

export function upsertRuntimeInstanceFromHook(
  payload: RuntimeHookPayload
): RuntimeInstanceRecord {
  ensureRuntimeStoreMigrated();
  const sourceClient = normalizeSourceClient(payload.source_client);
  const event = normalizeHookEvent(payload.event);
  const nowIso = new Date().toISOString();
  const eventAt = normalizeIsoTimestamp(payload.timestamp, nowIso);
  const runId = normalizeNullableString(payload.run_id);
  const correlationId = normalizeNullableString(payload.correlation_id);
  const initiativeId = normalizeNullableString(payload.initiative_id);
  const workstreamId = normalizeNullableString(payload.workstream_id);
  const taskId = normalizeNullableString(payload.task_id);
  const agentId = normalizeNullableString(payload.agent_id);
  const agentName = normalizeNullableString(payload.agent_name);
  const phase = normalizeNullableString(payload.phase);
  const progressPct = normalizeProgress(payload.progress_pct);
  const message = normalizeNullableString(payload.message);
  const metadata = normalizeObject(payload.metadata);

  const id = deriveInstanceId({
    sourceClient,
    runId,
    correlationId,
    agentId,
    initiativeId,
  });

  const existingRow = getStateDb()
    .prepare<[string], RuntimeInstanceRow>(
      `SELECT
         id,
         source_client,
         display_name,
         provider_logo,
         state,
         event,
         run_id,
         correlation_id,
         initiative_id,
         workstream_id,
         task_id,
         agent_id,
         agent_name,
         phase,
         progress_pct,
         current_task,
         last_heartbeat_at,
         last_event_at,
         last_message,
         metadata_json,
         created_at,
         updated_at
       FROM runtime_instances
       WHERE id = ?`
    )
    .get(id);
  const existing = existingRow ? rowToRecord(existingRow) : null;

  let state: RuntimeInstanceState = existing?.state ?? "active";
  if (event === "session_stop") state = "stopped";
  else if (event === "error") state = "error";
  else state = "active";

  const shouldRefreshHeartbeat =
    event === "session_start" ||
    event === "heartbeat" ||
    event === "progress" ||
    event === "task_update";

  const record: RuntimeInstanceRecord = {
    id,
    sourceClient,
    displayName: toDisplayName(sourceClient),
    providerLogo: toProviderLogo(sourceClient),
    state,
    event,
    runId: runId ?? existing?.runId ?? null,
    correlationId: correlationId ?? existing?.correlationId ?? null,
    initiativeId: initiativeId ?? existing?.initiativeId ?? null,
    workstreamId: workstreamId ?? existing?.workstreamId ?? null,
    taskId: taskId ?? existing?.taskId ?? null,
    agentId: agentId ?? existing?.agentId ?? null,
    agentName: agentName ?? existing?.agentName ?? null,
    phase: phase ?? existing?.phase ?? null,
    progressPct: progressPct ?? existing?.progressPct ?? null,
    currentTask: taskId ?? existing?.currentTask ?? null,
    lastHeartbeatAt: shouldRefreshHeartbeat
      ? eventAt
      : existing?.lastHeartbeatAt ?? null,
    lastEventAt: eventAt,
    lastMessage: message ?? existing?.lastMessage ?? null,
    metadata: metadata ?? existing?.metadata ?? null,
    createdAt: existing?.createdAt ?? eventAt,
    updatedAt: nowIso,
  };

  const transaction = getStateDb().transaction((item: RuntimeInstanceRecord) => {
    writeRuntimeRecord(item);
    pruneRuntimeStore();
  });
  transaction(record);
  return record;
}

export function applyRuntimeInstanceStaleness(options?: {
  timeoutMs?: number;
  nowMs?: number;
}): PersistedRuntimeInstances {
  ensureRuntimeStoreMigrated();
  const timeoutMs = Math.max(
    10_000,
    options?.timeoutMs ?? DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS
  );
  const nowMs = options?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - timeoutMs).toISOString();
  const updatedAt = new Date(nowMs).toISOString();

  getStateDb()
    .prepare<[string, string]>(
      `UPDATE runtime_instances
       SET state = 'stale',
           updated_at = ?
       WHERE state = 'active'
         AND COALESCE(last_heartbeat_at, last_event_at) < ?`
    )
    .run(updatedAt, cutoffIso);

  return readRuntimeInstances();
}

export function listRuntimeInstances(options?: {
  limit?: number;
  timeoutMs?: number;
  nowMs?: number;
}): RuntimeInstanceRecord[] {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS;
  const nowMs = options?.nowMs ?? Date.now();
  void applyRuntimeInstanceStaleness({ timeoutMs, nowMs });
  return readRuntimeRows(options?.limit ?? MAX_INSTANCES).map(rowToRecord);
}

export function clearRuntimeInstances(): void {
  getStateDb().prepare("DELETE FROM runtime_instances").run();
  clearStoreFileSync(runtimeFile());
}

export function resolveRuntimeHookToken(): string {
  const envToken = normalizeNullableString(process.env.ORGX_HOOK_TOKEN);
  if (envToken) return envToken;

  const file = hookTokenFile();
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8");
      const token = normalizeNullableString(raw);
      if (token) return token;
    }
  } catch {
    // fallback to generated token
  }

  const generated = `orgx_hook_${randomUUID().replace(/-/g, "")}`;
  writeHookTokenFile(generated);
  return generated;
}
