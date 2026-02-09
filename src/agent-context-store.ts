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

const CONTEXT_DIR = join(homedir(), ".config", "useorgx", "openclaw-plugin");
const CONTEXT_FILE = join(CONTEXT_DIR, "agent-contexts.json");
const MAX_AGENTS = 120;

function ensureContextDir(): void {
  mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONTEXT_DIR, 0o700);
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
  try {
    if (!existsSync(CONTEXT_FILE)) {
      return { updatedAt: new Date().toISOString(), agents: {} };
    }
    const parsed = parseJson<PersistedAgentContexts>(
      readFileSync(CONTEXT_FILE, "utf8")
    );
    if (!parsed || typeof parsed !== "object") {
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

  writeFileSync(CONTEXT_FILE, JSON.stringify(next, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  try {
    chmodSync(CONTEXT_FILE, 0o600);
  } catch {
    // best effort
  }
  return next;
}

export function clearAgentContexts(): void {
  try {
    rmSync(CONTEXT_FILE, { force: true });
  } catch {
    // best effort
  }
}
