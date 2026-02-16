import type { Router } from "../router.js";
import type { Entity } from "../../types.js";

type JsonRecord = Record<string, unknown>;

type LiveInitiativesResponse = {
  initiatives: unknown[];
  total?: number;
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
    includeIdle: boolean | undefined;
  }) => Promise<unknown>;
  getLiveInitiatives: (input: {
    id: string | null;
    limit: number | undefined;
  }) => Promise<LiveInitiativesResponse>;
  getLiveDecisions: (input: {
    status: string;
    limit: number;
  }) => Promise<LiveDecisionsResponse>;
  getHandoffs: () => Promise<HandoffsResponse>;
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
  mapDecisionEntity: (entry: Entity) => { waitingMinutes: number };
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerLiveMiscRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveMiscRoutesDeps<TReq, TRes>
): void {
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

  async function renderLiveAgents(query: URLSearchParams, res: TRes): Promise<void> {
    try {
      const initiative = query.get("initiative");
      const includeIdleRaw = query.get("include_idle");
      const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
      const data = await deps.getLiveAgents({
        initiative,
        includeIdle,
      });
      deps.sendJson(res, 200, data);
    } catch (err: unknown) {
      try {
        const initiative = query.get("initiative");
        const includeIdleRaw = query.get("include_idle");
        const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";

        const localSnapshot = await deps.loadLocalOpenClawSnapshot(240);
        const local = deps.toLocalLiveAgents(localSnapshot);

        let agents = local.agents;
        if (initiative && initiative.trim().length > 0) {
          agents = agents.filter((agent) => agent.initiativeId === initiative);
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
    async ({ query, res }) => renderLiveAgents(query, res),
    "Get live agents"
  );
  router.add(
    "HEAD",
    "live/agents",
    async ({ query, res }) => renderLiveAgents(query, res),
    "Get live agents (HEAD)"
  );

  async function renderLiveInitiatives(query: URLSearchParams, res: TRes): Promise<void> {
    try {
      const id = query.get("id");
      const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
      const data = await deps.getLiveInitiatives({
        id,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      const payload = data as Record<string, unknown>;
      const initiatives = Array.isArray(payload.initiatives)
        ? payload.initiatives.map((entry) => {
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
          })
        : payload.initiatives;
      deps.sendJson(res, 200, {
        ...payload,
        initiatives,
      });
    } catch (err: unknown) {
      try {
        const id = query.get("id");
        const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

        const local = deps.toLocalLiveInitiatives(await deps.loadLocalOpenClawSnapshot(240));
        let initiatives = local.initiatives;
        if (id && id.trim().length > 0) {
          initiatives = initiatives.filter((item) => item.id === id);
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
          if (override && !initiatives.some((item) => item.id === requestedId)) {
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

        deps.sendJson(res, 200, {
          initiatives: initiatives.slice(0, limit),
          total: initiatives.length,
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
    async ({ query, res }) => renderLiveInitiatives(query, res),
    "Get live initiatives"
  );
  router.add(
    "HEAD",
    "live/initiatives",
    async ({ query, res }) => renderLiveInitiatives(query, res),
    "Get live initiatives (HEAD)"
  );

  async function renderLiveDecisions(query: URLSearchParams, res: TRes): Promise<void> {
    try {
      const status = query.get("status") ?? "pending";
      const limit = query.get("limit") ? Number(query.get("limit")) : 100;
      const data = await deps.getLiveDecisions({
        status,
        limit: Number.isFinite(limit) ? limit : 100,
      });
      const decisions = data.decisions
        .map(deps.mapDecisionEntity)
        .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

      deps.sendJson(res, 200, {
        decisions,
        total: data.total,
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
    async ({ query, res }) => renderLiveDecisions(query, res),
    "Get live decisions"
  );
  router.add(
    "HEAD",
    "live/decisions",
    async ({ query, res }) => renderLiveDecisions(query, res),
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
}
