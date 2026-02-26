import {
  existsSync,
  readFileSync,
} from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";
import {
  clearStoreFileSync,
  ensureStoreDirSync,
  parseJsonSafe,
} from "./stores/json-store.js";

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

const MAX_RUNS = 240;

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

export function readAgentRuns(): PersistedAgentRuns {
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

export function getAgentRun(runId: string): AgentRunRecord | null {
  const id = runId.trim();
  if (!id) return null;
  const store = readAgentRuns();
  const record = store.runs[id];
  return record ? normalizeRecord(record) : null;
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
  const next = readAgentRuns();

  const existing = next.runs[runId];
  const startedAt =
    typeof input.startedAt === "string" && input.startedAt.trim().length > 0
      ? input.startedAt
      : existing?.startedAt ?? new Date().toISOString();

  next.runs[runId] = normalizeRecord({
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
  next.updatedAt = new Date().toISOString();

  const records = Object.values(next.runs);
  if (records.length > MAX_RUNS) {
    records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const keep = new Set(records.slice(0, MAX_RUNS).map((r) => r.runId));
    for (const key of Object.keys(next.runs)) {
      if (!keep.has(key)) {
        delete next.runs[key];
      }
    }
  }

  const file = runFile();
  writeJsonFileAtomicSync(file, next, 0o600);

  return next;
}

export function markAgentRunStopped(runId: string): AgentRunRecord | null {
  const id = runId.trim();
  if (!id) return null;

  const store = readAgentRuns();
  const existing = store.runs[id];
  if (!existing) return null;

  const next = upsertAgentRun({
    ...existing,
    runId: id,
    agentId: existing.agentId,
    pid: existing.pid ?? null,
    message: existing.message ?? null,
    provider: existing.provider ?? null,
    model: existing.model ?? null,
    initiativeId: (existing as AgentRunRecord).initiativeId ?? null,
    initiativeTitle: (existing as AgentRunRecord).initiativeTitle ?? null,
    workstreamId: (existing as AgentRunRecord).workstreamId ?? null,
    taskId: (existing as AgentRunRecord).taskId ?? null,
    stoppedAt: new Date().toISOString(),
    status: "stopped",
  });

  const updated = next.runs[id];
  return updated ? normalizeRecord(updated) : null;
}

export function clearAgentRuns(): void {
  clearStoreFileSync(runFile());
}
