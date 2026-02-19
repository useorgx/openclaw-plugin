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

type NextUpQueue = {
  items: unknown[];
  degraded: string[];
};

type RegisterMissionControlReadRoutesDeps<TRes> = {
  autoContinueRuns: Map<string, AutoContinueRunRecord>;
  defaultAutoContinueTokenBudget: () => number | null;
  defaultAutoContinueMaxParallelSlices?: () => number;
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
      sendRouteException(res, "mission-control.read.next-up.handler", err);
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
