export type TaskStateBucket = "done" | "blocked" | "active" | "todo";

export function classifyTaskState(status: unknown): TaskStateBucket {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  ) {
    return "done";
  }
  if (normalized === "blocked" || normalized === "at_risk") {
    return "blocked";
  }
  if (
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued" ||
    normalized === "retry_pending"
  ) {
    return "active";
  }
  return "todo";
}

export type TaskStatusCounts = {
  total: number;
  done: number;
  blocked: number;
  active: number;
  todo: number;
};

export function summarizeTaskStatuses(taskStatuses: unknown[] = []): TaskStatusCounts {
  const counts: TaskStatusCounts = {
    total: taskStatuses.length,
    done: 0,
    blocked: 0,
    active: 0,
    todo: 0,
  };

  for (const status of taskStatuses) {
    const bucket = classifyTaskState(status);
    counts[bucket] += 1;
  }

  return counts;
}

function toPercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

export type MilestoneRollupStatus = "planned" | "in_progress" | "at_risk" | "completed";
export type WorkstreamRollupStatus = "not_started" | "active" | "blocked" | "done";

export function computeMilestoneRollup(taskStatuses: unknown[] = []): TaskStatusCounts & {
  status: MilestoneRollupStatus;
  progressPct: number;
} {
  const counts = summarizeTaskStatuses(taskStatuses);
  const progressPct = toPercent(counts.done, counts.total);
  let status: MilestoneRollupStatus = "planned";

  if (counts.total <= 0) {
    status = "planned";
  } else if (counts.done >= counts.total) {
    status = "completed";
  } else if (counts.blocked > 0 && counts.active === 0) {
    status = "at_risk";
  } else if (counts.active > 0 || counts.done > 0) {
    status = "in_progress";
  }

  return {
    ...counts,
    status,
    progressPct,
  };
}

export function computeWorkstreamRollup(taskStatuses: unknown[] = []): TaskStatusCounts & {
  status: WorkstreamRollupStatus;
  progressPct: number;
} {
  const counts = summarizeTaskStatuses(taskStatuses);
  const progressPct = toPercent(counts.done, counts.total);
  let status: WorkstreamRollupStatus = "not_started";

  if (counts.total <= 0) {
    status = "not_started";
  } else if (counts.done >= counts.total) {
    status = "done";
  } else if (counts.blocked > 0 && counts.active === 0) {
    status = "blocked";
  } else if (counts.active > 0 || counts.done > 0) {
    status = "active";
  }

  return {
    ...counts,
    status,
    progressPct,
  };
}

