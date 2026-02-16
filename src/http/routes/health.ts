import type { Router } from "../router.js";

type HealthDiagnostics = {
  getHealth?: (input: { probeRemote: boolean }) => Promise<unknown>;
};

type HealthRouteDeps<TRes> = {
  diagnostics?: HealthDiagnostics;
  readOutboxSummary: () => Promise<{
    pendingTotal: number;
    pendingByQueue: Record<string, number>;
    oldestEventAt: string | null;
    newestEventAt: string | null;
  }>;
  parseBooleanQuery: (value: string | null) => boolean;
  baseUrl: string;
  hasApiKey: boolean;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerHealthRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: HealthRouteDeps<TRes>
): void {
  async function handleHealth(query: URLSearchParams, res: TRes): Promise<void> {
    const probeRemote = deps.parseBooleanQuery(
      query.get("probe") ?? query.get("probe_remote")
    );
    try {
      if (deps.diagnostics?.getHealth) {
        const health = await deps.diagnostics.getHealth({ probeRemote });
        deps.sendJson(res, 200, health);
        return;
      }

      const outbox = await deps.readOutboxSummary();
      deps.sendJson(res, 200, {
        ok: true,
        status: "ok",
        generatedAt: new Date().toISOString(),
        checks: [],
        plugin: {
          baseUrl: deps.baseUrl,
        },
        auth: {
          hasApiKey: deps.hasApiKey,
        },
        outbox: {
          pendingTotal: outbox.pendingTotal,
          pendingByQueue: outbox.pendingByQueue,
          oldestEventAt: outbox.oldestEventAt,
          newestEventAt: outbox.newestEventAt,
          replayStatus: "idle",
          lastReplayAttemptAt: null,
          lastReplaySuccessAt: null,
          lastReplayFailureAt: null,
          lastReplayError: null,
        },
        remote: {
          enabled: false,
          reachable: null,
          latencyMs: null,
          error: null,
        },
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add(
    "GET",
    "health",
    async ({ query, res }) => handleHealth(query, res),
    "Health summary"
  );
  router.add(
    "HEAD",
    "health",
    async ({ query, res }) => handleHealth(query, res),
    "Health summary (HEAD)"
  );
}
