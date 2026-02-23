import type {
  LiveActivityItem,
  UsageBreakdownBucket,
  UsageControlPlaneSummary,
} from "../../types.js";
import type { Router } from "../router.js";

type UsageClientLike = {
  getUsageControlPlaneSummary: () => Promise<UsageControlPlaneSummary>;
};

type UsageRoutesDeps<TRes> = {
  client: UsageClientLike;
  listActivityPage: (input: {
    limit: number;
    runId?: string | null;
    since?: string | null;
    until?: string | null;
    cursor?: string | null;
  }) => {
    activities: LiveActivityItem[];
    nextCursor: string | null;
    total: number;
  };
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
  now?: () => Date;
};

type LocalAggregateBucket = {
  runs: Set<string>;
  tokens: number;
  minutes: number;
  costCents: number;
};

type LocalUsageResult = {
  summary: UsageControlPlaneSummary;
  source: "cloud" | "local_estimate";
  warnings: string[];
};

const DAY_MS = 24 * 60 * 60_000;
const MAX_ACTIVITY_PAGES = 12;
const PAGE_LIMIT = 500;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickMetadataNumber(
  metadata: Record<string, unknown> | null,
  keys: string[]
): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const parsed = toNumber(metadata[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickMetadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const normalized = normalizeText(metadata[key]);
    if (normalized) return normalized;
  }
  return null;
}

function roundInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function addToBucket(
  map: Map<string, LocalAggregateBucket>,
  key: string,
  runRef: string,
  tokens: number,
  minutes: number,
  costCents: number
): void {
  const normalizedKey = key.trim() || "unknown";
  const bucket =
    map.get(normalizedKey) ??
    {
      runs: new Set<string>(),
      tokens: 0,
      minutes: 0,
      costCents: 0,
    };
  bucket.runs.add(runRef);
  bucket.tokens += tokens;
  bucket.minutes += minutes;
  bucket.costCents += costCents;
  map.set(normalizedKey, bucket);
}

function mapToBreakdownBuckets(
  map: Map<string, LocalAggregateBucket>,
  labelTransform?: (key: string) => string
): UsageBreakdownBucket[] {
  return Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      label: labelTransform ? labelTransform(key) : key,
      runs: value.runs.size,
      tokens: roundInt(value.tokens),
      minutes: roundInt(value.minutes),
      costCents: roundInt(value.costCents),
    }))
    .sort((a, b) => {
      if (b.runs !== a.runs) return b.runs - a.runs;
      return b.tokens - a.tokens;
    });
}

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function capitalizeLabel(input: string): string {
  const normalized = input.trim();
  if (!normalized) return "Unknown";
  return normalized
    .split(/[\s_-]+/g)
    .map((part) =>
      part.length > 0 ? `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}` : part
    )
    .join(" ");
}

