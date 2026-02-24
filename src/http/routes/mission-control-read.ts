import { listBuiltInSentinels } from "../helpers/sentinel-catalog.js";
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
      runnerAgentId: asString(record.runnerAgentId),
      runnerAgentName: asString(record.runnerAgentName),
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

  const resolveWorkspaceScopeFromQuery = (query: URLSearchParams): string | null => {
    const value =
      query.get("project_id") ??
      query.get("projectId") ??
      query.get("workspace_id") ??
      query.get("workspaceId") ??
      query.get("command_center_id") ??
      query.get("commandCenterId") ??
      query.get("center");
    if (!value) return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
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

  async function renderNextUpQueue(query: URLSearchParams, res: TRes): Promise<void> {
    const initiativeIdRaw = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const initiativeId = initiativeIdRaw.trim() || null;
    const projectId = resolveWorkspaceScopeFromQuery(query);

    try {
      const queue = await deps.buildNextUpQueue({
        initiativeId,
        projectId,
      });
      const items = Array.isArray(queue.items) ? queue.items : [];
      deps.sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        total: items.length,
        items,
        degraded: queue.degraded,
      });
    } catch (err: unknown) {
      sendRouteException(res, "mission-control.read.next-up.handler", err);
    }
  }

  async function renderSliceProjection(query: URLSearchParams, res: TRes): Promise<void> {
    const initiativeIdRaw = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const initiativeId = initiativeIdRaw.trim() || null;
    const projectId = resolveWorkspaceScopeFromQuery(query);
    const includeCompleted = parseBoolean(query.get("include_completed"));
    const scope = parseSliceScope(query.get("scope") ?? query.get("level"));
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
          params.set("project_id", projectId);
        }
        params.set("level", scope);
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
          level: asString(canonicalRecord.level) ?? scope,
          scope: asString(canonicalRecord.level) ?? scope,
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
      if (scope === "milestone" || scope === "task") {
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

      if (scope === "initiative") {
        const grouped = new Map<
          string,
          {
            base: NextUpQueueItem;
            states: NextUpQueueItem["queueState"][];
            taskIds: Set<string>;
            workstreamIds: Set<string>;
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
              iwmtRank: index,
            });
            return;
          }
          bucket.states.push(item.queueState);
          for (const taskId of item.sliceTaskIds ?? []) bucket.taskIds.add(taskId);
          bucket.workstreamIds.add(item.workstreamId);
          if (index < bucket.iwmtRank) {
            bucket.base = item;
            bucket.iwmtRank = index;
          }
        });

        for (const [initiativeKey, bucket] of grouped.entries()) {
          slices.push({
            id: initiativeKey,
            scope,
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
            runnerAgentId: bucket.base.runnerAgentId ?? null,
            runnerAgentName: bucket.base.runnerAgentName ?? null,
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
      } else if (scope === "workstream") {
        queueItems.forEach((item, index) => {
          slices.push({
            id: `${item.initiativeId}:${item.workstreamId}`,
            scope,
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
            runnerAgentId: item.runnerAgentId ?? null,
            runnerAgentName: item.runnerAgentName ?? null,
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
      } else if (scope === "milestone") {
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
          slices.push({
            id,
            scope,
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
            runnerAgentId: bucket.base.runnerAgentId ?? null,
            runnerAgentName: bucket.base.runnerAgentName ?? null,
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
              scope,
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
              runnerAgentId: item.runnerAgentId ?? null,
              runnerAgentName: item.runnerAgentName ?? null,
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
        level: scope,
        scope,
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
    async ({ query, res }) => renderNextUpQueue(query, res),
    "Get next-up queue"
  );
  router.add(
    "HEAD",
    "mission-control/next-up",
    async ({ query, res }) => renderNextUpQueue(query, res),
    "Get next-up queue (HEAD)"
  );

  router.add(
    "GET",
    "mission-control/slices",
    async ({ query, res }) => renderSliceProjection(query, res),
    "Get mission-control slices at initiative/workstream/milestone/task scope"
  );
  router.add(
    "HEAD",
    "mission-control/slices",
    async ({ query, res }) => renderSliceProjection(query, res),
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
