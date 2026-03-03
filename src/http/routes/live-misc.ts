import type { Router } from "../router.js";
import type { Entity } from "../../types.js";
import {
  resolveWorkspaceScope,
  workspaceScopeFromHeaders,
} from "../helpers/workspace-scope.js";
import { summarizeTaskStatuses } from "../../reporting/rollups.js";

type JsonRecord = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LiveInitiativesResponse = {
  initiatives: unknown[];
  total?: number;
  pagination?: {
    limit?: number;
    offset?: number;
    has_more?: boolean;
  };
};

type LiveDecisionsResponse = {
  decisions: Entity[];
  total: number;
};

type HandoffsResponse = {
  handoffs: unknown[];
};

type LocalSnapshot = Awaited<
  ReturnType<typeof import("../../local-openclaw.js").loadLocalOpenClawSnapshot>
>;

type RegisterLiveMiscRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  summarizeActivityHeadline: (input: {
    text: string;
    title: string | null;
    type: string | null;
  }) => Promise<{ headline: string; source: string; model: string | null }>;
  getLiveAgents: (input: {
    initiative: string | null;
    projectId: string | null;
    includeIdle: boolean | undefined;
  }) => Promise<unknown>;
  getLiveInitiatives: (input: {
    id: string | null;
    projectId: string | null;
    limit: number | undefined;
    offset: number | undefined;
  }) => Promise<LiveInitiativesResponse>;
  getLiveDecisions: (input: {
    status: string;
    projectId: string | null;
    limit: number;
  }) => Promise<LiveDecisionsResponse>;
  getHandoffs: () => Promise<HandoffsResponse>;
  listInitiativeIdsForProject: (input: { projectId: string }) => Promise<string[]>;
  loadLocalOpenClawSnapshot: (limit: number) => Promise<LocalSnapshot>;
  toLocalLiveAgents: (
    snapshot: LocalSnapshot
  ) => {
    agents: Array<{ initiativeId: string | null; status: string }>;
  };
  toLocalLiveInitiatives: (
    snapshot: LocalSnapshot
  ) => {
    initiatives: Array<{
      id: string;
      title: string;
      status: string;
      updatedAt: string | null;
      sessionCount: number;
      activeAgents: number;
    }>;
  };
  localInitiativeStatusOverrides: Map<string, { status: string; updatedAt: string }>;
  buildMissionControlGraph?: (initiativeId: string) => Promise<unknown>;
  mapDecisionEntity: (entry: Entity) => { waitingMinutes: number };
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function pickStringFromRecord(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function resolveInitiativeIdFromRecord(input: Record<string, unknown>): string | null {
  const direct = pickStringFromRecord(input, ["initiativeId", "initiative_id", "initiative"]);
  if (direct) return direct;
  const metadata = asRecord(input.metadata);
  return pickStringFromRecord(metadata, ["initiativeId", "initiative_id", "initiative"]);
}

export function registerLiveMiscRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveMiscRoutesDeps<TReq, TRes>
): void {
  async function resolveProjectInitiativeSet(
    projectIdRaw: string | null
  ): Promise<Set<string> | null> {
    const projectId = projectIdRaw?.trim() ?? "";
    if (!projectId) return null;
    const ids = await deps.listInitiativeIdsForProject({ projectId });
    return new Set(ids);
  }

  router.add(
    "POST",
    "live/activity/headline",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const text = deps.pickString(payload, ["text", "summary", "detail", "content"]);
        if (!text) {
          deps.sendJson(res, 400, { error: "text is required" });
          return;
        }

        const title = deps.pickString(payload, ["title", "name"]);
        const type = deps.pickString(payload, ["type", "kind"]);
        const result = await deps.summarizeActivityHeadline({
          text,
          title,
          type,
        });

        deps.sendJson(res, 200, {
          headline: result.headline,
          source: result.source,
          model: result.model,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Summarize an activity headline"
  );
  router.add(
    "*",
    "live/activity/headline",
    ({ res }) => {
      deps.sendJson(res, 405, { error: "Use POST /orgx/api/live/activity/headline" });
    },
    "Reject unsupported methods for live/activity/headline"
  );

  async function renderLiveAgents(
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (scope.error) {
      deps.sendJson(res, 400, { error: scope.error });
      return;
    }
    const workspaceId = scope.workspaceId;
    try {
      const initiative = query.get("initiative");
      const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);
      const includeIdleRaw = query.get("include_idle");
      const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
      const data = (await deps.getLiveAgents({
        initiative,
        projectId: workspaceId,
        includeIdle,
      })) as Record<string, unknown>;
      const agents = Array.isArray(data.agents) ? data.agents : [];
      const scopedAgents = agents.filter((entry) => {
        const row = asRecord(entry);
        if (!row) return false;
        const initiativeId = resolveInitiativeIdFromRecord(row);
        if (initiative && initiative.trim().length > 0 && initiativeId !== initiative) return false;
        if (projectInitiatives && (!initiativeId || !projectInitiatives.has(initiativeId))) {
          return false;
        }
        if (includeIdle === false) {
          const status = pickStringFromRecord(row, ["status"]);
          if (status === "idle") return false;
        }
        return true;
      });
      const summary = scopedAgents.reduce<Record<string, number>>((acc, entry) => {
        const row = asRecord(entry);
        const status = pickStringFromRecord(row, ["status"]) ?? "unknown";
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {});
      deps.sendJson(res, 200, {
        ...data,
        agents: scopedAgents,
        summary,
      });
    } catch (err: unknown) {
      try {
        const initiative = query.get("initiative");
        const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);
        const includeIdleRaw = query.get("include_idle");
        const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";

        const localSnapshot = await deps.loadLocalOpenClawSnapshot(240);
        const local = deps.toLocalLiveAgents(localSnapshot);

        let agents = local.agents;
        if (initiative && initiative.trim().length > 0) {
          agents = agents.filter((agent) => agent.initiativeId === initiative);
        }
        if (projectInitiatives) {
          agents = agents.filter((agent) => {
            const initiativeId = typeof agent.initiativeId === "string" ? agent.initiativeId : "";
            return initiativeId.length > 0 && projectInitiatives.has(initiativeId);
          });
        }
        if (includeIdle === false) {
          agents = agents.filter((agent) => agent.status !== "idle");
        }

        const summary = agents.reduce<Record<string, number>>((acc, agent) => {
          acc[agent.status] = (acc[agent.status] ?? 0) + 1;
          return acc;
        }, {});

        deps.sendJson(res, 200, { agents, summary });
      } catch (localErr: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
          localFallbackError: deps.safeErrorMessage(localErr),
        });
      }
    }
  }

  router.add(
    "GET",
    "live/agents",
    async ({ query, res, req }) =>
      renderLiveAgents(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live agents"
  );
  router.add(
    "HEAD",
    "live/agents",
    async ({ query, res, req }) =>
      renderLiveAgents(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live agents (HEAD)"
  );

  async function renderLiveInitiatives(
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (scope.error) {
      deps.sendJson(res, 400, { error: scope.error });
      return;
    }
    const workspaceId = scope.workspaceId;
    try {
      const id = query.get("id");
      const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);
      const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
      const offsetRaw = query.get("offset") ? Number(query.get("offset")) : undefined;
      const requestedLimit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.floor(Number(limitRaw)))
        : null;
      const requestedOffset = Number.isFinite(offsetRaw)
        ? Math.max(0, Math.floor(Number(offsetRaw)))
        : 0;
      const data = await deps.getLiveInitiatives({
        id,
        projectId: workspaceId,
        limit: requestedLimit ?? undefined,
        offset: requestedOffset,
      });
      const payload = data as Record<string, unknown>;
      const rawInitiatives = Array.isArray(payload.initiatives) ? payload.initiatives : [];
      const applyLocalOverrides = (rows: unknown[]): unknown[] =>
        rows.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const row = entry as Record<string, unknown>;
          const initiativeId = deps.pickString(row, ["id"]);
          if (!initiativeId) return entry;
          const override = deps.localInitiativeStatusOverrides.get(initiativeId) ?? null;
          if (!override) return entry;
          return {
            ...row,
            status: override.status,
            updatedAt:
              deps.pickString(row, ["updatedAt", "updated_at"]) ?? override.updatedAt,
          };
        });

      let initiatives = Array.isArray(payload.initiatives)
        ? payload.initiatives
            .filter((entry) => {
              const row = asRecord(entry);
              if (!row) return false;
              const initiativeId = deps.pickString(row, ["id"]);
              if (!initiativeId) return false;
              if (id && id.trim().length > 0 && initiativeId !== id) return false;
              if (projectInitiatives && !projectInitiatives.has(initiativeId)) return false;
              return true;
            })
            .map((entry) => entry)
        : payload.initiatives;
      initiatives = Array.isArray(initiatives) ? applyLocalOverrides(initiatives) : initiatives;

      let fallbackHydratedFromScope = false;
      if (
        Array.isArray(initiatives) &&
        initiatives.length === 0 &&
        !id &&
        projectInitiatives &&
        projectInitiatives.size > 0
      ) {
        const scopedIds = Array.from(projectInitiatives.values()).slice(
          requestedOffset,
          requestedOffset + (requestedLimit ?? 50)
        );
        const hydrated: unknown[] = [];
        for (const initiativeId of scopedIds) {
          try {
            const single = await deps.getLiveInitiatives({
              id: initiativeId,
              projectId: null,
              limit: 1,
              offset: 0,
            });
            const singleRows = Array.isArray(single?.initiatives)
              ? single.initiatives
              : [];
            const match = singleRows.find((entry) => {
              const row = asRecord(entry);
              const rowId = deps.pickString(row ?? {}, ["id"]);
              return rowId === initiativeId;
            });
            if (match) hydrated.push(match);
          } catch {
            // Ignore per-initiative hydration failures and continue with remaining IDs.
          }
        }
        if (hydrated.length > 0) {
          initiatives = applyLocalOverrides(hydrated);
          fallbackHydratedFromScope = true;
        }
      }

      const remotePagination = asRecord(payload.pagination);
      const remoteHasMoreComputed = typeof remotePagination?.has_more === "boolean"
        ? (remotePagination.has_more as boolean)
        : typeof payload.total === "number"
          ? requestedOffset + rawInitiatives.length < (payload.total as number)
          : requestedLimit !== null
            ? rawInitiatives.length >= requestedLimit
            : false;
      const scopedTotal =
        fallbackHydratedFromScope && projectInitiatives
          ? projectInitiatives.size
          : Array.isArray(initiatives)
            ? initiatives.length
            : 0;
      const scopedHasMore =
        fallbackHydratedFromScope && projectInitiatives
          ? requestedOffset + (Array.isArray(initiatives) ? initiatives.length : 0) <
            projectInitiatives.size
          : remoteHasMoreComputed;
      deps.sendJson(res, 200, {
        ...payload,
        initiatives,
        total: scopedTotal,
        pagination: {
          ...(remotePagination ?? {}),
          limit:
            typeof remotePagination?.limit === "number"
              ? remotePagination.limit
              : (requestedLimit ?? rawInitiatives.length),
          offset:
            typeof remotePagination?.offset === "number"
              ? remotePagination.offset
              : requestedOffset,
          has_more: scopedHasMore,
        },
        ...(fallbackHydratedFromScope
          ? {
              scopedFallback: true,
              scopedFallbackReason:
                "upstream live initiatives page did not contain requested workspace rows",
            }
          : {}),
      });
    } catch (err: unknown) {
      try {
        const id = query.get("id");
        const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);
        const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
        const offsetRaw = query.get("offset") ? Number(query.get("offset")) : undefined;
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Number(offsetRaw)) : 0;

        const local = deps.toLocalLiveInitiatives(await deps.loadLocalOpenClawSnapshot(240));
        let initiatives = local.initiatives;
        if (id && id.trim().length > 0) {
          initiatives = initiatives.filter((item) => item.id === id);
        }
        if (projectInitiatives) {
          initiatives = initiatives.filter((item) => projectInitiatives.has(item.id));
        }

        initiatives = initiatives.map((item) => {
          const override = deps.localInitiativeStatusOverrides.get(item.id) ?? null;
          if (!override) return item;
          return {
            ...item,
            status: override.status,
            updatedAt: item.updatedAt ?? override.updatedAt,
          };
        });

        const requestedId = id?.trim() ?? "";
        if (requestedId.length > 0) {
          const override = deps.localInitiativeStatusOverrides.get(requestedId) ?? null;
          const allowedByProject =
            !projectInitiatives || projectInitiatives.has(requestedId);
          if (
            override &&
            allowedByProject &&
            !initiatives.some((item) => item.id === requestedId)
          ) {
            initiatives.push({
              id: requestedId,
              title: `Initiative ${requestedId.slice(0, 8)}`,
              status: override.status,
              updatedAt: override.updatedAt,
              sessionCount: 0,
              activeAgents: 0,
            });
          }
        } else {
          for (const [initiativeId, override] of deps.localInitiativeStatusOverrides.entries()) {
            if (projectInitiatives && !projectInitiatives.has(initiativeId)) continue;
            if (initiatives.some((item) => item.id === initiativeId)) continue;
            initiatives.push({
              id: initiativeId,
              title: `Initiative ${initiativeId.slice(0, 8)}`,
              status: override.status,
              updatedAt: override.updatedAt,
              sessionCount: 0,
              activeAgents: 0,
            });
          }
        }

        const total = initiatives.length;
        const page = initiatives.slice(offset, offset + limit);
        deps.sendJson(res, 200, {
          initiatives: page,
          total,
          pagination: {
            limit,
            offset,
            has_more: offset + page.length < total,
          },
          localFallback: true,
          warning: deps.safeErrorMessage(err),
        });
      } catch (localErr: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
          localFallbackError: deps.safeErrorMessage(localErr),
        });
      }
    }
  }

  router.add(
    "GET",
    "live/initiatives",
    async ({ query, res, req }) =>
      renderLiveInitiatives(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live initiatives"
  );
  router.add(
    "HEAD",
    "live/initiatives",
    async ({ query, res, req }) =>
      renderLiveInitiatives(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live initiatives (HEAD)"
  );

  async function renderLiveDecisions(
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (scope.error) {
      deps.sendJson(res, 400, { error: scope.error });
      return;
    }
    const workspaceId = scope.workspaceId;
    try {
      const status = query.get("status") ?? "pending";
      const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);
      const limit = query.get("limit") ? Number(query.get("limit")) : 100;
      const data = await deps.getLiveDecisions({
        status,
        projectId: workspaceId,
        limit: Number.isFinite(limit) ? limit : 100,
      });
      const decisions = data.decisions
        .map(deps.mapDecisionEntity)
        .filter((entry) => {
          if (!projectInitiatives) return true;
          const row = asRecord(entry);
          if (!row) return false;
          const initiativeId = resolveInitiativeIdFromRecord(row);
          return Boolean(initiativeId && projectInitiatives.has(initiativeId));
        })
        .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

      deps.sendJson(res, 200, {
        decisions,
        total: decisions.length,
      });
    } catch {
      deps.sendJson(res, 200, {
        decisions: [],
        total: 0,
      });
    }
  }

  router.add(
    "GET",
    "live/decisions",
    async ({ query, res, req }) =>
      renderLiveDecisions(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live decisions"
  );
  router.add(
    "HEAD",
    "live/decisions",
    async ({ query, res, req }) =>
      renderLiveDecisions(
        query,
        res,
        workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers)
      ),
    "Get live decisions (HEAD)"
  );

  async function renderHandoffs(res: TRes): Promise<void> {
    try {
      const data = await deps.getHandoffs();
      deps.sendJson(res, 200, data);
    } catch {
      deps.sendJson(res, 200, { handoffs: [] });
    }
  }

  router.add(
    "GET",
    "handoffs",
    async ({ res }) => renderHandoffs(res),
    "Get handoffs"
  );
  router.add(
    "HEAD",
    "handoffs",
    async ({ res }) => renderHandoffs(res),
    "Get handoffs (HEAD)"
  );

  type InitiativeSummaryItem = {
    id: string;
    taskCounts: { total: number; done: number; blocked: number; active: number; todo: number };
    progressPct: number;
  };

  router.add(
    "GET",
    "live/initiatives/summary",
    async ({ query, res, req }) => {
      try {
        const scope = resolveWorkspaceScope(
          query,
          workspaceScopeFromHeaders((req as { headers?: Record<string, unknown> })?.headers),
          { allowProjectScope: false }
        );
        if (scope.error) {
          deps.sendJson(res, 400, { error: scope.error });
          return;
        }
        const workspaceId = scope.workspaceId;
        const projectInitiatives = await resolveProjectInitiativeSet(workspaceId);

        // Load initiatives
        const local = deps.toLocalLiveInitiatives(await deps.loadLocalOpenClawSnapshot(240));
        let initiatives = local.initiatives;
        if (projectInitiatives) {
          initiatives = initiatives.filter((item) => projectInitiatives.has(item.id));
        }

        const perInitiative: InitiativeSummaryItem[] = [];
        let totalTasks = 0;
        let doneTasks = 0;
        let blockedCount = 0;
        let activeCount = 0;
        let totalActiveAgents = 0;

        for (const initiative of initiatives) {
          totalActiveAgents += initiative.activeAgents;

          // Try to get task statuses from graph (skip local placeholder IDs like "agent:orgx")
          let taskStatuses: string[] = [];
          if (deps.buildMissionControlGraph && UUID_RE.test(initiative.id)) {
            try {
              const graphRaw = await deps.buildMissionControlGraph(initiative.id);
              const graph = asRecord(graphRaw);
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
              for (const nodeEntry of nodes) {
                const node = asRecord(nodeEntry);
                if (!node) continue;
                const type = pickStringFromRecord(node, ["type"]);
                if (type !== "task") continue;
                const status = pickStringFromRecord(node, ["status"]) ?? "todo";
                taskStatuses.push(status);
              }
            } catch {
              // Graph unavailable — fall back to empty counts
            }
          }

          const counts = summarizeTaskStatuses(taskStatuses);
          const progressPct =
            counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

          perInitiative.push({
            id: initiative.id,
            taskCounts: counts,
            progressPct,
          });

          totalTasks += counts.total;
          doneTasks += counts.done;
          blockedCount += counts.blocked;
          activeCount += counts.active;
        }

        const completionPercent =
          totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

        deps.sendJson(res, 200, {
          initiatives: perInitiative,
          aggregate: {
            totalTasks,
            doneTasks,
            blockedCount,
            activeAgents: totalActiveAgents,
            completionPercent,
          },
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Get live initiatives summary"
  );
}