function buildLocalSummary(input: {
  activities: LiveActivityItem[];
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  warnings: string[];
}): UsageControlPlaneSummary {
  const periodStartIso = input.periodStart.toISOString();
  const periodEndIso = input.periodEnd.toISOString();
  const nowEpoch = input.now.getTime();
  const startEpoch = input.periodStart.getTime();
  const endEpoch = input.periodEnd.getTime();
  const daysTotal = Math.max(1, Math.round((endEpoch - startEpoch) / DAY_MS));
  const elapsedWindow = Math.max(0, nowEpoch - startEpoch);
  const daysElapsed = clampInt(Math.floor(elapsedWindow / DAY_MS) + 1, 1, daysTotal);
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  const runIds = new Set<string>();
  let totalTokens = 0;
  let totalMinutes = 0;
  let totalCostCents = 0;
  let usedFallbackMinutes = false;

  const sourceClientBuckets = new Map<string, LocalAggregateBucket>();
  const providerBuckets = new Map<string, LocalAggregateBucket>();
  const modelBuckets = new Map<string, LocalAggregateBucket>();
  const executionTargetBuckets = new Map<string, LocalAggregateBucket>();

  for (const item of input.activities) {
    const timestampEpoch = toEpoch(item.timestamp);
    if (!timestampEpoch || timestampEpoch < startEpoch || timestampEpoch >= endEpoch) continue;

    const metadata = asRecord(item.metadata);
    const runId =
      normalizeText(item.runId) ??
      pickMetadataString(metadata, ["run_id", "runId", "correlation_id", "correlationId"]) ??
      item.id;
    runIds.add(runId);

    const rawTokens =
      pickMetadataNumber(metadata, [
        "tokens_used",
        "tokensUsed",
        "total_tokens",
        "totalTokens",
        "auto_continue_tokens_used",
      ]) ?? 0;

    const rawMinutes =
      pickMetadataNumber(metadata, [
        "duration_minutes",
        "durationMinutes",
        "elapsed_minutes",
        "elapsedMinutes",
        "minutes",
      ]) ??
      (() => {
        const durationMs = pickMetadataNumber(metadata, ["duration_ms", "durationMs", "elapsed_ms"]);
        return durationMs !== null ? durationMs / 60_000 : null;
      })();

    const minutes = rawMinutes !== null ? Math.max(0, rawMinutes) : 0;
    if (rawMinutes === null) usedFallbackMinutes = true;

    const rawCostCents =
      pickMetadataNumber(metadata, ["cost_cents", "costCents"]) ??
      (() => {
        const costUsd = pickMetadataNumber(metadata, ["cost_usd", "costUsd"]);
        return costUsd !== null ? costUsd * 100 : null;
      })() ??
      0;

    const tokens = Math.max(0, rawTokens);
    const costCents = Math.max(0, rawCostCents);
    totalTokens += tokens;
    totalMinutes += minutes;
    totalCostCents += costCents;

    const sourceClient =
      pickMetadataString(metadata, ["source_client", "sourceClient", "runtime_source", "runtimeSource"]) ??
      normalizeText(item.runtimeClient) ??
      "unknown";
    const provider =
      pickMetadataString(metadata, ["provider", "runtime_provider", "runtimeProvider"]) ??
      normalizeText(item.runtimeProvider) ??
      "unknown";
    const model = pickMetadataString(metadata, ["model", "model_id", "modelId"]) ?? "unknown";
    const executionTarget =
      pickMetadataString(metadata, ["execution_target", "executionTarget", "executor"]) ??
      "unknown";

    addToBucket(sourceClientBuckets, sourceClient, runId, tokens, minutes, costCents);
    addToBucket(providerBuckets, provider, runId, tokens, minutes, costCents);
    addToBucket(modelBuckets, model, runId, tokens, minutes, costCents);
    addToBucket(executionTargetBuckets, executionTarget, runId, tokens, minutes, costCents);
  }

  if (usedFallbackMinutes && runIds.size > 0 && totalMinutes === 0) {
    totalMinutes = runIds.size * 4;
    input.warnings.push(
      "Agent minutes are estimated from run volume because duration telemetry was unavailable."
    );
  }

  const scale = daysElapsed > 0 ? daysTotal / daysElapsed : 1;
  const predictedRuns = roundInt(runIds.size * scale);
  const predictedMinutes = roundInt(totalMinutes * scale);
  const predictedTokens = roundInt(totalTokens * scale);
  const predictedCostCents = roundInt(totalCostCents * scale);

  const confidence = Math.max(0.4, Math.min(0.95, daysElapsed / Math.max(daysTotal, 1)));

  return {
    generatedAt: new Date().toISOString(),
    period: {
      start: periodStartIso,
      end: periodEndIso,
      daysTotal,
      daysElapsed,
      daysRemaining,
    },
    plan: {
      id: "local_estimate",
      name: "Local Runtime Estimate",
      allowsOverage: true,
      includedBudgetCents: 0,
      overageBudgetCents: 0,
      agentRunsLimit: 0,
      agentMinutesLimit: 0,
      scaffoldsLimit: 0,
    },
    actual: {
      agentRuns: runIds.size,
      agentMinutes: roundInt(totalMinutes),
      tokens: roundInt(totalTokens),
      costCents: roundInt(totalCostCents),
      scaffoldsUsed: 0,
      scaffoldsRemaining: 0,
    },
    predicted: {
      agentRuns: predictedRuns,
      agentMinutes: predictedMinutes,
      tokens: predictedTokens,
      costCents: predictedCostCents,
      confidence: Number(confidence.toFixed(2)),
      method: "local_linear_projection",
      remainingAgentRuns: Math.max(0, predictedRuns - runIds.size),
      remainingAgentMinutes: Math.max(0, predictedMinutes - roundInt(totalMinutes)),
      remainingTokens: Math.max(0, predictedTokens - roundInt(totalTokens)),
      remainingCostCents: Math.max(0, predictedCostCents - roundInt(totalCostCents)),
    },
    utilization: {
      runsPct: null,
      minutesPct: null,
      budgetPct: null,
    },
    headroom: {
      agentRunsRemaining: 0,
      agentMinutesRemaining: 0,
      budgetRemainingCents: 0,
    },
    risk: "safe",
    breakdown: {
      sourceClient: mapToBreakdownBuckets(sourceClientBuckets, capitalizeLabel),
      provider: mapToBreakdownBuckets(providerBuckets, capitalizeLabel),
      model: mapToBreakdownBuckets(modelBuckets, (key) => key),
      executionTarget: mapToBreakdownBuckets(executionTargetBuckets, capitalizeLabel),
    },
    velocity: {
      windowDays: daysElapsed,
      dailyAvgRuns: Number((runIds.size / Math.max(daysElapsed, 1)).toFixed(2)),
      dailyAvgMinutes: Number((totalMinutes / Math.max(daysElapsed, 1)).toFixed(2)),
      dailyAvgTokens: Number((totalTokens / Math.max(daysElapsed, 1)).toFixed(2)),
      dailyAvgCostCents: Number((totalCostCents / Math.max(daysElapsed, 1)).toFixed(2)),
    },
  };
}

