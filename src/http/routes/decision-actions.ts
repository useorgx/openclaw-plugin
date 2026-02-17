import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type DecisionAction = "approve" | "reject";

type RegisterDecisionActionsRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  bulkDecideDecisions: (
    ids: string[],
    action: DecisionAction,
    note?: string
  ) => Promise<Array<{ ok?: boolean }>>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function extractIdsFromPayload(payload: JsonRecord): string[] {
  const raw = payload.ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function handleApproveRequest<TReq, TRes>(
  req: TReq,
  res: TRes,
  deps: RegisterDecisionActionsRoutesDeps<TReq, TRes>,
  routeIds: string[] | null
): Promise<void> {
  const payload = await deps.parseJsonRequest(req);
  const action: DecisionAction = payload.action === "reject" ? "reject" : "approve";
  const note =
    typeof payload.note === "string" && payload.note.trim().length > 0
      ? payload.note.trim()
      : undefined;
  const ids = routeIds ?? extractIdsFromPayload(payload);

  if (ids.length === 0) {
    deps.sendJson(res, 400, {
      error: "Decision IDs are required.",
      expected: {
        route: "/orgx/api/live/decisions/approve",
        body: { ids: ["decision-id"], action: "approve|reject" },
      },
    });
    return;
  }

  const results = await deps.bulkDecideDecisions(ids, action, note);
  const updated = results.filter((result) => result.ok === true).length;
  const failed = results.length - updated;

  deps.sendJson(res, failed > 0 ? 207 : 200, {
    action,
    requested: ids.length,
    updated,
    failed,
    results,
  });
}

export function registerDecisionActionsRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterDecisionActionsRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "live/decisions/approve",
    async ({ req, res }) => {
      try {
        await handleApproveRequest(req, res, deps, null);
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Bulk decision approve/reject"
  );

  router.add(
    "POST",
    "live/decisions/*",
    async ({ req, res, path }) => {
      const decisionApproveMatch = path.match(/^live\/decisions\/([^/]+)\/approve$/);
      if (!decisionApproveMatch) {
        deps.sendJson(res, 404, { error: "Unknown API endpoint" });
        return;
      }

      try {
        await handleApproveRequest(req, res, deps, [
          decodeURIComponent(decisionApproveMatch[1]),
        ]);
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Single decision approve/reject"
  );
}
