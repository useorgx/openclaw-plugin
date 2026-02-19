import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RunAction = "pause" | "resume" | "cancel" | "rollback" | "complete";

type RegisterRunControlRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  listRunCheckpoints: (runId: string) => Promise<unknown>;
  createRunCheckpoint: (
    runId: string,
    input: { reason?: string; payload?: Record<string, unknown> }
  ) => Promise<unknown>;
  restoreRunCheckpoint: (
    runId: string,
    input: { checkpointId: string; reason?: string }
  ) => Promise<unknown>;
  runAction: (
    runId: string,
    action: Exclude<RunAction, "complete">,
    input: { checkpointId?: string; reason?: string }
  ) => Promise<unknown>;
  markRunCompleted: (
    runId: string,
    input: { reason?: string }
  ) => Promise<unknown>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerRunControlRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterRunControlRoutesDeps<TReq, TRes>
): void {
  router.add(
    "*",
    "runs/*",
    async ({ req, res, path }) => {
      const method = ((req as { method?: string }).method ?? "GET").toUpperCase();
      const runCheckpointsMatch = path.match(/^runs\/([^/]+)\/checkpoints$/);
      const runCheckpointRestoreMatch = path.match(
        /^runs\/([^/]+)\/checkpoints\/([^/]+)\/restore$/
      );
      const runActionMatch = path.match(/^runs\/([^/]+)\/actions\/([^/]+)$/);

      if (runCheckpointsMatch) {
        const runId = decodeURIComponent(runCheckpointsMatch[1]);

        if (method === "POST") {
          try {
            const payload = await deps.parseJsonRequest(req);
            const reason = deps.pickString(payload, ["reason"]) ?? undefined;
            const rawPayload = payload.payload;
            const checkpointPayload =
              rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
                ? (rawPayload as Record<string, unknown>)
                : undefined;

            const data = await deps.createRunCheckpoint(runId, {
              reason,
              payload: checkpointPayload,
            });
            deps.sendJson(res, 200, data);
          } catch (err: unknown) {
            deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
          }
          return;
        }

        if (method === "GET" || method === "HEAD") {
          try {
            const data = await deps.listRunCheckpoints(runId);
            deps.sendJson(res, 200, data);
          } catch (err: unknown) {
            deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
          }
          return;
        }

        deps.sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      if (runCheckpointRestoreMatch) {
        if (method !== "POST") {
          deps.sendJson(res, 405, { error: "Use POST for this endpoint" });
          return;
        }
        try {
          const runId = decodeURIComponent(runCheckpointRestoreMatch[1]);
          const checkpointId = decodeURIComponent(runCheckpointRestoreMatch[2]);
          const payload = await deps.parseJsonRequest(req);
          const reason = deps.pickString(payload, ["reason"]) ?? undefined;
          const data = await deps.restoreRunCheckpoint(runId, {
            checkpointId,
            reason,
          });
          deps.sendJson(res, 200, data);
        } catch (err: unknown) {
          deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
        }
        return;
      }

      if (runActionMatch) {
        if (method !== "POST") {
          deps.sendJson(res, 405, { error: "Use POST for this endpoint" });
          return;
        }
        try {
          const runId = decodeURIComponent(runActionMatch[1]);
          const action = decodeURIComponent(runActionMatch[2]) as RunAction;
          const payload = await deps.parseJsonRequest(req);
          const checkpointId = deps.pickString(payload, ["checkpointId", "checkpoint_id"]);
          const reason = deps.pickString(payload, ["reason"]);
          if (action === "complete") {
            const data = await deps.markRunCompleted(runId, {
              reason: reason ?? undefined,
            });
            deps.sendJson(res, 200, data);
            return;
          }
          const data = await deps.runAction(runId, action, {
            checkpointId: checkpointId ?? undefined,
            reason: reason ?? undefined,
          });
          deps.sendJson(res, 200, data);
        } catch (err: unknown) {
          const actionLabel = runActionMatch ? runActionMatch[2] : "unknown";
          const runLabel = runActionMatch ? runActionMatch[1] : "unknown";
          console.error(`[run-control] ${actionLabel} failed for run ${runLabel}:`, err);
          deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
        }
        return;
      }

      deps.sendJson(res, 404, { error: "Unknown API endpoint" });
    },
    "Run control (checkpoints/actions)"
  );
}
