import { listBuiltInSentinels } from "../helpers/sentinel-catalog.js";
import {
  resolveWorkspaceScope,
  workspaceScopeFromHeaders,
} from "../helpers/workspace-scope.js";
import type { Router } from "../router.js";

type AutoContinueRunRecord = {
  id?: string;
  initiativeId?: string;
  status?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  tokenBudget?: number | null;
  maxParallelSlices?: number;
  parallelMode?: string;
  activeSliceRunIds?: string[];
  activeTaskIds?: string[];
  laneByWorkstreamId?: Record<string, unknown>;
  tickMs?: number;
};

type NextUpQueueItem = {
  initiativeId: string;
  initiativeTitle: string;
  initiativeStatus: string;
  initiativePriority?: string | null;
  initiativePriorityNum?: number | null;
  workstreamId: string;
  workstreamTitle: string;
  workstreamStatus: string;
  nextTaskId: string | null;
  nextTaskTitle: string | null;
  nextTaskPriority: number | null;
  nextTaskDueAt: string | null;
  nextTaskMilestoneId?: string | null;
  runnerAgentId?: string | null;
  runnerAgentName?: string | null;
  runnerAgents?: SliceRunnerAgent[];
  runnerSource?: "assigned" | "inferred" | "fallback";
  queueState: "queued" | "running" | "blocked" | "idle" | "completed";
  blockReason?: string | null;
  sliceScope?: "task" | "milestone" | "workstream" | null;
  sliceTaskIds?: string[];
  sliceTaskCount?: number | null;
  sliceMilestoneId?: string | null;
  isPinned?: boolean;
  pinnedRank?: number | null;
  compositeScore?: number;
  scoringTier?: "urgent" | "ready" | "waiting" | "deferred";
  updatedAt?: string | null;
};

type SliceRunnerAgent = {
  id: string;
  name: string;
};

type NextUpQueue = {
  items: NextUpQueueItem[];
  degraded: string[];
};

type SliceViewScope = "initiative" | "workstream" | "milestone" | "task";
type SliceViewOrder = "iwmt" | "priority" | "due" | "updated";

type SliceViewItem = {
  id: string;
  scope: SliceViewScope;
  initiativeId: string;
  initiativeTitle: string;
  workstreamId: string | null;
  workstreamTitle: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  queueState: "queued" | "running" | "blocked" | "idle" | "completed";
  sourceWorkstreamIds: string[];
  runnerAgentId: string | null;
  runnerAgentName: string | null;
  runnerAgents: SliceRunnerAgent[];
  runnerSource: "assigned" | "inferred" | "fallback";
  nextTaskId: string | null;
  nextTaskTitle: string | null;
  nextTaskPriority: number | null;
  nextTaskDueAt: string | null;
  updatedAt: string | null;
  sliceTaskIds: string[];
  sliceTaskCount: number;
  compositeScore?: number;
  scoringTier?: "urgent" | "ready" | "waiting" | "deferred";
  iwmtRank: number;
};

type GraphTaskNode = {
  id: string;
  title: string;
  status: string | null;
  milestoneId: string | null;
  workstreamId: string | null;
  priorityNum: number | null;
  dueDate: string | null;
  updatedAt: string | null;
};

type InitiativeGraphIndex = {
  tasksById: Map<string, GraphTaskNode>;
  milestoneTitleById: Map<string, string>;
};

type RegisterMissionControlReadRoutesDeps<TRes> = {
  autoContinueRuns: Map<string, AutoContinueRunRecord>;
  defaultAutoContinueTokenBudget: () => number | null;
  defaultAutoContinueMaxParallelSlices?: () => number;
  autoContinueTickMs: number;
  buildMissionControlGraph: (initiativeId: string) => Promise<unknown>;
  applyLocalInitiativeOverrideToGraph: (graph: unknown) => unknown;
  listInitiativeIdsForProject: (input: { projectId: string }) => Promise<string[]>;
  buildNextUpQueue: (input: {
    initiativeId: string | null;
    projectId?: string | null;
  }) => Promise<NextUpQueue>;
  rawRequest?: (
    requestMethod: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    requestPath: string,
    body?: unknown
  ) => Promise<unknown>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRunnerValue(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "undefined" || normalized === "null") return null;
  if (normalized === "main" || normalized === "unassigned") return null;
  if (normalized === "n/a" || normalized === "na") return null;
  return raw.trim();
}

function normalizeRunnerSource(
  value: unknown
): "assigned" | "inferred" | "fallback" | null {
  const raw = asString(value);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "assigned") return "assigned";
  if (normalized === "inferred") return "inferred";
  if (normalized === "fallback") return "fallback";
  return null;
}

function normalizeRunnerAgents(value: unknown): SliceRunnerAgent[] {
  if (!Array.isArray(value)) return [];
  const output: SliceRunnerAgent[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = normalizeRunnerValue(record.id);
    const name = normalizeRunnerValue(record.name);
    if (!id && !name) continue;
    const resolvedId = id ?? (name as string);
    const key = resolvedId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      id: resolvedId,
      name: name ?? resolvedId,
    });
  }
  return output;
}

function mergeRunnerAgents(...groups: SliceRunnerAgent[][]): SliceRunnerAgent[] {
  const output: SliceRunnerAgent[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const agent of group) {
      const id = normalizeRunnerValue(agent.id);
      const name = normalizeRunnerValue(agent.name);
      if (!id && !name) continue;
      const resolvedId = id ?? (name as string);
      const key = resolvedId.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        id: resolvedId,
        name: name ?? resolvedId,
      });
    }
  }
  return output;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const entry of value) {
    const normalized = asString(entry);
    if (!normalized) continue;
    values.push(normalized);
  }
  return dedupeStrings(values);
}

function isCanonicalAllScopeMismatch(
  canonicalRecord: Record<string, unknown>,
  useAllScope: boolean
): boolean {
  if (!useAllScope) return false;
  const workspaceRaw =
    asString(canonicalRecord.workspaceId) ??
    asString(canonicalRecord.workspace_id);
  if (!workspaceRaw) return false;
  const normalized = workspaceRaw.trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== "all" && normalized !== "__all__" && normalized !== "*";
}

function dedupeStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInt(value: string | null, fallback: number, max = 300): number {
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, parsed));
}

