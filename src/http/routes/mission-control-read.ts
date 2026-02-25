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

const NEXT_UP_LOCAL_QUEUE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ORGX_NEXT_UP_LOCAL_QUEUE_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw)) return 1_500;
  return Math.max(250, Math.min(15_000, Math.floor(raw)));
})();

async function withSoftTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

    output.push({
      initiativeId,
      initiativeTitle: asString(record.initiativeTitle) ?? initiativeId,
      initiativeStatus: asString(record.initiativeStatus) ?? "active",
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
      queueState: normalizeQueueState(record.queueState),
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
    const dueDelta = dueEpoch(left.nextTaskDueAt) - dueEpoch(right.nextTaskDueAt);
    if (dueDelta !== 0) return dueDelta;
    const titleDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
    if (titleDelta !== 0) return titleDelta;
    return left.workstreamTitle.localeCompare(right.workstreamTitle);
  });
}

function mapCanonicalSlicesToQueueItems(input: {
  payload: unknown;
  initiativeId?: string | null;
}): NextUpQueueItem[] {
  const root = asRecord(input.payload);
  const rawItems = Array.isArray(root?.items) ? root.items : [];
  if (rawItems.length === 0) return [];

  const requestedInitiativeId = input.initiativeId?.trim() || null;
  const grouped = new Map<
    string,
    {
      base: NextUpQueueItem;
      states: NextUpQueueItem["queueState"][];
      taskIds: Set<string>;
      runnerAgents: SliceRunnerAgent[];
      rank: number;
    }
  >();

  const resolveRank = (record: Record<string, unknown>, fallback: number): number => {
    const candidates = [
      asNumber(record.finalRank),
      asNumber(record.manualRank),
      asNumber(record.algorithmRank),
      asNumber(record.iwmtRank),
      asNumber(record.rank),
      asNumber(record.iwmt_rank),
    ].filter((value): value is number => typeof value === "number");
    if (candidates.length === 0) return fallback;
    return candidates[0];
  };

  rawItems.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) return;

    const initiativeId = asString(record.initiativeId);
    const workstreamId = asString(record.workstreamId);
    if (!initiativeId || !workstreamId) return;
    if (requestedInitiativeId && initiativeId !== requestedInitiativeId) return;

    const queueState = normalizeQueueState(
      record.queueState ?? record.status ?? record.state
    );
    const nextTaskId = asString(record.nextTaskId) ?? asString(record.taskId);
    const scope = asString(record.scope) ?? asString(record.level);
    const normalizedScope =
      scope === "task" || scope === "milestone" || scope === "workstream"
        ? (scope as "task" | "milestone" | "workstream")
        : null;
    const taskIds = dedupeStrings([
      ...asStringArray(record.sliceTaskIds),
      ...(nextTaskId ? [nextTaskId] : []),
      ...(asString(record.taskId) ? [asString(record.taskId)!] : []),
    ]);
    const runnerAgentsRaw = normalizeRunnerAgents(record.runnerAgents);
    const runnerAgentIdRaw =
      normalizeRunnerValue(record.runnerAgentId) ??
      normalizeRunnerValue(record.agentId);
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
    const candidate: NextUpQueueItem = {
      initiativeId,
      initiativeTitle: asString(record.initiativeTitle) ?? initiativeId,
      initiativeStatus: asString(record.initiativeStatus) ?? "active",
      workstreamId,
      workstreamTitle:
        asString(record.workstreamTitle) ??
        (normalizedScope === "workstream" ? asString(record.title) : null) ??
        workstreamId,
      workstreamStatus:
        asString(record.workstreamStatus) ??
        (queueState === "running"
          ? "active"
          : queueState === "blocked"
            ? "blocked"
            : queueState === "completed"
              ? "completed"
              : "queued"),
      nextTaskId,
      nextTaskTitle:
        asString(record.nextTaskTitle) ??
        asString(record.taskTitle) ??
        (normalizedScope === "task" ? asString(record.title) : null),
      nextTaskPriority:
        asNumber(record.nextTaskPriority) ??
        asNumber(record.taskPriority) ??
        asNumber(record.priorityNum),
      nextTaskDueAt:
        asString(record.nextTaskDueAt) ??
        asString(record.taskDueAt) ??
        asString(record.dueDate),
      nextTaskMilestoneId:
        asString(record.nextTaskMilestoneId) ?? asString(record.milestoneId),
      runnerAgentId,
      runnerAgentName,
      runnerAgents,
      runnerSource,
      queueState,
      sliceScope: normalizedScope,
      sliceTaskIds: taskIds,
      sliceTaskCount:
        asNumber(record.sliceTaskCount) !== null
          ? Math.max(0, Math.floor(asNumber(record.sliceTaskCount)!))
          : taskIds.length,
      sliceMilestoneId: asString(record.sliceMilestoneId) ?? asString(record.milestoneId),
      compositeScore: asNumber(record.compositeScore) ?? undefined,
      scoringTier:
        asString(record.scoringTier) === "urgent" ||
        asString(record.scoringTier) === "ready" ||
        asString(record.scoringTier) === "waiting" ||
        asString(record.scoringTier) === "deferred"
          ? (asString(record.scoringTier) as "urgent" | "ready" | "waiting" | "deferred")
          : undefined,
      updatedAt: asString(record.updatedAt) ?? asString(record.lastEventAt) ?? null,
      isPinned: false,
      pinnedRank: null,
    };

    const key = `${initiativeId}:${workstreamId}`;
    const rank = resolveRank(record, index + 1);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        base: candidate,
        states: [queueState],
        taskIds: new Set(taskIds),
        runnerAgents: candidate.runnerAgents ?? [],
        rank,
      });
      return;
    }

    existing.states.push(queueState);
    for (const taskId of taskIds) {
      if (taskId.trim().length > 0) existing.taskIds.add(taskId.trim());
    }
    existing.runnerAgents = mergeRunnerAgents(
      existing.runnerAgents,
      candidate.runnerAgents ?? []
    );
    if (rank < existing.rank) {
      existing.base = candidate;
      existing.rank = rank;
    }
  });

  const output: NextUpQueueItem[] = [];
  for (const bucket of grouped.values()) {
    const taskIds = Array.from(bucket.taskIds.values());
    const runnerAgents = mergeRunnerAgents(bucket.runnerAgents, bucket.base.runnerAgents ?? []);
    const runnerPrimary = runnerAgents[0] ?? null;
    output.push({
      ...bucket.base,
      runnerAgentId: runnerPrimary?.id ?? null,
      runnerAgentName: runnerPrimary?.name ?? "Unassigned",
      runnerAgents,
      runnerSource:
        bucket.base.runnerSource ??
        (runnerPrimary ? "inferred" : "fallback"),
      queueState: combinedQueueState(bucket.states),
      sliceTaskIds: taskIds,
      sliceTaskCount:
        typeof bucket.base.sliceTaskCount === "number"
          ? Math.max(bucket.base.sliceTaskCount, taskIds.length)
          : taskIds.length,
    });
  }

  output.sort((left, right) => {
    const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
    if (queueDelta !== 0) return queueDelta;
    const priorityDelta =
      (left.nextTaskPriority ?? Number.MAX_SAFE_INTEGER) -
      (right.nextTaskPriority ?? Number.MAX_SAFE_INTEGER);
    if (priorityDelta !== 0) return priorityDelta;
    const dueDelta = dueEpoch(left.nextTaskDueAt) - dueEpoch(right.nextTaskDueAt);
    if (dueDelta !== 0) return dueDelta;
    const initiativeDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
    if (initiativeDelta !== 0) return initiativeDelta;
    return left.workstreamTitle.localeCompare(right.workstreamTitle);
  });

  return output;
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

    try {
      const queue = await deps.buildNextUpQueue({
        initiativeId,
        projectId,
      });
      let items = Array.isArray(queue.items) ? queue.items : [];
      const degraded = dedupeStrings(
        Array.isArray(queue.degraded) ? queue.degraded : []
      );

      if (items.length === 0 && deps.rawRequest) {
        try {
          const params = new URLSearchParams();
          if (initiativeId) params.set("initiative_id", initiativeId);
          if (projectId) {
            params.set("workspace_id", projectId);
            params.set("command_center_id", projectId);
          }
          params.set("level", "workstream");
          params.set("include_completed", "0");
          params.set("limit", "250");
          params.set(
            "mix_policy",
            query.get("mix_policy") ?? query.get("mixPolicy") ?? "iwmt_v1"
          );
          const orderMode = query.get("order_mode") ?? query.get("orderMode");
          if (orderMode) params.set("order_mode", orderMode);

          const canonical = await deps.rawRequest(
            "GET",
            `/api/client/mission-control/slices?${params.toString()}`
          );
          const fallbackItems = mapCanonicalSlicesToQueueItems({
            payload: canonical,
            initiativeId,
          });
          if (fallbackItems.length > 0) {
            items = fallbackItems;
            degraded.push("Using canonical slices fallback for Next Up queue.");
          }
        } catch (err: unknown) {
          degraded.push(
            `canonical next-up fallback unavailable (${deps.safeErrorMessage(err)})`
          );
        }
      }

      deps.sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        total: items.length,
        items,
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
      50,
      300
    );

    let canonicalFallbackReason: string | null = null;
    if (deps.rawRequest) {
      try {
        const params = new URLSearchParams();
        if (initiativeId) params.set("initiative_id", initiativeId);
        if (projectId) {
          params.set("workspace_id", projectId);
          params.set("command_center_id", projectId);
        }
        params.set("level", sliceScope);
        params.set("include_completed", includeCompleted ? "1" : "0");
        params.set(
          "mix_policy",
          query.get("mix_policy") ?? query.get("mixPolicy") ?? "iwmt_v1"
        );
        const requestedOrderMode =
          query.get("order_mode") ?? query.get("orderMode");
        if (requestedOrderMode) params.set("order_mode", requestedOrderMode);
        params.set(
          "limit",
          String(Math.min(300, Math.max(pageSize + offset, pageSize)))
        );

        const canonical = await deps.rawRequest(
          "GET",
          `/api/client/mission-control/slices?${params.toString()}`
        );
        const canonicalRecord = asRecord(canonical);
        if (!canonicalRecord || !Array.isArray(canonicalRecord.items)) {
          throw new Error("invalid canonical slices payload");
        }
        const canonicalItems = canonicalRecord.items;
        const paged = applySliceSearchAndPagination({
          items: canonicalItems,
          searchTerm,
          offset,
          limit: pageSize,
        });
        deps.sendJson(res, 200, {
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
        });
        return;
      } catch (err: unknown) {
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
