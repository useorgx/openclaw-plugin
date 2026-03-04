import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RegisterEntityDynamicRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  rawRequest: (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ) => Promise<unknown>;
  listEntityComments: (entityType: string, entityId: string) => unknown[];
  mergeEntityComments: (remote: unknown, local: unknown[]) => unknown[];
  appendEntityComment: (input: {
    entityType: string;
    entityId: string;
    body: string;
    commentType: string;
    severity: string;
    tags: unknown;
  }) => unknown;
  updateEntity: (
    type: string,
    id: string,
    updates: Record<string, unknown>
  ) => Promise<unknown>;
  setLocalInitiativeStatusOverride: (initiativeId: string, status: string) => void;
  clearLocalInitiativeStatusOverride: (initiativeId: string) => void;
  isUnauthorizedOrgxError: (err: unknown) => boolean;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function resolveEntityActionStatus(
  entityType: string,
  entityAction: string
): string | null {
  const normalizedType = entityType.trim().toLowerCase();
  const normalizedAction = entityAction.trim().toLowerCase();

  const defaultStatusMap: Record<string, string> = {
    start: "in_progress",
    complete: "done",
    block: "blocked",
    unblock: "in_progress",
    pause: "paused",
    resume: "active",
  };

  const statusMapByEntityType: Record<string, Record<string, string>> = {
    initiative: {
      start: "active",
      complete: "completed",
      block: "blocked",
      unblock: "active",
      pause: "paused",
      resume: "active",
    },
    workstream: {
      start: "active",
      complete: "completed",
      block: "blocked",
      unblock: "active",
      pause: "paused",
      resume: "active",
    },
    milestone: {
      start: "in_progress",
      complete: "completed",
      block: "at_risk",
      unblock: "in_progress",
      pause: "planned",
      resume: "in_progress",
    },
    task: {
      start: "in_progress",
      complete: "done",
      block: "blocked",
      unblock: "in_progress",
      pause: "todo",
      resume: "in_progress",
    },
  };

  const map = statusMapByEntityType[normalizedType] ?? defaultStatusMap;
  return map[normalizedAction] ?? null;
}