function normalizeSliceSearchTerm(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function extractSliceSearchText(item: unknown): string {
  const record = asRecord(item);
  if (!record) return "";
  const candidates = [
    asString(record.sliceId),
    asString(record.id),
    asString(record.title),
    asString(record.initiativeTitle),
    asString(record.workstreamTitle),
    asString(record.milestoneTitle),
    asString(record.taskTitle),
    asString(record.initiativeId),
    asString(record.workstreamId),
    asString(record.milestoneId),
    asString(record.taskId),
    asString(record.scope),
    asString(record.level),
  ].filter((entry): entry is string => Boolean(entry));
  return candidates.join(" ").toLowerCase();
}

function applySliceSearchAndPagination<T>(input: {
  items: T[];
  searchTerm: string;
  offset: number;
  limit: number;
}): {
  filtered: T[];
  paged: T[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
} {
  const filtered =
    input.searchTerm.length === 0
      ? input.items
      : input.items.filter((item) =>
          extractSliceSearchText(item).includes(input.searchTerm)
        );
  const offset = Math.max(0, input.offset);
  const paged = filtered.slice(offset, offset + input.limit);
  const nextOffset = offset + input.limit;
  const hasMore = nextOffset < filtered.length;
  return {
    filtered,
    paged,
    pagination: {
      offset,
      limit: input.limit,
      total: filtered.length,
      nextCursor: hasMore ? String(nextOffset) : null,
      hasMore,
    },
  };
}

function parsePaginationEnvelope(
  value: unknown,
  fallback: { offset: number; limit: number; total: number }
): {
  offset: number;
  limit: number;
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
} {
  const record = asRecord(value);
  const offset = Math.max(
    0,
    Math.min(
      100_000,
      Math.floor(asNumber(record?.offset) ?? fallback.offset)
    )
  );
  const limit = Math.max(
    1,
    Math.min(300, Math.floor(asNumber(record?.limit) ?? fallback.limit))
  );
  const total = Math.max(
    0,
    Math.floor(asNumber(record?.total) ?? fallback.total)
  );
  const nextCursor = asString(record?.nextCursor);
  const hasMore =
    typeof record?.hasMore === "boolean"
      ? record.hasMore
      : offset + limit < total;
  return { offset, limit, total, nextCursor, hasMore };
}

const WARMUP_MIN_INTERVAL_MS = 12_000;
const NEXT_UP_DEFAULT_PAGE_SIZE = 24;
const SLICES_DEFAULT_PAGE_SIZE = 24;
const CANONICAL_NEXT_UP_TIMEOUT_MS = 1_800;
const CANONICAL_SLICES_TIMEOUT_MS = 1_200;
const CANONICAL_READ_CACHE_TTL_MS = 9_000;
const CANONICAL_READ_STALE_TTL_MS = 45_000;
const CANONICAL_AUTH_BYPASS_MS = 60_000;
const CANONICAL_TIMEOUT_BYPASS_MS = 12_000;
const warmupByKey = new Map<string, number>();
const canonicalReadCache = new Map<
  string,
  {
    expiresAt: number;
    staleUntil: number;
    payload: Record<string, unknown>;
  }
>();
const canonicalBypassState = new Map<
  "next-up" | "slices",
  { until: number; reason: string }
>();

function shouldRunWarmup(key: string): boolean {
  const now = Date.now();
  const previous = warmupByKey.get(key);
  if (typeof previous === "number" && now - previous < WARMUP_MIN_INTERVAL_MS) {
    return false;
  }
  warmupByKey.set(key, now);
  return true;
}

function canonicalReadCacheKey(input: {
  route: "next-up" | "slices";
  workspaceId: string | null;
  initiativeId: string | null;
  includeCompleted: boolean;
  offset: number;
  limit: number;
  scope?: string | null;
  order?: string | null;
  mixPolicy?: string | null;
  search?: string | null;
}): string {
  return [
    input.route,
    input.workspaceId ?? "__all__",
    input.initiativeId ?? "__any__",
    input.includeCompleted ? "include_completed" : "exclude_completed",
    String(input.offset),
    String(input.limit),
    input.scope ?? "__none__",
    input.order ?? "__none__",
    input.mixPolicy ?? "__none__",
    input.search ?? "__none__",
  ].join("|");
}

function cloneCanonicalReadPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...payload };
  if (Array.isArray(payload.items)) clone.items = [...payload.items];
  if (Array.isArray(payload.degraded)) clone.degraded = [...payload.degraded];
  const pagination = asRecord(payload.pagination);
  if (pagination) clone.pagination = { ...pagination };
  return clone;
}

function readCanonicalReadCache(
  key: string,
  opts?: { allowStale?: boolean }
): Record<string, unknown> | null {
  const cached = canonicalReadCache.get(key);
  if (!cached) return null;
  const now = Date.now();
  const allowStale = Boolean(opts?.allowStale);
  const stillFresh = cached.expiresAt > now;
  const stillStale = cached.staleUntil > now;
  if (!stillFresh && !stillStale) {
    canonicalReadCache.delete(key);
    return null;
  }
  if (!stillFresh && !allowStale) return null;
  return cloneCanonicalReadPayload(cached.payload);
}

function writeCanonicalReadCache(
  key: string,
  payload: Record<string, unknown>
): void {
  const now = Date.now();
  canonicalReadCache.set(key, {
    expiresAt: now + CANONICAL_READ_CACHE_TTL_MS,
    staleUntil: now + CANONICAL_READ_STALE_TTL_MS,
    payload: cloneCanonicalReadPayload(payload),
  });
}

function readCanonicalBypass(
  route: "next-up" | "slices"
): { reason: string } | null {
  const record = canonicalBypassState.get(route);
  if (!record) return null;
  if (record.until <= Date.now()) {
    canonicalBypassState.delete(route);
    return null;
  }
  return { reason: record.reason };
}

function setCanonicalBypass(
  route: "next-up" | "slices",
  reason: string,
  durationMs: number
): void {
  canonicalBypassState.set(route, {
    until: Date.now() + Math.max(1_000, durationMs),
    reason,
  });
}

function isCanonicalAuthFailure(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error ?? ""
  ).toLowerCase();
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("authentication required")
  );
}

function isCanonicalTimeoutFailure(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error ?? ""
  ).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

async function withSoftTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldRetryLegacyCanonicalPath(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error ?? ""
  ).toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("unknown api endpoint")
  );
}

async function requestCanonicalWithLegacyFallback(
  deps: RegisterMissionControlReadRoutesDeps<any>,
  input: {
    timeoutMs: number;
    label: string;
    modernPath: string;
    legacyPath: string;
  }
): Promise<unknown> {
  try {
    return await withSoftTimeout(
      deps.rawRequest!("GET", input.modernPath),
      input.timeoutMs,
      input.label
    );
  } catch (error) {
    if (!shouldRetryLegacyCanonicalPath(error)) throw error;
  }
  return await withSoftTimeout(
    deps.rawRequest!("GET", input.legacyPath),
    Math.min(input.timeoutMs, 1_500),
    `${input.label} (legacy fallback)`
  );
}

function normalizeQueueState(value: unknown): NextUpQueueItem["queueState"] {
  const normalized = (asString(value) ?? "").toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "queued") return "queued";
  if (normalized === "blocked") return "blocked";
  if (normalized === "completed") return "completed";
  return "idle";
}

function normalizeStatus(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isDoneStatus(value: string | null | undefined): boolean {
  const normalized = normalizeStatus(value);
  return (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "resolved" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "archived" ||
    normalized === "closed"
  );
}

function queueStateRank(state: NextUpQueueItem["queueState"]): number {
  if (state === "running") return 0;
  if (state === "queued") return 1;
  if (state === "blocked") return 2;
  if (state === "idle") return 3;
  return 4;
}

function combinedQueueState(states: NextUpQueueItem["queueState"][]): NextUpQueueItem["queueState"] {
  if (states.some((state) => state === "running")) return "running";
  if (states.some((state) => state === "blocked")) return "blocked";
  if (states.some((state) => state === "queued")) return "queued";
  if (states.some((state) => state === "idle")) return "idle";
  return "completed";
}

function dueEpoch(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function updatedEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSliceScope(value: string | null): SliceViewScope {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "initiative") return "initiative";
  if (normalized === "milestone") return "milestone";
  if (normalized === "task") return "task";
  return "workstream";
}

function parseSliceOrder(value: string | null): SliceViewOrder {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "priority") return "priority";
  if (normalized === "due") return "due";
  if (normalized === "updated") return "updated";
  return "iwmt";
}

