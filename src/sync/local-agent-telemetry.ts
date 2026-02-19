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

/**
 * Derive live local agent states from active OpenClaw runs so sync can mirror
 * local runtime telemetry into OrgX.
 */
export function buildLocalSyncAgentsFromRuns(input: {
  runs: Record<string, AgentRunRecord>;
}): AgentState[] {
  const latestByAgent = new Map<string, AgentRunRecord>();

  for (const run of Object.values(input.runs ?? {})) {
    if (!run || run.status !== "running") continue;
    const agentId = run.agentId?.trim();
    if (!agentId) continue;

    const previous = latestByAgent.get(agentId);
    if (!previous || toEpoch(run.startedAt) >= toEpoch(previous.startedAt)) {
      latestByAgent.set(agentId, run);
    }
  }

  const agents: AgentState[] = [];
  for (const run of latestByAgent.values()) {
    agents.push({
      id: run.agentId,
      name: inferNameFromAgentId(run.agentId),
      domain: inferDomainFromAgentId(run.agentId),
      status: "active",
      currentTask: run.taskId ?? undefined,
      lastActive: run.startedAt,
    });
  }

  agents.sort((a, b) => a.id.localeCompare(b.id));
  return agents;
}