function collectLocalActivities(
  deps: UsageRoutesDeps<unknown>,
  input: { sinceIso: string; untilIso: string }
): LiveActivityItem[] {
  const merged: LiveActivityItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const result = deps.listActivityPage({
      limit: PAGE_LIMIT,
      since: input.sinceIso,
      until: input.untilIso,
      cursor,
    });
    if (Array.isArray(result.activities) && result.activities.length > 0) {
      merged.push(...result.activities);
    }
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return merged;
}

async function resolveUsageSummary(
  deps: UsageRoutesDeps<unknown>
): Promise<LocalUsageResult> {
  try {
    const summary = await deps.client.getUsageControlPlaneSummary();
    return {
      summary,
      source: "cloud",
      warnings: [],
    };
  } catch (err: unknown) {
    const warnings: string[] = [
      `Cloud usage endpoint unavailable (${deps.safeErrorMessage(err)}). Showing local estimate.`,
    ];
    const now = deps.now ? deps.now() : new Date();
    const periodStart = startOfMonthUtc(now);
    const periodEnd = startOfNextMonthUtc(now);
    const activities = collectLocalActivities(deps, {
      sinceIso: periodStart.toISOString(),
      untilIso: periodEnd.toISOString(),
    });
    const summary = buildLocalSummary({
      activities,
      periodStart,
      periodEnd,
      now,
      warnings,
    });
    return {
      summary,
      source: "local_estimate",
      warnings,
    };
  }
}

export function registerUsageRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: UsageRoutesDeps<TRes>
): void {
  router.add(
    "GET",
    "usage/control-plane/summary",
    async ({ res }) => {
      const resolved = await resolveUsageSummary(deps as UsageRoutesDeps<unknown>);
      deps.sendJson(res, 200, {
        ...resolved.summary,
        source: resolved.source,
        warnings: resolved.warnings,
      });
    },
    "Usage control-plane summary"
  );

  router.add(
    "GET",
    "usage/unified",
    async ({ res }) => {
      const resolved = await resolveUsageSummary(deps as UsageRoutesDeps<unknown>);
      deps.sendJson(res, 200, {
        generatedAt: resolved.summary.generatedAt,
        period: resolved.summary.period,
        plan: resolved.summary.plan,
        actual: resolved.summary.actual,
        predicted: resolved.summary.predicted,
        headroom: resolved.summary.headroom,
        utilization: resolved.summary.utilization,
        risk: resolved.summary.risk,
        breakdown: resolved.summary.breakdown,
        velocity: resolved.summary.velocity,
        source: resolved.source,
        warnings: resolved.warnings,
      });
    },
    "Usage unified summary"
  );

  router.add(
    "GET",
    "usage/forecast",
    async ({ res }) => {
      const resolved = await resolveUsageSummary(deps as UsageRoutesDeps<unknown>);
      deps.sendJson(res, 200, {
        generatedAt: resolved.summary.generatedAt,
        period: resolved.summary.period,
        predicted: resolved.summary.predicted,
        risk: resolved.summary.risk,
        headroom: resolved.summary.headroom,
        utilization: resolved.summary.utilization,
        source: resolved.source,
        warnings: resolved.warnings,
      });
    },
    "Usage forecast summary"
  );

  router.add(
    "*",
    "usage/control-plane/summary",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for usage/control-plane/summary"
  );
  router.add(
    "*",
    "usage/unified",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for usage/unified"
  );
  router.add(
    "*",
    "usage/forecast",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for usage/forecast"
  );
}
