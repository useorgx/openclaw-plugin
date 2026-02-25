import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RegisterRealtimeOrchestratorRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  rawRequest: (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ) => Promise<unknown>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function parseStatusCodeFromError(message: string): number {
  const normalized = message.trim();
  const match = normalized.match(/^(\d{3})\b/);
  if (!match) return 500;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 500;
  if (value < 400 || value > 599) return 500;
  return value;
}

export function registerRealtimeOrchestratorRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterRealtimeOrchestratorRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "realtime/session",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const upstream = await deps.rawRequest(
          "POST",
          "/api/client/orchestrator/realtime/session",
          payload
        );
        deps.sendJson(res, 200, upstream);
      } catch (err) {
        const message = deps.safeErrorMessage(err);
        deps.sendJson(res, parseStatusCodeFromError(message), { ok: false, error: message });
      }
    },
    "Create an ephemeral GPT realtime session for orchestrator voice control"
  );

  router.add(
    "POST",
    "orchestrator/commands/preview",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const upstream = await deps.rawRequest(
          "POST",
          "/api/client/orchestrator/commands/preview",
          payload
        );
        deps.sendJson(res, 200, upstream);
      } catch (err) {
        const message = deps.safeErrorMessage(err);
        deps.sendJson(res, parseStatusCodeFromError(message), { ok: false, error: message });
      }
    },
    "Preview inferred orchestrator actions from natural language input"
  );

  router.add(
    "POST",
    "orchestrator/commands/apply",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const upstream = await deps.rawRequest(
          "POST",
          "/api/client/orchestrator/commands/apply",
          payload
        );
        deps.sendJson(res, 200, upstream);
      } catch (err) {
        const message = deps.safeErrorMessage(err);
        deps.sendJson(res, parseStatusCodeFromError(message), { ok: false, error: message });
      }
    },
    "Apply confirmed orchestrator actions"
  );

  router.add(
    "GET",
    "orchestrator/commands/*",
    async ({ path, res }) => {
      const match = path.match(/^orchestrator\/commands\/([^/]+)$/);
      if (!match) {
        deps.sendJson(res, 404, { ok: false, error: "Unknown API endpoint" });
        return;
      }
      let commandId = "";
      try {
        commandId = decodeURIComponent(match[1] ?? "").trim();
      } catch {
        deps.sendJson(res, 400, { ok: false, error: "invalid command id encoding" });
        return;
      }
      if (!commandId) {
        deps.sendJson(res, 400, { ok: false, error: "command id is required" });
        return;
      }
      try {
        const upstream = await deps.rawRequest(
          "GET",
          `/api/client/orchestrator/commands/${encodeURIComponent(commandId)}`
        );
        deps.sendJson(res, 200, upstream);
      } catch (err) {
        const message = deps.safeErrorMessage(err);
        deps.sendJson(res, parseStatusCodeFromError(message), { ok: false, error: message });
      }
    },
    "Read orchestrator command status"
  );
}
