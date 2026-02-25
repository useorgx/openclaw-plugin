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

export type AgentLaunchContext = {
  agentId: string;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  updatedAt: string;
};

export type RunLaunchContext = {
  runId: string;
  agentId: string;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  updatedAt: string;
};

type PersistedAgentContexts = {
  updatedAt: string;
  agents: Record<string, AgentLaunchContext>;
  runs?: Record<string, RunLaunchContext>;
};

const MAX_AGENTS = 120;
const MAX_RUNS = 480;

function timestampSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return new Date().toISOString();
}

function normalizeAgentContextsMap(input: unknown): Record<string, AgentLaunchContext> {
  if (!isRecord(input)) return {};
  const normalized: Record<string, AgentLaunchContext> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;
    const hasExplicitAgentId = Object.prototype.hasOwnProperty.call(value, "agentId");
    const id = hasExplicitAgentId ? asOptionalString(value.agentId) : asOptionalString(key);
    if (!id) continue;
    normalized[id] = {
      agentId: id,
      initiativeId: asOptionalString(value.initiativeId),
      initiativeTitle: asOptionalString(value.initiativeTitle),
      workstreamId: asOptionalString(value.workstreamId),
      taskId: asOptionalString(value.taskId),
      updatedAt: asTimestamp(value.updatedAt),
    };
  }
  return normalized;
}

function normalizeRunContextsMap(input: unknown): Record<string, RunLaunchContext> {
  if (!isRecord(input)) return {};
  const normalized: Record<string, RunLaunchContext> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;
    const hasExplicitRunId = Object.prototype.hasOwnProperty.call(value, "runId");
    const runId = hasExplicitRunId ? asOptionalString(value.runId) : asOptionalString(key);
    const agentId = asOptionalString(value.agentId);
    if (!runId || !agentId) continue;
    normalized[runId] = {
      runId,
      agentId,
      initiativeId: asOptionalString(value.initiativeId),
      initiativeTitle: asOptionalString(value.initiativeTitle),
      workstreamId: asOptionalString(value.workstreamId),
      taskId: asOptionalString(value.taskId),
      updatedAt: asTimestamp(value.updatedAt),
    };
  }
  return normalized;
}

function contextDir(): string {
  return getOrgxPluginConfigDir();
}

function contextFile(): string {
  return getOrgxPluginConfigPath("agent-contexts.json");
}

function ensureContextDir(): void {
  ensureStoreDirSync(contextDir());
}

function normalizeContext(input: AgentLaunchContext): AgentLaunchContext {
  return {
    agentId: input.agentId.trim(),
    initiativeId: asOptionalString(input.initiativeId),
    initiativeTitle: asOptionalString(input.initiativeTitle),
    workstreamId: asOptionalString(input.workstreamId),
    taskId: asOptionalString(input.taskId),
    updatedAt: asTimestamp(input.updatedAt),
  };
}

function normalizeRunContext(input: RunLaunchContext): RunLaunchContext {
  return {
    runId: input.runId.trim(),
    agentId: input.agentId.trim(),
    initiativeId: asOptionalString(input.initiativeId),
    initiativeTitle: asOptionalString(input.initiativeTitle),
    workstreamId: asOptionalString(input.workstreamId),
    taskId: asOptionalString(input.taskId),
    updatedAt: asTimestamp(input.updatedAt),
  };
}

export function readAgentContexts(): PersistedAgentContexts {
  const file = contextFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), agents: {}, runs: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedAgentContexts>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { updatedAt: new Date().toISOString(), agents: {}, runs: {} };
    }
    const agents = normalizeAgentContextsMap(parsed.agents);
    const runs = normalizeRunContextsMap(parsed.runs);
    return {
      updatedAt: asTimestamp(parsed.updatedAt),
      agents: agents as Record<string, AgentLaunchContext>,
      runs: runs as Record<string, RunLaunchContext>,
    };
  } catch {
    return { updatedAt: new Date().toISOString(), agents: {}, runs: {} };
  }
}

export function getAgentContext(agentId: string): AgentLaunchContext | null {
  const id = agentId.trim();
  if (!id) return null;
  const store = readAgentContexts();
  const ctx = store.agents[id];
  return ctx ? normalizeContext(ctx) : null;
}

export function getRunContext(runId: string): RunLaunchContext | null {
  const id = runId.trim();
  if (!id) return null;
  const store = readAgentContexts();
  const ctx = store.runs?.[id];
  return ctx ? normalizeRunContext(ctx) : null;
}

export function upsertAgentContext(input: {
  agentId: string;
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  taskId?: string | null;
}): PersistedAgentContexts {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return readAgentContexts();
  }
  ensureContextDir();

  const next = readAgentContexts();
  next.agents[agentId] = normalizeContext({
    agentId,
    initiativeId: input.initiativeId ?? null,
    initiativeTitle: input.initiativeTitle ?? null,
    workstreamId: input.workstreamId ?? null,
    taskId: input.taskId ?? null,
    updatedAt: new Date().toISOString(),
  });
  next.updatedAt = new Date().toISOString();

  // Prune if the file grows unbounded (rare).
  const values = Object.values(next.agents);
  if (values.length > MAX_AGENTS) {
    values.sort((a, b) => timestampSortValue(b.updatedAt) - timestampSortValue(a.updatedAt));
    const keep = new Set(values.slice(0, MAX_AGENTS).map((c) => c.agentId));
    for (const key of Object.keys(next.agents)) {
      if (!keep.has(key)) {
        delete next.agents[key];
      }
    }
  }

  const file = contextFile();
  writeJsonFileAtomicSync(file, next, 0o600);
  return next;
}

export function upsertRunContext(input: {
  runId: string;
  agentId: string;
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  taskId?: string | null;
}): PersistedAgentContexts {
  const runId = input.runId.trim();
  const agentId = input.agentId.trim();
  if (!runId || !agentId) {
    return readAgentContexts();
  }
  ensureContextDir();

  const next = readAgentContexts();
  if (!next.runs || typeof next.runs !== "object") {
    next.runs = {};
  }

  next.runs[runId] = normalizeRunContext({
    runId,
    agentId,
    initiativeId: input.initiativeId ?? null,
    initiativeTitle: input.initiativeTitle ?? null,
    workstreamId: input.workstreamId ?? null,
    taskId: input.taskId ?? null,
    updatedAt: new Date().toISOString(),
  });
  next.updatedAt = new Date().toISOString();

  const values = Object.values(next.runs);
  if (values.length > MAX_RUNS) {
    values.sort((a, b) => timestampSortValue(b.updatedAt) - timestampSortValue(a.updatedAt));
    const keep = new Set(values.slice(0, MAX_RUNS).map((c) => c.runId));
    for (const key of Object.keys(next.runs)) {
      if (!keep.has(key)) {
        delete next.runs[key];
      }
    }
  }

  const file = contextFile();
  writeJsonFileAtomicSync(file, next, 0o600);
  return next;
}

export function clearAgentContexts(): void {
  clearStoreFileSync(contextFile());
}
