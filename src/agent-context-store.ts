import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

export type AgentLaunchContext = {
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
};

const MAX_AGENTS = 120;

function contextDir(): string {
  return getOrgxPluginConfigDir();
}

function contextFile(): string {
  return getOrgxPluginConfigPath("agent-contexts.json");
}

function ensureContextDir(): void {
  const dir = contextDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
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

function normalizeContext(input: AgentLaunchContext): AgentLaunchContext {
  return {
    agentId: input.agentId.trim(),
    initiativeId: input.initiativeId ?? null,
    initiativeTitle: input.initiativeTitle ?? null,
    workstreamId: input.workstreamId ?? null,
    taskId: input.taskId ?? null,
    updatedAt: input.updatedAt,
  };
}

export function readAgentContexts(): PersistedAgentContexts {
  const file = contextFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), agents: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<PersistedAgentContexts>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { updatedAt: new Date().toISOString(), agents: {} };
    }
    const agents =
      parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {};
    return {
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      agents: agents as Record<string, AgentLaunchContext>,
    };
  } catch {
    return { updatedAt: new Date().toISOString(), agents: {} };
  }
}

export function getAgentContext(agentId: string): AgentLaunchContext | null {
  const id = agentId.trim();
  if (!id) return null;
  const store = readAgentContexts();
  const ctx = store.agents[id];
  return ctx ? normalizeContext(ctx) : null;
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
    values.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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

export function clearAgentContexts(): void {
  const file = contextFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}
