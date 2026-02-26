import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type DecisionAction = "approve" | "reject";

type RegisterDecisionActionsRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  bulkDecideDecisions: (
    ids: string[],
    action: DecisionAction,
    input?: { note?: string; optionId?: string }
  ) => Promise<Array<{ ok?: boolean }>>;
  emitDecisionResolvedActivity?: (
    ids: string[],
    action: DecisionAction,
    input?: { note?: string; optionId?: string }
  ) => Promise<void>;
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
  const optionIdRaw =
    typeof payload.option_id === "string"
      ? payload.option_id
      : typeof payload.optionId === "string"
      ? payload.optionId
      : null;
  const optionId =
    typeof optionIdRaw === "string" && optionIdRaw.trim().length > 0
      ? optionIdRaw.trim()
      : undefined;
  const ids = routeIds ?? extractIdsFromPayload(payload);

  if (ids.length === 0) {
    deps.sendJson(res, 400, {
      error: "Decision IDs are required.",
      expected: {
        route: "/orgx/api/live/decisions/approve",
        body: { ids: ["decision-id"], action: "approve|reject", option_id: "optional-option-id" },
      },
    });
    return;
  }

  const results = await deps.bulkDecideDecisions(ids, action, {
    note,
    optionId,
  });
  const resolvedIds = results
    .map((result, index) => (result.ok === true ? ids[index] ?? null : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const updated = results.filter((result) => result.ok === true).length;
  const failed = results.length - updated;

  if (resolvedIds.length > 0 && typeof deps.emitDecisionResolvedActivity === "function") {
    try {
      await deps.emitDecisionResolvedActivity(resolvedIds, action, {
        note,
        optionId,
      });
    } catch {
      // best effort; decision mutation succeeded so do not fail the response
    }
  }

  deps.sendJson(res, failed > 0 ? 207 : 200, {
    action,
    requested: ids.length,
    updated,
    failed,
    results,
  });
}

function decodeDecisionId(encodedDecisionId: string): string | null {
  try {
    const decoded = decodeURIComponent(encodedDecisionId).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
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
      const decisionId = decodeDecisionId(decisionApproveMatch[1]);
      if (!decisionId) {
        deps.sendJson(res, 400, { error: "Invalid decision ID." });
        return;
      }

      try {
        await handleApproveRequest(req, res, deps, [decisionId]);
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Single decision approve/reject"
  );
}
