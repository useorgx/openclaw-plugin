import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

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

const MAX_INSTANCES = 600;
export const DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS = 90_000;

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
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function writeHookTokenFile(token: string): void {
  ensureRuntimeDir();
  const file = hookTokenFile();
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
  if (sourceClient === "codex") return "codex";
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
  if (normalized === "codex") return "codex";
  if (normalized === "openai") return sourceClient === "codex" ? "codex" : "openai";
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

export function readRuntimeInstances(): PersistedRuntimeInstances {
  const file = runtimeFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), instances: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<PersistedRuntimeInstances>(raw);
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

function pruneStore(store: PersistedRuntimeInstances): void {
  const values = Object.values(store.instances);
  if (values.length <= MAX_INSTANCES) return;
  values.sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
  const keep = new Set(values.slice(0, MAX_INSTANCES).map((record) => record.id));
  for (const key of Object.keys(store.instances)) {
    if (!keep.has(key)) {
      delete store.instances[key];
    }
  }
}

function writeRuntimeInstances(next: PersistedRuntimeInstances): void {
  ensureRuntimeDir();
  const file = runtimeFile();
  writeJsonFileAtomicSync(file, next, 0o600);
}

export function upsertRuntimeInstanceFromHook(
  payload: RuntimeHookPayload
): RuntimeInstanceRecord {
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
  const store = readRuntimeInstances();
  const existing = store.instances[id] ? normalizeRecord(store.instances[id]) : null;

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

  store.instances[id] = record;
  store.updatedAt = nowIso;
  pruneStore(store);
  writeRuntimeInstances(store);
  return record;
}

export function applyRuntimeInstanceStaleness(options?: {
  timeoutMs?: number;
  nowMs?: number;
}): PersistedRuntimeInstances {
  const timeoutMs = Math.max(
    10_000,
    options?.timeoutMs ?? DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS
  );
  const nowMs = options?.nowMs ?? Date.now();
  const store = readRuntimeInstances();
  let changed = false;

  for (const [id, rawRecord] of Object.entries(store.instances)) {
    const record = normalizeRecord(rawRecord);
    if (record.state !== "active") {
      if (rawRecord !== record) {
        store.instances[id] = record;
        changed = true;
      }
      continue;
    }

    const heartbeatAt = record.lastHeartbeatAt ?? record.lastEventAt;
    const heartbeatEpoch = Date.parse(heartbeatAt);
    if (!Number.isFinite(heartbeatEpoch)) continue;
    if (nowMs - heartbeatEpoch <= timeoutMs) continue;

    store.instances[id] = {
      ...record,
      state: "stale",
      updatedAt: new Date(nowMs).toISOString(),
    };
    changed = true;
  }

  if (changed) {
    store.updatedAt = new Date(nowMs).toISOString();
    writeRuntimeInstances(store);
  }
  return store;
}

export function listRuntimeInstances(options?: {
  limit?: number;
  timeoutMs?: number;
  nowMs?: number;
}): RuntimeInstanceRecord[] {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUNTIME_HEARTBEAT_TIMEOUT_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const store = applyRuntimeInstanceStaleness({ timeoutMs, nowMs });
  const limit = Math.max(1, options?.limit ?? MAX_INSTANCES);
  return Object.values(store.instances)
    .map((record) => normalizeRecord(record))
    .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt))
    .slice(0, limit);
}

export function clearRuntimeInstances(): void {
  const file = runtimeFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
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
