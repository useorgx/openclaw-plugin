import type { OrgSnapshot, TaskSummary } from "./types.js";

export type SnapshotTaskFilter = {
  agentId?: string;
  domain?: string;
  canonicalOnly?: boolean;
};

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function assignedAgentIds(task: TaskSummary): string[] {
  return Array.from(
    new Set(
      [
        ...(task.assignedAgentIds ?? []),
        task.canonicalAssignedAgentId,
        task.assignee,
      ]
        .filter((value): value is string => typeof value === "string")
        .map(normalize)
        .filter(Boolean),
    ),
  );
}

function taskMatchesFilter(
  task: TaskSummary,
  filter: SnapshotTaskFilter,
): boolean {
  if (filter.canonicalOnly && task.canonicalNextTask !== true) return false;
  const requestedAgentId = normalize(filter.agentId);
  if (requestedAgentId && !assignedAgentIds(task).includes(requestedAgentId)) {
    return false;
  }
  const requestedDomain = normalize(filter.domain);
  if (requestedDomain && normalize(task.domain) !== requestedDomain)
    return false;
  return true;
}

function taskMetadata(task: TaskSummary): string {
  const details: string[] = [];
  if (task.domain) details.push(`domain=${task.domain}`);
  const agents = assignedAgentIds(task);
  if (agents.length > 0) details.push(`agent=${agents.join(",")}`);
  if (task.canonicalNextTask) details.push("canonical");
  if (task.dispatchReady === false) details.push("dispatch=held");
  if (task.canonicalGoalId) details.push(`goal=${task.canonicalGoalId}`);
  if (task.initiativeId) details.push(`initiative=${task.initiativeId}`);
  if (task.workstreamId) details.push(`workstream=${task.workstreamId}`);
  if (task.dueDate) details.push(`due=${task.dueDate}`);
  return details.length > 0 ? ` | ${details.join(" | ")}` : "";
}

function compact(value: string, limit = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function taskContextLines(task: TaskSummary): string[] {
  const lines: string[] = [];
  if (task.description) lines.push(`  Context: ${compact(task.description)}`);
  if (task.acceptanceCriteria?.length) {
    lines.push(
      `  Acceptance: ${task.acceptanceCriteria.map((item) => compact(item, 220)).join("; ")}`,
    );
  }
  const execution = task.executionContext;
  if (execution) {
    const details = [
      execution.mode && `mode=${execution.mode}`,
      execution.repository && `repository=${execution.repository}`,
      execution.workingDirectory && `cwd=${execution.workingDirectory}`,
      execution.branch && `branch=${execution.branch}`,
      execution.sourceUrl && `source=${execution.sourceUrl}`,
      execution.notes && `notes=${compact(execution.notes, 220)}`,
    ].filter((value): value is string => Boolean(value));
    if (details.length > 0) lines.push(`  Execution: ${details.join(" | ")}`);
  }
  return lines;
}

export function formatSnapshot(
  snap: OrgSnapshot,
  filter: SnapshotTaskFilter = {},
): string {
  const lines: string[] = ["# OrgX Status\n"];

  if (snap.initiatives?.length) {
    lines.push("## Initiatives");
    for (const initiative of snap.initiatives) {
      const pct =
        initiative.progress != null ? ` (${initiative.progress}%)` : "";
      lines.push(`- **${initiative.title}** — ${initiative.status}${pct}`);
    }
    lines.push("");
  }

  if (snap.agents?.length) {
    lines.push("## Agents");
    for (const agent of snap.agents) {
      const task = agent.currentTask ? ` → ${agent.currentTask}` : "";
      lines.push(
        `- **${agent.name}** [${agent.domain}]: ${agent.status}${task}`,
      );
    }
    lines.push("");
  }

  const activeTasks = (snap.activeTasks ?? []).filter((task) =>
    taskMatchesFilter(task, filter),
  );
  const taskScope = filter.agentId ?? filter.domain;
  lines.push(
    taskScope ? `## Active Tasks For ${taskScope}` : "## Active Tasks",
  );
  if (activeTasks.length === 0) {
    lines.push("- None");
  } else {
    for (const task of activeTasks) {
      const tier = task.modelTier ? ` (${task.modelTier})` : "";
      lines.push(
        `- [${task.id}] ${task.title} — ${task.status}${tier}${taskMetadata(task)}`,
      );
      lines.push(...taskContextLines(task));
    }
  }
  lines.push("");

  if (snap.pendingDecisions?.length) {
    lines.push("## Pending Decisions");
    for (const decision of snap.pendingDecisions) {
      lines.push(`- [${decision.urgency.toUpperCase()}] ${decision.title}`);
    }
    lines.push("");
  }

  if (snap.syncedAt) lines.push(`_Last synced: ${snap.syncedAt}_`);
  return lines.join("\n");
}