function sortSlices(items: SliceViewItem[], order: SliceViewOrder): SliceViewItem[] {
  return [...items].sort((left, right) => {
    if (order === "priority") {
      const leftPriority = left.nextTaskPriority ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = right.nextTaskPriority ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (order === "due") {
      const leftDue = dueEpoch(left.nextTaskDueAt);
      const rightDue = dueEpoch(right.nextTaskDueAt);
      if (leftDue !== rightDue) return leftDue - rightDue;
    } else if (order === "updated") {
      const leftUpdated = updatedEpoch(left.updatedAt);
      const rightUpdated = updatedEpoch(right.updatedAt);
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    }

    const iwmtDelta = left.iwmtRank - right.iwmtRank;
    if (iwmtDelta !== 0) return iwmtDelta;

    const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
    if (queueDelta !== 0) return queueDelta;

    const initiativeDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
    if (initiativeDelta !== 0) return initiativeDelta;

    const workstreamDelta = (left.workstreamTitle ?? "").localeCompare(right.workstreamTitle ?? "");
    if (workstreamDelta !== 0) return workstreamDelta;

    return left.id.localeCompare(right.id);
  });
}

function normalizeQueueItems(input: unknown[]): NextUpQueueItem[] {
  const output: NextUpQueueItem[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) continue;
    const initiativeId = asString(record.initiativeId);
    const workstreamId = asString(record.workstreamId);
    if (!initiativeId || !workstreamId) continue;

    const nextTaskId = asString(record.nextTaskId);
    const sliceTaskIds = dedupeStrings([
      ...asStringArray(record.sliceTaskIds),
      ...(nextTaskId ? [nextTaskId] : []),
    ]);
    const runnerAgentsRaw = normalizeRunnerAgents(record.runnerAgents);
    const runnerAgentIdRaw = normalizeRunnerValue(record.runnerAgentId);
    const runnerAgentNameRaw =
      normalizeRunnerValue(record.runnerAgentName) ??
      normalizeRunnerValue(record.agentName) ??
      normalizeRunnerValue(record.runner);
    const runnerAgents = mergeRunnerAgents(
      runnerAgentsRaw,
      runnerAgentIdRaw || runnerAgentNameRaw
        ? [
            {
              id: runnerAgentIdRaw ?? runnerAgentNameRaw ?? "Unassigned",
              name: runnerAgentNameRaw ?? runnerAgentIdRaw ?? "Unassigned",
            },
          ]
        : []
    );
    const runnerPrimary = runnerAgents[0] ?? null;
    const runnerAgentId = runnerPrimary?.id ?? null;
    const runnerAgentName = runnerPrimary?.name ?? "Unassigned";
    const runnerSourceHint = normalizeRunnerSource(record.runnerSource);
    const runnerSource = runnerSourceHint ?? (runnerAgentId ? "inferred" : "fallback");
    const queueState = normalizeQueueState(record.queueState);
    const blockReason =
      asString(record.blockReason) ??
      (queueState === "blocked"
        ? `Waiting on dependency ${asString(record.nextTaskTitle) ?? asString(record.nextTaskId) ?? "task"}`
        : null);

    output.push({
      initiativeId,
      initiativeTitle: asString(record.initiativeTitle) ?? initiativeId,
      initiativeStatus: asString(record.initiativeStatus) ?? "active",
      initiativePriority: asString(record.initiativePriority),
      initiativePriorityNum: asNumber(record.initiativePriorityNum),
      workstreamId,
      workstreamTitle: asString(record.workstreamTitle) ?? workstreamId,
      workstreamStatus: asString(record.workstreamStatus) ?? "active",
      nextTaskId,
      nextTaskTitle: asString(record.nextTaskTitle),
      nextTaskPriority: asNumber(record.nextTaskPriority),
      nextTaskDueAt: asString(record.nextTaskDueAt),
      nextTaskMilestoneId: asString(record.nextTaskMilestoneId),
      runnerAgentId,
      runnerAgentName,
      runnerAgents,
      runnerSource,
      queueState,
      blockReason,
      sliceScope:
        asString(record.sliceScope) === "task" ||
        asString(record.sliceScope) === "milestone" ||
        asString(record.sliceScope) === "workstream"
          ? (asString(record.sliceScope) as "task" | "milestone" | "workstream")
          : null,
      sliceTaskIds,
      sliceTaskCount:
        typeof record.sliceTaskCount === "number"
          ? Math.max(0, Math.floor(record.sliceTaskCount))
          : sliceTaskIds.length,
      sliceMilestoneId: asString(record.sliceMilestoneId),
      isPinned: Boolean(record.isPinned),
      pinnedRank: asNumber(record.pinnedRank),
      compositeScore: asNumber(record.compositeScore) ?? undefined,
      scoringTier:
        asString(record.scoringTier) === "urgent" ||
        asString(record.scoringTier) === "ready" ||
        asString(record.scoringTier) === "waiting" ||
        asString(record.scoringTier) === "deferred"
          ? (asString(record.scoringTier) as "urgent" | "ready" | "waiting" | "deferred")
          : undefined,
      updatedAt: asString(record.updatedAt) ?? null,
    });
  }

  return output.sort((left, right) => {
    const pinnedLeft = left.isPinned ? 0 : 1;
    const pinnedRight = right.isPinned ? 0 : 1;
    if (pinnedLeft !== pinnedRight) return pinnedLeft - pinnedRight;
    if (pinnedLeft === 0) {
      const rankDelta =
        (left.pinnedRank ?? Number.MAX_SAFE_INTEGER) -
        (right.pinnedRank ?? Number.MAX_SAFE_INTEGER);
      if (rankDelta !== 0) return rankDelta;
    }
    const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
    if (queueDelta !== 0) return queueDelta;
    const priorityDelta =
      (left.nextTaskPriority ?? Number.MAX_SAFE_INTEGER) -
      (right.nextTaskPriority ?? Number.MAX_SAFE_INTEGER);
    if (priorityDelta !== 0) return priorityDelta;
    const initiativePriorityDelta =
      (left.initiativePriorityNum ?? Number.MAX_SAFE_INTEGER) -
      (right.initiativePriorityNum ?? Number.MAX_SAFE_INTEGER);
    if (initiativePriorityDelta !== 0) return initiativePriorityDelta;
    const dueDelta = dueEpoch(left.nextTaskDueAt) - dueEpoch(right.nextTaskDueAt);
    if (dueDelta !== 0) return dueDelta;
    const titleDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
    if (titleDelta !== 0) return titleDelta;
    return left.workstreamTitle.localeCompare(right.workstreamTitle);
  });
}

async function loadInitiativeGraphIndex(
  deps: RegisterMissionControlReadRoutesDeps<any>,
  initiativeId: string
): Promise<InitiativeGraphIndex> {
  const graphRaw = deps.applyLocalInitiativeOverrideToGraph(
    await deps.buildMissionControlGraph(initiativeId)
  );
  const graph = asRecord(graphRaw);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const tasksById = new Map<string, GraphTaskNode>();
  const milestoneTitleById = new Map<string, string>();

  for (const nodeEntry of nodes) {
    const node = asRecord(nodeEntry);
    if (!node) continue;
    const id = asString(node.id);
    const type = asString(node.type);
    if (!id || !type) continue;
    if (type === "milestone") {
      milestoneTitleById.set(id, asString(node.title) ?? id);
      continue;
    }
    if (type !== "task") continue;
    tasksById.set(id, {
      id,
      title: asString(node.title) ?? id,
      status: asString(node.status),
      milestoneId: asString(node.milestoneId),
      workstreamId: asString(node.workstreamId),
      priorityNum: asNumber(node.priorityNum),
      dueDate: asString(node.dueDate),
      updatedAt: asString(node.updatedAt),
    });
  }

  return {
    tasksById,
    milestoneTitleById,
  };
}

