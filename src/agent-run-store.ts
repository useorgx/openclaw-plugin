import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

const RUN_DIR = join(homedir(), ".config", "useorgx", "openclaw-plugin");
const RUN_FILE = join(RUN_DIR, "agent-runs.json");
const MAX_RUNS = 240;

function ensureRunDir(): void {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(RUN_DIR, 0o700);
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

function normalizeRecord(input: AgentRunRecord): AgentRunRecord {
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
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt ?? null,
    status: input.status === "stopped" ? "stopped" : "running",
  };
}

export function readAgentRuns(): PersistedAgentRuns {
  try {
    if (!existsSync(RUN_FILE)) {
      return { updatedAt: new Date().toISOString(), runs: {} };
    }
    const parsed = parseJson<PersistedAgentRuns>(readFileSync(RUN_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return { updatedAt: new Date().toISOString(), runs: {} };
    }
    const runs = parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {};
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      runs: runs as Record<string, AgentRunRecord>,
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

  writeFileSync(RUN_FILE, JSON.stringify(next, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  try {
    chmodSync(RUN_FILE, 0o600);
  } catch {
    // best effort
  }

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
  try {
    rmSync(RUN_FILE, { force: true });
  } catch {
    // best effort
  }
}