export function registerEntityDynamicRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterEntityDynamicRoutesDeps<TReq, TRes>
): void {
  router.add(
    "*",
    "entities/*",
    async ({ req, res, path }) => {
      const method = ((req as { method?: string }).method ?? "GET").toUpperCase();
      const entityCommentsMatch = path.match(/^entities\/([^/]+)\/([^/]+)\/comments$/);
      if (entityCommentsMatch) {
        if (method !== "GET" && method !== "POST") {
          deps.sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const entityType = decodeURIComponent(entityCommentsMatch[1]);
          const entityId = decodeURIComponent(entityCommentsMatch[2]);
          if (!entityType || !entityId) {
            deps.sendJson(res, 400, {
              ok: false,
              error: "entity type and id are required",
            });
            return;
          }

          const commentsPath = `/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/comments`;
          if (method === "GET") {
            const local = deps.listEntityComments(entityType, entityId);
            try {
              const data = (await deps.rawRequest("GET", commentsPath)) as {
                comments?: unknown;
              };
              const comments = deps.mergeEntityComments(data?.comments, local);
              if (data && typeof data === "object") {
                deps.sendJson(res, 200, { ...data, comments });
              } else {
                deps.sendJson(res, 200, { status: "success", comments, nextCursor: null });
              }
            } catch (err: unknown) {
              deps.sendJson(res, 200, {
                status: "success",
                comments: local,
                nextCursor: null,
                localFallback: true,
                warning: deps.safeErrorMessage(err),
              });
            }
            return;
          }

          const payload = await deps.parseJsonRequest(req);
          const body =
            deps.pickString(payload, ["body", "comment", "text", "message"]) ?? "";
          if (!body.trim()) {
            deps.sendJson(res, 400, { ok: false, error: "comment body is required" });
            return;
          }
          const commentType =
            deps.pickString(payload, ["comment_type", "commentType", "type"]) ?? "note";
          const severity = deps.pickString(payload, ["severity", "level"]) ?? "info";
          const tags = payload.tags;

          const normalizedPayload: Record<string, unknown> = {
            body,
            comment_type: commentType,
            severity,
            tags,
            parent_comment_id: null,
          };

          try {
            const data = await deps.rawRequest("POST", commentsPath, normalizedPayload);
            deps.sendJson(res, 200, data);
          } catch (err: unknown) {
            const warning = deps.safeErrorMessage(err);
            try {
              const comment = deps.appendEntityComment({
                entityType,
                entityId,
                body,
                commentType,
                severity,
                tags,
              });
              deps.sendJson(res, 200, {
                status: "success",
                comment,
                localFallback: true,
                warning,
              });
            } catch (localErr: unknown) {
              deps.sendJson(res, 500, {
                ok: false,
                error: warning || "Unable to save comment",
                localError: deps.safeErrorMessage(localErr),
              });
            }
          }
        } catch (err: unknown) {
          deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
        }
        return;
      }

      const entityActionMatch = path.match(/^entities\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (entityActionMatch) {
        if (method !== "POST") {
          deps.sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const entityType = decodeURIComponent(entityActionMatch[1]);
          const entityId = decodeURIComponent(entityActionMatch[2]);
          const entityAction = decodeURIComponent(entityActionMatch[3]);
          const payload = await deps.parseJsonRequest(req);
          const normalizedEntityType = entityType.trim().toLowerCase();

          if (entityAction === "delete") {
            const deleteStatus = normalizedEntityType === "initiative" ? "archived" : "deleted";
            try {
              const entity = await deps.updateEntity(entityType, entityId, {
                status: deleteStatus,
              });
              if (normalizedEntityType === "initiative") {
                deps.clearLocalInitiativeStatusOverride(entityId);
              }
              deps.sendJson(res, 200, { ok: true, entity, deletedAsStatus: deleteStatus });
            } catch (err: unknown) {
              if (
                normalizedEntityType === "initiative" &&
                deps.isUnauthorizedOrgxError(err)
              ) {
                deps.setLocalInitiativeStatusOverride(entityId, deleteStatus);
                deps.sendJson(res, 200, {
                  ok: true,
                  localFallback: true,
                  warning: deps.safeErrorMessage(err),
                  entity: {
                    id: entityId,
                    type: entityType,
                    status: deleteStatus,
                  },
                  deletedAsStatus: deleteStatus,
                });
                return;
              }
              throw err;
            }
            return;
          }

          const newStatus = resolveEntityActionStatus(entityType, entityAction);
          if (!newStatus) {
            deps.sendJson(res, 400, {
              error: `Unknown entity action: ${entityAction}`,
            });
            return;
          }

          try {
            const entity = await deps.updateEntity(entityType, entityId, {
              status: newStatus,
              ...(payload.force ? { force: true } : {}),
            });
            if (normalizedEntityType === "initiative") {
              deps.clearLocalInitiativeStatusOverride(entityId);
            }
            deps.sendJson(res, 200, { ok: true, entity });
          } catch (err: unknown) {
            if (
              normalizedEntityType === "initiative" &&
              deps.isUnauthorizedOrgxError(err)
            ) {
              deps.setLocalInitiativeStatusOverride(entityId, newStatus);
              deps.sendJson(res, 200, {
                ok: true,
                localFallback: true,
                warning: deps.safeErrorMessage(err),
                entity: {
                  id: entityId,
                  type: entityType,
                  status: newStatus,
                },
              });
              return;
            }
            throw err;
          }
        } catch (err: unknown) {
          deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
        }
        return;
      }

      deps.sendJson(res, 404, { error: "Unknown API endpoint" });
    },
    "Dynamic entity comments/actions"
  );
}
