import type { AgentRunRecord } from "../agent-run-store.js";
import type { AgentState } from "../types.js";

const KNOWN_DOMAINS = [
  "engineering",
  "product",
  "design",
  "marketing",
  "sales",
  "operations",
  "orchestration",
] as const;
const IDLE_MIRROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function inferDomainFromAgentId(agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  for (const domain of KNOWN_DOMAINS) {
    if (normalized.includes(domain)) return domain;
  }
  return "operations";
}

function inferNameFromAgentId(agentId: string): string {
  const cleaned = agentId
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) return "Local Agent";
  return cleaned
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toEpoch(value: string): number {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : 0;
}

function normalizeMirror(input: AgentState): AgentState | null {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return null;
  const status =
    input.status === "active" || input.status === "throttled" ? input.status : "idle";
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim()
      : inferNameFromAgentId(id);
  const domain =
    typeof input.domain === "string" && input.domain.trim().length > 0
      ? input.domain.trim()
      : inferDomainFromAgentId(id);
  return {
    id,
    name,
    domain,
    status,
    currentTask: input.currentTask,
    lastActive: input.lastActive,
  };
}

export function buildLocalAgentMirrorsFromSnapshot(input: {
  agents: AgentState[] | null | undefined;
}): AgentState[] {
  const latestByAgent = new Map<string, AgentState>();
  for (const source of input.agents ?? []) {
    const normalized = normalizeMirror(source);
    if (!normalized) continue;
    const previous = latestByAgent.get(normalized.id);
    if (
      !previous ||
      toEpoch(normalized.lastActive ?? "") >= toEpoch(previous.lastActive ?? "")
    ) {
      latestByAgent.set(normalized.id, normalized);
    }
  }
  return Array.from(latestByAgent.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Derive live local agent states from active OpenClaw runs so sync can mirror
 * local runtime telemetry into OrgX.
 */
export function buildLocalSyncAgentsFromRuns(input: {
  runs: Record<string, AgentRunRecord>;
  mirrors?: AgentState[] | null;
}): AgentState[] {
  const latestRunningByAgent = new Map<string, AgentRunRecord>();
  const latestStoppedByAgent = new Map<string, AgentRunRecord>();
  const mergedByAgent = new Map<string, AgentState>();
  const now = Date.now();

  for (const mirror of buildLocalAgentMirrorsFromSnapshot({ agents: input.mirrors })) {
    mergedByAgent.set(mirror.id, mirror);
  }

  for (const run of Object.values(input.runs ?? {})) {
    if (!run) continue;
    const agentId = run.agentId?.trim();
    if (!agentId) continue;

    const isRunning = run.status === "running";
    const index = isRunning ? latestRunningByAgent : latestStoppedByAgent;
    const runTimestamp = isRunning ? toEpoch(run.startedAt) : toEpoch(run.stoppedAt ?? run.startedAt);
    const previous = index.get(agentId);
    const previousTimestamp = previous
      ? toEpoch(previous.status === "running" ? previous.startedAt : previous.stoppedAt ?? previous.startedAt)
      : 0;
    if (!previous || runTimestamp >= previousTimestamp) {
      index.set(agentId, run);
    }
  }

  for (const [agentId, run] of latestRunningByAgent) {
    mergedByAgent.set(agentId, {
      id: agentId,
      name: inferNameFromAgentId(agentId),
      domain: inferDomainFromAgentId(agentId),
      status: "active",
      currentTask: run.taskId ?? undefined,
      lastActive: run.startedAt,
    });
  }

  for (const [agentId, run] of latestStoppedByAgent) {
    if (latestRunningByAgent.has(agentId)) continue;
    const lastActive = run.stoppedAt ?? run.startedAt;
    const idleAgeMs = now - toEpoch(lastActive);
    if (!Number.isFinite(idleAgeMs) || idleAgeMs < 0 || idleAgeMs > IDLE_MIRROR_MAX_AGE_MS) {
      continue;
    }
    const existing = mergedByAgent.get(agentId);
    if (existing && toEpoch(existing.lastActive ?? "") > toEpoch(lastActive)) continue;
    mergedByAgent.set(agentId, {
      id: agentId,
      name: existing?.name ?? inferNameFromAgentId(agentId),
      domain: existing?.domain ?? inferDomainFromAgentId(agentId),
      status: "idle",
      lastActive,
    });
  }

  return Array.from(mergedByAgent.values()).sort((a, b) => a.id.localeCompare(b.id));
}
