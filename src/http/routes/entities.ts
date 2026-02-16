import type { Entity, OrgSnapshot } from "../../types.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type AutoAssignmentResult = {
  ok: boolean;
  assignment_source: "orchestrator" | "fallback" | "manual";
  assigned_agents: unknown[];
  warnings: string[];
  updated_entity?: Entity;
};

type EntityClientLike = {
  createEntity: (type: string, data: Record<string, unknown>) => Promise<Entity>;
  updateEntity: (
    type: string,
    id: string,
    updates: Record<string, unknown>
  ) => Promise<Entity>;
  listEntities: (
    type: string,
    input: {
      status?: string;
      initiative_id?: string;
      limit?: number;
    }
  ) => Promise<unknown>;
};

type RegisterEntitiesRoutesDeps<TReq, TRes> = {
  client: EntityClientLike;
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  normalizeEntityMutationPayload: (input: Record<string, unknown>) => Record<string, unknown>;
  resolveAutoAssignments: (input: {
    entityId: string;
    entityType: string;
    initiativeId: string | null;
    title: string;
    summary: string | null;
  }) => Promise<AutoAssignmentResult>;
  setLocalInitiativeStatusOverride: (initiativeId: string, status: string) => void;
  clearLocalInitiativeStatusOverride: (initiativeId: string) => void;
  isUnauthorizedOrgxError: (err: unknown) => boolean;
  applyLocalInitiativeOverrides: (
    rows: Array<Record<string, unknown>>
  ) => Array<Record<string, unknown>>;
  formatInitiatives: (
    snapshot: OrgSnapshot | null
  ) => Array<{
    id: string;
    title: string;
    status: string;
    progress?: number | null;
  }>;
  getSnapshot: () => OrgSnapshot | null;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerEntitiesRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterEntitiesRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "entities",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const type = deps.pickString(payload, ["type"]);
        const title = deps.pickString(payload, ["title", "name"]);

        if (!type || !title) {
          deps.sendJson(res, 400, {
            error: "Both 'type' and 'title' are required.",
          });
          return;
        }

        const data = deps.normalizeEntityMutationPayload({ ...payload, title });
        delete data.type;

        let entity = await deps.client.createEntity(type, data);
        let autoAssignment: AutoAssignmentResult | null = null;

        if (type === "initiative" || type === "workstream") {
          const entityRecord = entity as Record<string, unknown>;
          autoAssignment = await deps.resolveAutoAssignments({
            entityId: String(entityRecord.id ?? ""),
            entityType: type,
            initiativeId:
              type === "initiative"
                ? String(entityRecord.id ?? "")
                : deps.pickString(data, ["initiative_id", "initiativeId"]),
            title:
              deps.pickString(entityRecord, ["title", "name"]) ?? title ?? "Untitled",
            summary:
              deps.pickString(entityRecord, ["summary", "description", "context"]) ?? null,
          });
          if (autoAssignment.updated_entity) {
            entity = autoAssignment.updated_entity;
          }
        }

        deps.sendJson(res, 201, { ok: true, entity, auto_assignment: autoAssignment });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Create entity"
  );

  router.add(
    "PATCH",
    "entities",
    async ({ req, res }) => {
      let payload: Record<string, unknown> = {};
      let type: string | null = null;
      let id: string | null = null;
      let requestedStatus: string | null = null;
      try {
        payload = await deps.parseJsonRequest(req);
        type = deps.pickString(payload, ["type"]);
        id = deps.pickString(payload, ["id"]);
        requestedStatus = deps.pickString(payload, ["status"]);

        if (!type || !id) {
          deps.sendJson(res, 400, {
            error: "Both 'type' and 'id' are required for PATCH.",
          });
          return;
        }

        const updates = { ...payload };
        delete updates.type;
        delete updates.id;

        const normalizedType = type.trim().toLowerCase();
        const normalizedUpdates = deps.normalizeEntityMutationPayload(updates);
        const entity = await deps.client.updateEntity(type, id, normalizedUpdates);
        if (normalizedType === "initiative") {
          deps.clearLocalInitiativeStatusOverride(id);
        }
        deps.sendJson(res, 200, { ok: true, entity });
      } catch (err: unknown) {
        if (
          type?.trim().toLowerCase() === "initiative" &&
          id &&
          requestedStatus &&
          deps.isUnauthorizedOrgxError(err)
        ) {
          deps.setLocalInitiativeStatusOverride(id, requestedStatus);
          deps.sendJson(res, 200, {
            ok: true,
            localFallback: true,
            warning: deps.safeErrorMessage(err),
            entity: {
              id,
              type,
              status: requestedStatus,
            },
          });
          return;
        }
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Update entity"
  );

  async function renderEntityList(query: URLSearchParams, res: TRes): Promise<void> {
    const type = query.get("type");
    if (!type) {
      deps.sendJson(res, 400, {
        error: "Query parameter 'type' is required for GET /entities.",
      });
      return;
    }

    const status = query.get("status") ?? undefined;
    const initiativeId = query.get("initiative_id") ?? undefined;
    const limit = query.get("limit") ? Number(query.get("limit")) : undefined;

    try {
      const data = await deps.client.listEntities(type, {
        status,
        initiative_id: initiativeId,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      if (type.trim().toLowerCase() === "initiative") {
        const payload = data as Record<string, unknown>;
        const rows = Array.isArray(payload.data)
          ? payload.data.filter(
              (row): row is Record<string, unknown> =>
                Boolean(row && typeof row === "object")
            )
          : [];
        deps.sendJson(res, 200, {
          ...payload,
          data: deps.applyLocalInitiativeOverrides(rows),
        });
        return;
      }
      deps.sendJson(res, 200, data);
    } catch (err: unknown) {
      if (type.trim().toLowerCase() === "initiative" && deps.isUnauthorizedOrgxError(err)) {
        const snapshotInitiatives = deps
          .formatInitiatives(deps.getSnapshot())
          .map((item) => ({
            id: item.id,
            title: item.title,
            name: item.title,
            summary: null,
            status: item.status,
            progress_pct: item.progress ?? null,
            created_at: null,
            updated_at: null,
          }))
          .filter((item) => (initiativeId ? item.id === initiativeId : true));
        deps.sendJson(res, 200, {
          data: deps.applyLocalInitiativeOverrides(snapshotInitiatives),
          localFallback: true,
          warning: deps.safeErrorMessage(err),
        });
        return;
      }
      deps.sendJson(res, 500, {
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add(
    "GET",
    "entities",
    async ({ query, res }) => renderEntityList(query, res),
    "List entities"
  );
  router.add(
    "HEAD",
    "entities",
    async ({ query, res }) => renderEntityList(query, res),
    "List entities (HEAD)"
  );

  router.add(
    "*",
    "entities",
    ({ res }) => {
      deps.sendJson(res, 405, { error: "Method not allowed" });
    },
    "Reject unsupported methods for entities"
  );
}
