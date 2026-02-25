/**
 * Triage queue API routes.
 *
 * GET  /live/triage        – list open triage items (merged decisions + blockers)
 * POST /live/triage/:id/action – act on a triage item
 */

import type {
  LiveTriageItem,
  TriageActionResponse,
  TriageListResponse,
  LiveDecision,
} from "../../contracts/shared-types.js";
import {
  mapDecisionToTriageItem,
  mapFailureToTriageItem,
  deduplicateTriageItems,
} from "../helpers/triage-mapper.js";

interface Router<TState, TReq, TRes> {
  add(
    method: string,
    path: string,
    handler: (ctx: {
      req: TReq;
      res: TRes;
      path: string;
      query: URLSearchParams;
      body: unknown;
      state: TState;
    }) => Promise<void>,
    description?: string
  ): void;
}

export interface RegisterLiveTriageRoutesDeps<TReq, TRes> {
  parseJsonRequest: (req: TReq) => Promise<Record<string, unknown>>;
  sendJson: (res: TRes, status: number, body: unknown) => void;
  getDecisions: (workspaceId?: string | null) => LiveDecision[];
  getBlockerEvents: (workspaceId?: string | null) => Array<{
    id: string;
    failureType: string;
    reason?: string | null;
    provider?: string | null;
    initiativeId?: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    agentId?: string | null;
    domain?: string | null;
    sourceSystem?: string | null;
    runId?: string | null;
    logPath?: string | null;
    outputPath?: string | null;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }>;
  resolveDecisionAction: (
    decisionId: string,
    action: string,
    note?: string | null,
    optionId?: string | null
  ) => Promise<{ ok: boolean; error?: string }>;
  snoozeTriage?: (
    itemId: string,
    durationMinutes: number
  ) => Promise<{ ok: boolean }>;
  dismissTriage?: (
    itemId: string,
    note?: string
  ) => Promise<{ ok: boolean }>;
}