export function registerMissionControlReadRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterMissionControlReadRoutesDeps<TRes>
): void {
  const sendRouteError = (
    res: TRes,
    status: number,
    location: string,
    error: string,
    extra: Record<string, unknown> = {}
  ) => {
    deps.sendJson(res, status, {
      ok: false,
      error,
      error_location: location,
      ...extra,
    });
  };

  const sendRouteException = (res: TRes, location: string, err: unknown) => {
    sendRouteError(res, 500, location, deps.safeErrorMessage(err));
  };

  async function renderAutoContinueStatus(query: URLSearchParams, res: TRes): Promise<void> {
    const initiativeId = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const id = initiativeId.trim();
    if (!id) {
      sendRouteError(
        res,
        400,
        "mission-control.read.auto-continue.status.validation",
        "Query parameter 'initiative_id' is required."
      );
      return;
    }

    const run = deps.autoContinueRuns.get(id) ?? null;
    deps.sendJson(res, 200, {
      ok: true,
      initiativeId: id,
      run,
      defaults: {
        tokenBudget: deps.defaultAutoContinueTokenBudget(),
        maxParallelSlices:
          typeof deps.defaultAutoContinueMaxParallelSlices === "function"
            ? deps.defaultAutoContinueMaxParallelSlices()
            : 1,
        tickMs: deps.autoContinueTickMs,
      },
    });
  }

  async function renderMissionControlGraph(
    query: URLSearchParams,
    res: TRes
  ): Promise<void> {
    const initiativeId = query.get("initiative_id") ?? query.get("initiativeId");
    if (!initiativeId || initiativeId.trim().length === 0) {
      sendRouteError(
        res,
        400,
        "mission-control.read.graph.validation",
        "Query parameter 'initiative_id' is required."
      );
      return;
    }

    try {
      const graph = deps.applyLocalInitiativeOverrideToGraph(
        await deps.buildMissionControlGraph(initiativeId.trim())
      );
      deps.sendJson(res, 200, graph);
    } catch (err: unknown) {
      sendRouteException(res, "mission-control.read.graph.handler", err);
    }
  }

  async function renderNextUpQueue(
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    const initiativeIdRaw = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const initiativeId = initiativeIdRaw.trim() || null;
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (scope.error) {
      sendRouteError(
        res,
        400,
        "mission-control.read.next-up.validation",
        scope.error
      );
      return;
    }
    const projectId = scope.workspaceId;
    const useAllScope = scope.isAll === true;
    const includeCompleted = parseBoolean(query.get("include_completed"));
    const offset = parsePositiveInt(
      query.get("cursor") ?? query.get("offset"),
      0,
      100_000
    );
    const pageSize = parsePositiveInt(
      query.get("page_size") ?? query.get("pageSize") ?? query.get("limit"),
      NEXT_UP_DEFAULT_PAGE_SIZE,
      300
    );
    const requestedSliceLevelContext =
      query.get("slice_level_context") ?? query.get("sliceLevelContext");
    const requestedMixPolicy =
      query.get("mix_policy") ?? query.get("mixPolicy");
    const requestedOrderMode =
      query.get("order_mode") ?? query.get("orderMode");
    const includeLineage = parseBoolean(
      query.get("include_lineage") ?? query.get("includeLineage")
    );
    const nextUpCanonicalCacheKey = canonicalReadCacheKey({
      route: "next-up",
      workspaceId: projectId,
      initiativeId,
      includeCompleted,
      offset,
      limit: pageSize,
      scope: requestedSliceLevelContext,
      order: requestedOrderMode,
      mixPolicy: requestedMixPolicy,
      search: includeLineage ? "lineage:1" : null,
    });

    const cachedCanonicalNextUp = readCanonicalReadCache(nextUpCanonicalCacheKey, {
      allowStale: false,
    });
    if (cachedCanonicalNextUp) {
      deps.sendJson(res, 200, cachedCanonicalNextUp);
      return;
    }
    const canonicalBypass = readCanonicalBypass("next-up");
    let canonicalFallbackReason: string | null = canonicalBypass
      ? `canonical next-up bypassed (${canonicalBypass.reason})`
      : null;

    if (deps.rawRequest && !canonicalBypass) {
      try {
        const params = new URLSearchParams();
        if (initiativeId) params.set("initiative_id", initiativeId);
        if (projectId) {
          params.set("workspace_id", projectId);
          params.set("command_center_id", projectId);
        } else if (useAllScope) {
          params.set("workspace_id", "all");
          params.set("command_center_id", "all");
        }
        params.set("offset", String(offset));
        params.set("limit", String(pageSize));
        params.set("include_completed", includeCompleted ? "1" : "0");
        if (requestedSliceLevelContext) {
          params.set("slice_level_context", requestedSliceLevelContext);
        }
        if (requestedMixPolicy) params.set("mix_policy", requestedMixPolicy);
        if (requestedOrderMode) params.set("order_mode", requestedOrderMode);
        if (includeLineage) params.set("include_lineage", "1");

        const canonical = await requestCanonicalWithLegacyFallback(deps, {
          timeoutMs: CANONICAL_NEXT_UP_TIMEOUT_MS,
          label: "canonical next-up",
          modernPath: `/api/client/mission-control/next-up?${params.toString()}`,
          legacyPath: `/api/mission-control/next-up?${params.toString()}`,
        });
        const canonicalRecord = asRecord(canonical);
        if (!canonicalRecord || !Array.isArray(canonicalRecord.items)) {
          throw new Error("invalid canonical next-up payload");
        }
        if (isCanonicalAllScopeMismatch(canonicalRecord, useAllScope)) {
          throw new Error("canonical next-up all-workspaces scope mismatch");
        }

        const canonicalItems = normalizeQueueItems(canonicalRecord.items).filter((item) =>
          includeCompleted ? true : item.queueState !== "completed"
        );
        const canonicalTotal =
          Math.max(
            canonicalItems.length,
            Math.floor(asNumber(canonicalRecord.total) ?? canonicalItems.length)
          ) ?? canonicalItems.length;
        const canonicalPagination = parsePaginationEnvelope(canonicalRecord.pagination, {
          offset,
          limit: pageSize,
          total: canonicalTotal,
        });
        const shouldRepaginateCanonically =
          canonicalItems.length > pageSize ||
          canonicalPagination.offset !== offset ||
          canonicalPagination.limit !== pageSize;
        const paged = shouldRepaginateCanonically
          ? applySliceSearchAndPagination({
              items: canonicalItems,
              searchTerm: "",
              offset,
              limit: pageSize,
            })
          : null;
        const degraded = dedupeStrings(
          asStringArray(canonicalRecord.degraded)
        );
        const responsePayload: Record<string, unknown> = {
          ok: true,
          generatedAt:
            asString(canonicalRecord.generatedAt) ?? new Date().toISOString(),
          total: paged ? paged.filtered.length : canonicalPagination.total,
          items: paged ? paged.paged : canonicalItems,
          pagination: paged ? paged.pagination : canonicalPagination,
          source: "canonical",
          degraded,
        };
        writeCanonicalReadCache(nextUpCanonicalCacheKey, responsePayload);
        deps.sendJson(res, 200, responsePayload);

        const paginationForWarmup = paged ? paged.pagination : canonicalPagination;
        if (paginationForWarmup.hasMore && paginationForWarmup.nextCursor && shouldRunWarmup(
          `next-up:${projectId ?? "__all__"}:${initiativeId ?? "__all__"}:${paginationForWarmup.nextCursor}:${pageSize}`
        )) {
          const nextOffset = parsePositiveInt(
            paginationForWarmup.nextCursor,
            offset + pageSize,
            100_000
          );
          const warmParams = new URLSearchParams(params);
          warmParams.set("offset", String(nextOffset));
          warmParams.set("limit", String(pageSize));
          void requestCanonicalWithLegacyFallback(deps, {
            timeoutMs: CANONICAL_NEXT_UP_TIMEOUT_MS,
            label: "canonical next-up warmup",
            modernPath: `/api/client/mission-control/next-up?${warmParams.toString()}`,
            legacyPath: `/api/mission-control/next-up?${warmParams.toString()}`,
          }).catch(() => undefined);
        }
        if (
          offset === 0 &&
          shouldRunWarmup(
            `next-up->slices:${projectId ?? "__all__"}:${initiativeId ?? "__all__"}:${pageSize}`
          )
        ) {
          const warmSlicesParams = new URLSearchParams();
          if (initiativeId) warmSlicesParams.set("initiative_id", initiativeId);
          if (projectId) {
            warmSlicesParams.set("workspace_id", projectId);
            warmSlicesParams.set("command_center_id", projectId);
          } else if (useAllScope) {
            warmSlicesParams.set("workspace_id", "all");
            warmSlicesParams.set("command_center_id", "all");
          }
          warmSlicesParams.set("level", "initiative");
          warmSlicesParams.set("include_completed", includeCompleted ? "1" : "0");
          warmSlicesParams.set("offset", "0");
          warmSlicesParams.set(
            "limit",
            String(Math.max(SLICES_DEFAULT_PAGE_SIZE, Math.min(pageSize, 300)))
          );
          void requestCanonicalWithLegacyFallback(deps, {
            timeoutMs: CANONICAL_SLICES_TIMEOUT_MS,
            label: "canonical slices warmup",
            modernPath: `/api/client/mission-control/slices?${warmSlicesParams.toString()}`,
            legacyPath: `/api/mission-control/slices?${warmSlicesParams.toString()}`,
          }).catch(() => undefined);
        }
        return;
      } catch (err: unknown) {
        if (isCanonicalAuthFailure(err)) {
          setCanonicalBypass("next-up", "authentication unavailable", CANONICAL_AUTH_BYPASS_MS);
        } else if (isCanonicalTimeoutFailure(err)) {
          setCanonicalBypass("next-up", "upstream timeout", CANONICAL_TIMEOUT_BYPASS_MS);
        }
        const staleCanonical = readCanonicalReadCache(nextUpCanonicalCacheKey, {
          allowStale: true,
        });
        if (staleCanonical) {
          const staleDegraded = dedupeStrings([
            ...asStringArray(staleCanonical.degraded),
            "Using cached canonical queue while sync recovers.",
          ]);
          deps.sendJson(res, 200, {
            ...staleCanonical,
            degraded: staleDegraded,
            source: "canonical_cache_stale",
          });
          return;
        }
        canonicalFallbackReason = `canonical next-up unavailable (${deps.safeErrorMessage(err)})`;
        // Continue to local fallback.
        try {
          const queue = await deps.buildNextUpQueue({
            initiativeId,
            projectId,
          });
          const items = normalizeQueueItems(queue.items ?? []).filter((item) =>
            includeCompleted ? true : item.queueState !== "completed"
          );
          const paged = applySliceSearchAndPagination({
            items,
            searchTerm: "",
            offset,
            limit: pageSize,
          });
          const degraded = dedupeStrings([
            ...(Array.isArray(queue.degraded) ? queue.degraded : []),
            ...(canonicalFallbackReason ? [canonicalFallbackReason] : []),
          ]);
          deps.sendJson(res, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            total: paged.filtered.length,
            items: paged.paged,
            pagination: paged.pagination,
            source: "local_fallback",
            degraded,
          });
          return;
        } catch (fallbackErr: unknown) {
          sendRouteException(
            res,
            "mission-control.read.next-up.handler",
            fallbackErr
          );
          return;
        }
      }
    }

    try {
      const queue = await deps.buildNextUpQueue({
        initiativeId,
        projectId,
      });
      const items = normalizeQueueItems(queue.items ?? []).filter((item) =>
        includeCompleted ? true : item.queueState !== "completed"
      );
      const paged = applySliceSearchAndPagination({
        items,
        searchTerm: "",
        offset,
        limit: pageSize,
      });
      const degraded = dedupeStrings(
        [
          ...(Array.isArray(queue.degraded) ? queue.degraded : []),
          ...(canonicalFallbackReason ? [canonicalFallbackReason] : []),
        ]
      );
      deps.sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        total: paged.filtered.length,
        items: paged.paged,
        pagination: paged.pagination,
        source: "local",
        degraded: dedupeStrings(degraded),
      });
    } catch (err: unknown) {
      sendRouteException(res, "mission-control.read.next-up.handler", err);
    }
  }

  async function renderSliceProjection(
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    const initiativeIdRaw = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const initiativeId = initiativeIdRaw.trim() || null;
    const workspaceScope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (workspaceScope.error) {
      sendRouteError(
        res,
        400,
        "mission-control.read.slices.validation",
        workspaceScope.error
      );
      return;
    }
    const projectId = workspaceScope.workspaceId;
    const useAllScope = workspaceScope.isAll === true;
    const includeCompleted = parseBoolean(query.get("include_completed"));
    const sliceScope = parseSliceScope(query.get("scope") ?? query.get("level"));
    const order = parseSliceOrder(query.get("order"));
    const searchTerm = normalizeSliceSearchTerm(
      query.get("q") ?? query.get("search")
    );
    const offset = parsePositiveInt(
      query.get("cursor") ?? query.get("offset"),
      0,
      100_000
    );
    const pageSize = parsePositiveInt(
      query.get("page_size") ?? query.get("pageSize") ?? query.get("limit"),
      SLICES_DEFAULT_PAGE_SIZE,
      300
    );
    const requestedMixPolicy =
      query.get("mix_policy") ?? query.get("mixPolicy") ?? "iwmt_v1";
    const requestedOrderMode =
      query.get("order_mode") ?? query.get("orderMode");
    const slicesCanonicalCacheKey = canonicalReadCacheKey({
      route: "slices",
      workspaceId: projectId,
      initiativeId,
      includeCompleted,
      offset,
      limit: pageSize,
      scope: sliceScope,
      order: requestedOrderMode ?? order,
      mixPolicy: requestedMixPolicy,
      search: searchTerm || null,
    });

    const cachedCanonicalSlices = readCanonicalReadCache(slicesCanonicalCacheKey, {
      allowStale: false,
    });
    if (cachedCanonicalSlices) {
      deps.sendJson(res, 200, cachedCanonicalSlices);
      return;
    }

    const canonicalBypass = readCanonicalBypass("slices");
    let canonicalFallbackReason: string | null = canonicalBypass
      ? `canonical slices bypassed (${canonicalBypass.reason})`
      : null;
    if (deps.rawRequest && !canonicalBypass) {
      try {
        const params = new URLSearchParams();
        if (initiativeId) params.set("initiative_id", initiativeId);
        if (projectId) {
          params.set("workspace_id", projectId);
          params.set("command_center_id", projectId);
        } else if (useAllScope) {
          params.set("workspace_id", "all");
          params.set("command_center_id", "all");
        }
        params.set("level", sliceScope);
        params.set("include_completed", includeCompleted ? "1" : "0");
        params.set("mix_policy", requestedMixPolicy);
        if (requestedOrderMode) params.set("order_mode", requestedOrderMode);
        const canonicalSupportsDirectPaging = searchTerm.length === 0;
        if (canonicalSupportsDirectPaging) {
          params.set("offset", String(offset));
          params.set("limit", String(pageSize));
        } else {
          params.set(
            "offset",
            "0"
          );
          params.set(
            "limit",
            String(Math.min(300, Math.max(pageSize + offset, pageSize)))
          );
        }

        const canonical = await requestCanonicalWithLegacyFallback(deps, {
          timeoutMs: CANONICAL_SLICES_TIMEOUT_MS,
          label: "canonical slices",
          modernPath: `/api/client/mission-control/slices?${params.toString()}`,
          legacyPath: `/api/mission-control/slices?${params.toString()}`,
        });
        const canonicalRecord = asRecord(canonical);
        if (!canonicalRecord || !Array.isArray(canonicalRecord.items)) {
          throw new Error("invalid canonical slices payload");
        }
        if (isCanonicalAllScopeMismatch(canonicalRecord, useAllScope)) {
          throw new Error("canonical slices all-workspaces scope mismatch");
        }
        const canonicalItems = canonicalRecord.items;
        const canonicalTotal =
          Math.max(
            canonicalItems.length,
            Math.floor(asNumber(canonicalRecord.total) ?? canonicalItems.length)
          ) ?? canonicalItems.length;
        const canonicalPagination = parsePaginationEnvelope(
          canonicalRecord.pagination,
          {
            offset,
            limit: pageSize,
            total: canonicalTotal,
          }
        );
        const shouldRepaginateCanonically =
          canonicalItems.length > pageSize ||
          canonicalPagination.offset !== offset ||
          canonicalPagination.limit !== pageSize;
        const canonicalPaged = shouldRepaginateCanonically
          ? applySliceSearchAndPagination({
              items: canonicalItems,
              searchTerm: "",
              offset,
              limit: pageSize,
            })
          : null;

        if (searchTerm.length === 0) {
          const responsePayload: Record<string, unknown> = {
            ...canonicalRecord,
            level: asString(canonicalRecord.level) ?? sliceScope,
            scope: asString(canonicalRecord.level) ?? sliceScope,
            order:
              asString(canonicalRecord.orderMode) ??
              asString(canonicalRecord.order) ??
              order,
            total: canonicalPaged ? canonicalPaged.filtered.length : canonicalPagination.total,
            items: canonicalPaged ? canonicalPaged.paged : canonicalItems,
            pagination: canonicalPaged ? canonicalPaged.pagination : canonicalPagination,
            source: "canonical",
          };
          writeCanonicalReadCache(slicesCanonicalCacheKey, responsePayload);
          deps.sendJson(res, 200, responsePayload);
          if (
            offset === 0 &&
            shouldRunWarmup(
              `slices->next-up:${projectId ?? "__all__"}:${initiativeId ?? "__all__"}:${pageSize}`
            )
          ) {
            const warmNextUpParams = new URLSearchParams();
            if (initiativeId) warmNextUpParams.set("initiative_id", initiativeId);
            if (projectId) {
              warmNextUpParams.set("workspace_id", projectId);
              warmNextUpParams.set("command_center_id", projectId);
            } else if (useAllScope) {
              warmNextUpParams.set("workspace_id", "all");
              warmNextUpParams.set("command_center_id", "all");
            }
            warmNextUpParams.set("offset", "0");
            warmNextUpParams.set(
              "limit",
              String(Math.max(NEXT_UP_DEFAULT_PAGE_SIZE, Math.min(pageSize, 300)))
            );
            warmNextUpParams.set("include_completed", includeCompleted ? "1" : "0");
            void requestCanonicalWithLegacyFallback(deps, {
              timeoutMs: CANONICAL_NEXT_UP_TIMEOUT_MS,
              label: "canonical next-up warmup",
              modernPath: `/api/client/mission-control/next-up?${warmNextUpParams.toString()}`,
              legacyPath: `/api/mission-control/next-up?${warmNextUpParams.toString()}`,
            }).catch(() => undefined);
          }
          return;
        }

        const paged = applySliceSearchAndPagination({
          items: canonicalItems,
          searchTerm,
          offset,
          limit: pageSize,
        });
        const responsePayload: Record<string, unknown> = {
          ...canonicalRecord,
          level: asString(canonicalRecord.level) ?? sliceScope,
          scope: asString(canonicalRecord.level) ?? sliceScope,
          order:
            asString(canonicalRecord.orderMode) ??
            asString(canonicalRecord.order) ??
            order,
          total: paged.filtered.length,
          items: paged.paged,
          pagination: paged.pagination,
          source: "canonical",
        };
        writeCanonicalReadCache(slicesCanonicalCacheKey, responsePayload);
        deps.sendJson(res, 200, responsePayload);
        if (
          offset === 0 &&
          shouldRunWarmup(
            `slices->next-up:${projectId ?? "__all__"}:${initiativeId ?? "__all__"}:${pageSize}:search`
          )
        ) {
          const warmNextUpParams = new URLSearchParams();
          if (initiativeId) warmNextUpParams.set("initiative_id", initiativeId);
          if (projectId) {
            warmNextUpParams.set("workspace_id", projectId);
            warmNextUpParams.set("command_center_id", projectId);
          } else if (useAllScope) {
            warmNextUpParams.set("workspace_id", "all");
            warmNextUpParams.set("command_center_id", "all");
          }
          warmNextUpParams.set("offset", "0");
          warmNextUpParams.set(
            "limit",
            String(Math.max(NEXT_UP_DEFAULT_PAGE_SIZE, Math.min(pageSize, 300)))
          );
          warmNextUpParams.set("include_completed", includeCompleted ? "1" : "0");
          void requestCanonicalWithLegacyFallback(deps, {
            timeoutMs: CANONICAL_NEXT_UP_TIMEOUT_MS,
            label: "canonical next-up warmup",
            modernPath: `/api/client/mission-control/next-up?${warmNextUpParams.toString()}`,
            legacyPath: `/api/mission-control/next-up?${warmNextUpParams.toString()}`,
          }).catch(() => undefined);
        }
        return;
      } catch (err: unknown) {
        if (isCanonicalAuthFailure(err)) {
          setCanonicalBypass("slices", "authentication unavailable", CANONICAL_AUTH_BYPASS_MS);
        } else if (isCanonicalTimeoutFailure(err)) {
          setCanonicalBypass("slices", "upstream timeout", CANONICAL_TIMEOUT_BYPASS_MS);
        }
        const staleCanonical = readCanonicalReadCache(slicesCanonicalCacheKey, {
          allowStale: true,
        });
        if (staleCanonical) {
          const staleDegraded = dedupeStrings([
            ...asStringArray(staleCanonical.degraded),
            "Using cached canonical slices while sync recovers.",
          ]);
          deps.sendJson(res, 200, {
            ...staleCanonical,
            degraded: staleDegraded,
            source: "canonical_cache_stale",
          });
          return;
        }
        canonicalFallbackReason = `canonical slices unavailable (${deps.safeErrorMessage(err)})`;
      }
    }

    try {
      const queue = await deps.buildNextUpQueue({
        initiativeId,
        projectId,
      });
      const queueItems = normalizeQueueItems(queue.items ?? []).filter((item) =>
        includeCompleted ? true : item.queueState !== "completed"
      );

      const graphIndexByInitiative = new Map<string, InitiativeGraphIndex>();
      const degraded = dedupeStrings([
        ...(Array.isArray(queue.degraded) ? queue.degraded : []),
        ...(canonicalFallbackReason ? [canonicalFallbackReason] : []),
      ]);
      if (sliceScope === "milestone" || sliceScope === "task") {
        const uniqueInitiatives = dedupeStrings(
          queueItems.map((item) => item.initiativeId)
        );
        for (const id of uniqueInitiatives) {
          try {
            graphIndexByInitiative.set(
              id,
              await loadInitiativeGraphIndex(deps as RegisterMissionControlReadRoutesDeps<any>, id)
            );
          } catch (err: unknown) {
            degraded.push(`graph unavailable for ${id} (${deps.safeErrorMessage(err)})`);
          }
        }
      }

      const slices: SliceViewItem[] = [];

      if (sliceScope === "initiative") {
        const grouped = new Map<
          string,
          {
            base: NextUpQueueItem;
            states: NextUpQueueItem["queueState"][];
            taskIds: Set<string>;
            workstreamIds: Set<string>;
            runnerAgents: SliceRunnerAgent[];
            iwmtRank: number;
          }
        >();
        queueItems.forEach((item, index) => {
          const bucket = grouped.get(item.initiativeId);
          if (!bucket) {
            grouped.set(item.initiativeId, {
              base: item,
              states: [item.queueState],
              taskIds: new Set(item.sliceTaskIds ?? []),
              workstreamIds: new Set([item.workstreamId]),
              runnerAgents: item.runnerAgents ?? [],
              iwmtRank: index,
            });
            return;
          }
          bucket.states.push(item.queueState);
          for (const taskId of item.sliceTaskIds ?? []) bucket.taskIds.add(taskId);
          bucket.workstreamIds.add(item.workstreamId);
          bucket.runnerAgents = mergeRunnerAgents(
            bucket.runnerAgents,
            item.runnerAgents ?? []
          );
          if (index < bucket.iwmtRank) {
            bucket.base = item;
            bucket.iwmtRank = index;
          }
        });

        for (const [initiativeKey, bucket] of grouped.entries()) {
          const runnerAgents = mergeRunnerAgents(
            bucket.runnerAgents,
            bucket.base.runnerAgents ?? []
          );
          const runnerPrimary = runnerAgents[0] ?? null;
          slices.push({
            id: initiativeKey,
            scope: sliceScope,
            initiativeId: bucket.base.initiativeId,
            initiativeTitle: bucket.base.initiativeTitle,
            workstreamId: null,
            workstreamTitle: null,
            milestoneId: null,
            milestoneTitle: null,
            taskId: null,
            taskTitle: null,
            queueState: combinedQueueState(bucket.states),
            sourceWorkstreamIds: Array.from(bucket.workstreamIds.values()),
            runnerAgentId: runnerPrimary?.id ?? null,
            runnerAgentName: runnerPrimary?.name ?? "Unassigned",
            runnerAgents,
            runnerSource:
              bucket.base.runnerSource ??
              (runnerPrimary ? "inferred" : "fallback"),
            nextTaskId: bucket.base.nextTaskId,
            nextTaskTitle: bucket.base.nextTaskTitle,
            nextTaskPriority: bucket.base.nextTaskPriority,
            nextTaskDueAt: bucket.base.nextTaskDueAt,
            updatedAt: bucket.base.updatedAt ?? null,
            sliceTaskIds: Array.from(bucket.taskIds.values()),
            sliceTaskCount: bucket.taskIds.size,
            compositeScore: bucket.base.compositeScore,
            scoringTier: bucket.base.scoringTier,
            iwmtRank: bucket.iwmtRank,
          });
        }
      } else if (sliceScope === "workstream") {
        queueItems.forEach((item, index) => {
          const runnerAgents = mergeRunnerAgents(item.runnerAgents ?? []);
          const runnerPrimary = runnerAgents[0] ?? null;
          slices.push({
            id: `${item.initiativeId}:${item.workstreamId}`,
            scope: sliceScope,
            initiativeId: item.initiativeId,
            initiativeTitle: item.initiativeTitle,
            workstreamId: item.workstreamId,
            workstreamTitle: item.workstreamTitle,
            milestoneId: item.sliceMilestoneId ?? item.nextTaskMilestoneId ?? null,
            milestoneTitle: null,
            taskId: null,
            taskTitle: null,
            queueState: item.queueState,
            sourceWorkstreamIds: [item.workstreamId],
            runnerAgentId: runnerPrimary?.id ?? null,
            runnerAgentName: runnerPrimary?.name ?? "Unassigned",
            runnerAgents,
            runnerSource: item.runnerSource ?? (runnerPrimary ? "inferred" : "fallback"),
            nextTaskId: item.nextTaskId,
            nextTaskTitle: item.nextTaskTitle,
            nextTaskPriority: item.nextTaskPriority,
            nextTaskDueAt: item.nextTaskDueAt,
            updatedAt: item.updatedAt ?? null,
            sliceTaskIds: dedupeStrings(item.sliceTaskIds ?? []),
            sliceTaskCount:
              typeof item.sliceTaskCount === "number"
                ? Math.max(0, Math.floor(item.sliceTaskCount))
                : (item.sliceTaskIds ?? []).length,
            compositeScore: item.compositeScore,
            scoringTier: item.scoringTier,
            iwmtRank: index,
          });
        });
      } else if (sliceScope === "milestone") {
        const grouped = new Map<
          string,
          {
            base: NextUpQueueItem;
            milestoneId: string | null;
            milestoneTitle: string | null;
            taskIds: Set<string>;
            iwmtRank: number;
          }
        >();

        queueItems.forEach((item, index) => {
          const graphIndex = graphIndexByInitiative.get(item.initiativeId) ?? null;
          const selectedTaskIds = dedupeStrings([
            ...(item.sliceTaskIds ?? []),
            ...(item.nextTaskId ? [item.nextTaskId] : []),
          ]);
          if (selectedTaskIds.length === 0) return;

          const taskBuckets = new Map<string, { milestoneId: string | null; taskIds: string[] }>();
          for (const taskId of selectedTaskIds) {
            const task = graphIndex?.tasksById.get(taskId) ?? null;
            if (!includeCompleted && isDoneStatus(task?.status ?? null)) continue;
            const milestoneId =
              task?.milestoneId ??
              item.sliceMilestoneId ??
              item.nextTaskMilestoneId ??
              null;
            const bucketKey = milestoneId ?? "__none__";
            const bucket = taskBuckets.get(bucketKey) ?? {
              milestoneId,
              taskIds: [],
            };
            bucket.taskIds.push(taskId);
            taskBuckets.set(bucketKey, bucket);
          }

          for (const [bucketKey, bucket] of taskBuckets.entries()) {
            const scopedKey = `${item.initiativeId}:${item.workstreamId}:${bucketKey}`;
            const existing = grouped.get(scopedKey);
            if (!existing) {
              grouped.set(scopedKey, {
                base: item,
                milestoneId: bucket.milestoneId,
                milestoneTitle:
                  (bucket.milestoneId
                    ? graphIndex?.milestoneTitleById.get(bucket.milestoneId)
                    : null) ?? null,
                taskIds: new Set(bucket.taskIds),
                iwmtRank: index,
              });
              continue;
            }
            for (const taskId of bucket.taskIds) existing.taskIds.add(taskId);
            if (index < existing.iwmtRank) {
              existing.base = item;
              existing.iwmtRank = index;
            }
          }
        });

        for (const [id, bucket] of grouped.entries()) {
          const runnerAgents = mergeRunnerAgents(bucket.base.runnerAgents ?? []);
          const runnerPrimary = runnerAgents[0] ?? null;
          slices.push({
            id,
            scope: sliceScope,
            initiativeId: bucket.base.initiativeId,
            initiativeTitle: bucket.base.initiativeTitle,
            workstreamId: bucket.base.workstreamId,
            workstreamTitle: bucket.base.workstreamTitle,
            milestoneId: bucket.milestoneId,
            milestoneTitle: bucket.milestoneTitle,
            taskId: null,
            taskTitle: null,
            queueState: bucket.base.queueState,
            sourceWorkstreamIds: [bucket.base.workstreamId],
            runnerAgentId: runnerPrimary?.id ?? null,
            runnerAgentName: runnerPrimary?.name ?? "Unassigned",
            runnerAgents,
            runnerSource:
              bucket.base.runnerSource ?? (runnerPrimary ? "inferred" : "fallback"),
            nextTaskId: bucket.base.nextTaskId,
            nextTaskTitle: bucket.base.nextTaskTitle,
            nextTaskPriority: bucket.base.nextTaskPriority,
            nextTaskDueAt: bucket.base.nextTaskDueAt,
            updatedAt: bucket.base.updatedAt ?? null,
            sliceTaskIds: Array.from(bucket.taskIds.values()),
            sliceTaskCount: bucket.taskIds.size,
            compositeScore: bucket.base.compositeScore,
            scoringTier: bucket.base.scoringTier,
            iwmtRank: bucket.iwmtRank,
          });
        }
      } else {
        queueItems.forEach((item, index) => {
          const graphIndex = graphIndexByInitiative.get(item.initiativeId) ?? null;
          const selectedTaskIds = dedupeStrings([
            ...(item.sliceTaskIds ?? []),
            ...(item.nextTaskId ? [item.nextTaskId] : []),
          ]);
          for (const taskId of selectedTaskIds) {
            const task = graphIndex?.tasksById.get(taskId) ?? null;
            if (!includeCompleted && isDoneStatus(task?.status ?? null)) continue;
            const taskTitle =
              task?.title ??
              (taskId === item.nextTaskId ? item.nextTaskTitle : null) ??
              taskId;
            slices.push({
              id: `${item.initiativeId}:${item.workstreamId}:${taskId}`,
              scope: sliceScope,
              initiativeId: item.initiativeId,
              initiativeTitle: item.initiativeTitle,
              workstreamId: item.workstreamId,
              workstreamTitle: item.workstreamTitle,
              milestoneId:
                task?.milestoneId ??
                item.sliceMilestoneId ??
                item.nextTaskMilestoneId ??
                null,
              milestoneTitle:
                task?.milestoneId
                  ? graphIndex?.milestoneTitleById.get(task.milestoneId) ?? null
                  : null,
              taskId,
              taskTitle,
              queueState:
                isDoneStatus(task?.status ?? null) ? "completed" : item.queueState,
              sourceWorkstreamIds: [item.workstreamId],
              runnerAgentId:
                (item.runnerAgents ?? [])[0]?.id ?? item.runnerAgentId ?? null,
              runnerAgentName:
                (item.runnerAgents ?? [])[0]?.name ?? item.runnerAgentName ?? "Unassigned",
              runnerAgents: mergeRunnerAgents(item.runnerAgents ?? []),
              runnerSource:
                item.runnerSource ??
                ((item.runnerAgents ?? [])[0] ? "inferred" : "fallback"),
              nextTaskId: item.nextTaskId,
              nextTaskTitle: item.nextTaskTitle,
              nextTaskPriority: task?.priorityNum ?? item.nextTaskPriority,
              nextTaskDueAt: task?.dueDate ?? item.nextTaskDueAt,
              updatedAt: task?.updatedAt ?? item.updatedAt ?? null,
              sliceTaskIds: [taskId],
              sliceTaskCount: 1,
              compositeScore: item.compositeScore,
              scoringTier: item.scoringTier,
              iwmtRank: index,
            });
          }
        });
      }

      const sorted = sortSlices(slices, order);
      const paged = applySliceSearchAndPagination({
        items: sorted,
        searchTerm,
        offset,
        limit: pageSize,
      });
      deps.sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        level: sliceScope,
        scope: sliceScope,
        order,
        includeCompleted,
        total: paged.filtered.length,
        items: paged.paged,
        pagination: paged.pagination,
        source: canonicalFallbackReason ? "local_fallback" : "local",
        degraded: degraded.length > 0 ? dedupeStrings(degraded) : undefined,
      });
    } catch (err: unknown) {
      sendRouteException(res, "mission-control.read.slices.handler", err);
    }
  }

  async function renderSentinelCatalog(query: URLSearchParams, res: TRes): Promise<void> {
    const domain = query.get("domain");
    const signal = query.get("signal");
    const items = listBuiltInSentinels({ domain, signal });

    deps.sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      total: items.length,
      items,
    });
  }

  router.add(
    "GET",
    "mission-control/auto-continue/status",
    async ({ query, res }) => renderAutoContinueStatus(query, res),
    "Get auto-continue status for an initiative"
  );
  router.add(
    "HEAD",
    "mission-control/auto-continue/status",
    async ({ query, res }) => renderAutoContinueStatus(query, res),
    "Get auto-continue status for an initiative (HEAD)"
  );

  router.add(
    "GET",
    "mission-control/graph",
    async ({ query, res }) => renderMissionControlGraph(query, res),
    "Get mission-control dependency graph"
  );
  router.add(
    "HEAD",
    "mission-control/graph",
    async ({ query, res }) => renderMissionControlGraph(query, res),
    "Get mission-control dependency graph (HEAD)"
  );

  router.add(
    "GET",
    "mission-control/next-up",
    async ({ query, res, req }) =>
      renderNextUpQueue(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get next-up queue"
  );
  router.add(
    "HEAD",
    "mission-control/next-up",
    async ({ query, res, req }) =>
      renderNextUpQueue(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get next-up queue (HEAD)"
  );

  router.add(
    "GET",
    "mission-control/slices",
    async ({ query, res, req }) =>
      renderSliceProjection(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get mission-control slices at initiative/workstream/milestone/task scope"
  );
  router.add(
    "HEAD",
    "mission-control/slices",
    async ({ query, res, req }) =>
      renderSliceProjection(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get mission-control slices at initiative/workstream/milestone/task scope (HEAD)"
  );

  router.add(
    "GET",
    "mission-control/sentinels",
    async ({ query, res }) => renderSentinelCatalog(query, res),
    "Get built-in sentinel catalog"
  );
  router.add(
    "HEAD",
    "mission-control/sentinels",
    async ({ query, res }) => renderSentinelCatalog(query, res),
    "Get built-in sentinel catalog (HEAD)"
  );
}
