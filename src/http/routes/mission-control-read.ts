import type { Router } from "../router.js";

type AutoContinueRunRecord = {
  id?: string;
  initiativeId?: string;
  status?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  tokenBudget?: number;
  tickMs?: number;
};

type NextUpQueue = {
  items: unknown[];
  degraded: string[];
};

type RegisterMissionControlReadRoutesDeps<TRes> = {
  autoContinueRuns: Map<string, AutoContinueRunRecord>;
  defaultAutoContinueTokenBudget: () => number;
  autoContinueTickMs: number;
  buildMissionControlGraph: (initiativeId: string) => Promise<unknown>;
  applyLocalInitiativeOverrideToGraph: (graph: unknown) => unknown;
  buildNextUpQueue: (input: { initiativeId: string | null }) => Promise<NextUpQueue>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerMissionControlReadRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterMissionControlReadRoutesDeps<TRes>
): void {
  async function renderAutoContinueStatus(query: URLSearchParams, res: TRes): Promise<void> {
    const initiativeId = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const id = initiativeId.trim();
    if (!id) {
      deps.sendJson(res, 400, {
        ok: false,
        error: "Query parameter 'initiative_id' is required.",
      });
      return;
    }

    const run = deps.autoContinueRuns.get(id) ?? null;
    deps.sendJson(res, 200, {
      ok: true,
      initiativeId: id,
      run,
      defaults: {
        tokenBudget: deps.defaultAutoContinueTokenBudget(),
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
      deps.sendJson(res, 400, {
        error: "Query parameter 'initiative_id' is required.",
      });
      return;
    }

    try {
      const graph = deps.applyLocalInitiativeOverrideToGraph(
        await deps.buildMissionControlGraph(initiativeId.trim())
      );
      deps.sendJson(res, 200, graph);
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        error: deps.safeErrorMessage(err),
      });
    }
  }

  async function renderNextUpQueue(query: URLSearchParams, res: TRes): Promise<void> {
    const initiativeIdRaw = query.get("initiative_id") ?? query.get("initiativeId") ?? "";
    const initiativeId = initiativeIdRaw.trim() || null;

    try {
      const queue = await deps.buildNextUpQueue({ initiativeId });
      deps.sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        total: queue.items.length,
        items: queue.items,
        degraded: queue.degraded,
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        ok: false,
        error: deps.safeErrorMessage(err),
      });
    }
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
}