export function registerLiveTriageRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveTriageRoutesDeps<TReq, TRes>
): void {
  // ─── GET /live/triage ─────────────────────────────────────────────
  router.add(
    "GET",
    "live/triage",
    async ({ res, query }) => {
      const workspaceId = query.get("workspace_id") || null;
      const statusFilter = query.get("status") || "open";
      const limitStr = query.get("limit");
      const limit = limitStr ? Math.min(Math.max(1, parseInt(limitStr, 10) || 50), 200) : 50;

      const degraded: string[] = [];

      // 1. Map existing decisions to triage items
      let decisionItems: LiveTriageItem[] = [];
      try {
        const decisions = deps.getDecisions(workspaceId);
        decisionItems = decisions
          .filter((d) => d.status === "pending")
          .map(mapDecisionToTriageItem);
      } catch {
        degraded.push("decisions");
      }

      // 2. Map blocker events to triage items
      let blockerItems: LiveTriageItem[] = [];
      try {
        const blockerEvents = deps.getBlockerEvents(workspaceId);
        for (const event of blockerEvents) {
          const item = mapFailureToTriageItem(event);
          if (item) blockerItems.push(item);
        }
      } catch {
        degraded.push("blockers");
      }

      // 3. Merge and deduplicate
      let allItems = deduplicateTriageItems([...decisionItems, ...blockerItems]);

      // 4. Filter by status
      if (statusFilter !== "all") {
        allItems = allItems.filter((item) => item.status === statusFilter);
      }

      // 5. Sort: critical first, then by impact, then recency
      allItems.sort((a, b) => {
        const severityOrder: Record<string, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
        };
        const sevDiff =
          (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
        if (sevDiff !== 0) return sevDiff;

        const impactA =
          a.impact.initiativeCount +
          a.impact.workstreamCount +
          a.impact.downstreamBlockedCount;
        const impactB =
          b.impact.initiativeCount +
          b.impact.workstreamCount +
          b.impact.downstreamBlockedCount;
        if (impactB !== impactA) return impactB - impactA;

        return (
          new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
        );
      });

      const total = allItems.length;
      const items = allItems.slice(0, limit);

      const response: TriageListResponse = {
        ok: true,
        items,
        total,
        generatedAt: new Date().toISOString(),
        ...(degraded.length > 0 ? { degraded } : {}),
      };

      deps.sendJson(res, 200, response);
    },
    "List triage items (merged decisions + blockers)"
  );

  // ─── POST /live/triage/:id/action ─────────────────────────────────
  router.add(
    "POST",
    "live/triage/action",
    async ({ req, res, query }) => {
      const itemId = query.get("id");
      if (!itemId) {
        deps.sendJson(res, 400, { ok: false, error: "Missing triage item id" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await deps.parseJsonRequest(req);
      } catch {
        deps.sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const action = typeof body.action === "string" ? body.action : null;
      if (!action) {
        deps.sendJson(res, 400, { ok: false, error: "Missing action field" });
        return;
      }

      const note =
        typeof body.note === "string" ? body.note : null;
      const optionId =
        typeof body.optionId === "string" ? body.optionId : null;
      const snoozeDurationMinutes =
        typeof body.snoozeDurationMinutes === "number"
          ? body.snoozeDurationMinutes
          : null;

      const sideEffects: string[] = [];
      let itemStatus = "open";
      let continuationPlan: string | null = null;

      // Route action based on item type
      if (itemId.startsWith("triage-decision-")) {
        const decisionId = itemId.replace("triage-decision-", "");

        if (action === "approve" || action === "reject") {
          const result = await deps.resolveDecisionAction(
            decisionId,
            action,
            note,
            optionId
          );
          if (!result.ok) {
            deps.sendJson(res, 500, {
              ok: false,
              error: result.error ?? "Decision action failed",
            });
            return;
          }
          itemStatus = "resolved";
          sideEffects.push(
            action === "approve"
              ? "Decision approved; agent will continue."
              : "Decision rejected; agent paused."
          );
          continuationPlan =
            action === "approve"
              ? "Agent will resume with approved direction."
              : null;
        } else if (action === "snooze" && deps.snoozeTriage) {
          await deps.snoozeTriage(itemId, snoozeDurationMinutes ?? 60);
          itemStatus = "snoozed";
          sideEffects.push(
            `Snoozed for ${snoozeDurationMinutes ?? 60} minutes.`
          );
        } else if (action === "dismiss" && deps.dismissTriage) {
          await deps.dismissTriage(itemId, note ?? undefined);
          itemStatus = "dismissed";
          sideEffects.push("Dismissed. Will not re-raise until root cause changes.");
        } else {
          deps.sendJson(res, 400, {
            ok: false,
            error: `Unsupported action: ${action}`,
          });
          return;
        }
      } else {
        // Non-decision triage items
        if (action === "snooze" && deps.snoozeTriage) {
          await deps.snoozeTriage(itemId, snoozeDurationMinutes ?? 60);
          itemStatus = "snoozed";
          sideEffects.push(
            `Snoozed for ${snoozeDurationMinutes ?? 60} minutes.`
          );
        } else if (action === "dismiss" && deps.dismissTriage) {
          await deps.dismissTriage(itemId, note ?? undefined);
          itemStatus = "dismissed";
          sideEffects.push("Dismissed.");
        } else if (action === "retry") {
          itemStatus = "open";
          sideEffects.push("Retry queued.");
          continuationPlan = "Will re-attempt the failed operation.";
        } else {
          deps.sendJson(res, 400, {
            ok: false,
            error: `Unsupported action: ${action} for item ${itemId}`,
          });
          return;
        }
      }

      const response: TriageActionResponse = {
        ok: true,
        itemStatus: itemStatus as "open" | "snoozed" | "resolved" | "dismissed",
        continuationPlan,
        sideEffects,
      };

      deps.sendJson(res, 200, response);
    },
    "Perform action on a triage item"
  );
}
