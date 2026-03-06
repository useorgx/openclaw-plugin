export type TaskStateBucket = "done" | "blocked" | "active" | "todo";

export function classifyTaskState(status: unknown): TaskStateBucket {
  const normalized = String(status ?? "").trim().toLowerCase();
  const canonical = normalized.replace(/[\s-]+/g, "_");
  if (
    canonical === "done" ||
    canonical === "completed" ||
    canonical === "cancelled" ||
    canonical === "archived" ||
    canonical === "deleted"
  ) {
    return "done";
  }
  if (
    canonical === "blocked" ||
    canonical === "at_risk" ||
    canonical === "on_hold" ||
    canonical === "onhold"
  ) {
    return "blocked";
  }
  if (
    canonical === "in_progress" ||
    canonical === "inprogress" ||
    canonical === "active" ||
    canonical === "running" ||
    canonical === "queued" ||
    canonical === "retry_pending" ||
    canonical === "pending_review" ||
    canonical === "pendingreview"
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

function normalizePassRate(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 1;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

// ---------------------------------------------------------------------------
// Task Completion Readiness (artifact-aware proof check)
// ---------------------------------------------------------------------------

export type TaskCompletionReadiness = "ready" | "needs_proof" | "needs_review";

export interface TaskCompletionReadinessResult {
  ready: boolean;
  status: TaskCompletionReadiness;
  hasArtifact: boolean;
  hasSchemaValidatedArtifact: boolean;
  hasQualityScore: boolean;
  qualityScore: number | null;
  qualityThreshold: number;
  missingItems: string[];
  warnings: string[];
}

/**
 * Evaluate whether a task has sufficient proof chain evidence to be marked
 * complete. In phase 1 this is advisory (warn-only); callers decide whether
 * to hard-block or soft-warn based on workspace config.
 */
export function computeTaskCompletionReadiness(input: {
  artifacts?: Array<{ schema_validated?: boolean; atomic_unit_type?: string }>;
  qualityScore?: number | null;
  qualityThreshold?: number;
  hasOutcomeEvent?: boolean;
}): TaskCompletionReadinessResult {
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const qualityThreshold =
    typeof input.qualityThreshold === "number" && Number.isFinite(input.qualityThreshold)
      ? input.qualityThreshold
      : 4;
  const qualityScore =
    typeof input.qualityScore === "number" && Number.isFinite(input.qualityScore)
      ? input.qualityScore
      : null;

  const hasArtifact = artifacts.length > 0;
  const hasSchemaValidatedArtifact = artifacts.some(
    (a) => a.schema_validated === true && typeof a.atomic_unit_type === "string"
  );
  const hasQualityScore = qualityScore !== null;
  const qualityMeetsThreshold = qualityScore !== null && qualityScore >= qualityThreshold;

  const missingItems: string[] = [];
  const warnings: string[] = [];

  if (!hasArtifact) {
    missingItems.push("No artifact registered for this task.");
  } else if (!hasSchemaValidatedArtifact) {
    warnings.push("Artifact(s) present but none pass domain schema validation.");
  }

  if (!hasQualityScore) {
    missingItems.push("No quality score recorded.");
  } else if (!qualityMeetsThreshold) {
    missingItems.push(
      `Quality score ${qualityScore} below threshold ${qualityThreshold}.`
    );
  }

  if (input.hasOutcomeEvent === false) {
    warnings.push("No outcome event recorded (L5 Impact not met).");
  }

  const ready = hasArtifact && hasQualityScore && qualityMeetsThreshold;
  let status: TaskCompletionReadiness;
  if (ready) {
    status = "ready";
  } else if (hasArtifact && hasQualityScore) {
    status = "needs_review";
  } else {
    status = "needs_proof";
  }

  return {
    ready,
    status,
    hasArtifact,
    hasSchemaValidatedArtifact,
    hasQualityScore,
    qualityScore,
    qualityThreshold,
    missingItems,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Eval pass rate drift detection
// ---------------------------------------------------------------------------

export type EvalPassRateDriftResult = {
  alert: boolean;
  baselinePassRate: number;
  rollingPassRate7d: number;
  dropPct: number;
  thresholdDropPct: number;
  baselineSamples: number;
  rollingSamples: number;
};

export function detectEvalPassRateDrift(input: {
  passRates: unknown[];
  thresholdDropPct?: number;
  rollingWindowDays?: number;
  baselineWindowDays?: number;
}): EvalPassRateDriftResult | null {
  const thresholdDropPct =
    typeof input.thresholdDropPct === "number" && Number.isFinite(input.thresholdDropPct) && input.thresholdDropPct >= 0
      ? input.thresholdDropPct
      : 5;
  const rollingWindowDays =
    typeof input.rollingWindowDays === "number" && Number.isFinite(input.rollingWindowDays) && input.rollingWindowDays > 0
      ? Math.floor(input.rollingWindowDays)
      : 7;
  const baselineWindowDays =
    typeof input.baselineWindowDays === "number" &&
    Number.isFinite(input.baselineWindowDays) &&
    input.baselineWindowDays > 0
      ? Math.floor(input.baselineWindowDays)
      : rollingWindowDays;

  const normalizedPassRates = (Array.isArray(input.passRates) ? input.passRates : [])
    .map(normalizePassRate)
    .filter((value): value is number => value != null);
  const requiredSamples = rollingWindowDays + baselineWindowDays;
  if (normalizedPassRates.length < requiredSamples) return null;

  const rollingStart = normalizedPassRates.length - rollingWindowDays;
  const baselineEnd = rollingStart;
  const baselineStart = Math.max(0, baselineEnd - baselineWindowDays);
  const rollingSlice = normalizedPassRates.slice(rollingStart);
  const baselineSlice = normalizedPassRates.slice(baselineStart, baselineEnd);
  if (rollingSlice.length <= 0 || baselineSlice.length <= 0) return null;

  const baselinePassRate = average(baselineSlice);
  const rollingPassRate7d = average(rollingSlice);
  const dropPct = Number(((baselinePassRate - rollingPassRate7d) * 100).toFixed(2));
  return {
    alert: dropPct > thresholdDropPct,
    baselinePassRate: Number(baselinePassRate.toFixed(4)),
    rollingPassRate7d: Number(rollingPassRate7d.toFixed(4)),
    dropPct,
    thresholdDropPct,
    baselineSamples: baselineSlice.length,
    rollingSamples: rollingSlice.length,
  };
}
