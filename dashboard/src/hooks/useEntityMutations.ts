import { useMutation, useQueryClient } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';

async function throwOnError(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      (typeof body?.error === 'string' && body.error) ||
      (typeof body?.message === 'string' && body.message) ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return res;
}

interface MutationContext {
  authToken?: string | null;
  embedMode?: boolean;
}

interface CreateEntityInput {
  type: string;
  title: string;
  summary?: string;
  status?: string;
  initiative_id?: string;
  workstream_id?: string;
  [key: string]: unknown;
}

interface UpdateEntityInput {
  type: string;
  id: string;
  [key: string]: unknown;
}

interface DeleteEntityInput {
  type: string;
  id: string;
}

interface EntityActionInput {
  type: string;
  id: string;
  action: string;
  force?: boolean;
}

interface BulkEntityItem {
  type: string;
  id: string;
}

interface BulkEntityMutationInput {
  items: BulkEntityItem[];
  mode: 'action' | 'update' | 'delete';
  action?: string;
  force?: boolean;
  updates?: Record<string, unknown>;
}

interface BulkEntityMutationResult {
  updated: number;
  failed: number;
  errors: string[];
}

function mapInitiativeStatus(rawStatus: string): string {
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  if (normalized === 'blocked' || normalized === 'at_risk') return 'blocked';
  if (normalized === 'paused' || normalized === 'hold') return 'paused';
  if (normalized === 'deleted' || normalized === 'archived' || normalized === 'cancelled') {
    return 'completed';
  }
  return 'active';
}

function isHiddenInitiativeStatus(rawStatus: string): boolean {
  const normalized = rawStatus.trim().toLowerCase();
  return normalized === 'deleted' || normalized === 'archived' || normalized === 'cancelled';
}

function mapInitiativeStatusToSessionStatus(rawStatus: string): string {
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === 'blocked' || normalized === 'at_risk') return 'blocked';
  if (normalized === 'paused' || normalized === 'hold') return 'paused';
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  return 'running';
}

export function useEntityMutations(ctx: MutationContext) {
  const queryClient = useQueryClient();
  const headers = buildOrgxHeaders({
    authToken: ctx.authToken,
    embedMode: ctx.embedMode,
    contentTypeJson: true,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['live-data'] });
    queryClient.invalidateQueries({ queryKey: ['live-initiatives'] });
    queryClient.invalidateQueries({ queryKey: ['initiative-details'] });
    queryClient.invalidateQueries({ queryKey: ['entities'] });
    queryClient.invalidateQueries({ queryKey: ['mission-control-graph'] });
    queryClient.invalidateQueries({ queryKey: ['mission-control-next-up'] });
  };

  const patchInitiativeTombstone = (initiativeId: string, hidden: boolean) => {
    queryClient.setQueryData(['initiative-tombstones'], (current: unknown) => {
      const list = Array.isArray(current)
        ? current.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const hasId = list.includes(initiativeId);
      if (hidden) {
        return hasId ? list : [...list, initiativeId];
      }
      if (!hasId) return list;
      return list.filter((id) => id !== initiativeId);
    });
  };

  const patchInitiativeCaches = (initiativeId: string, rawStatus: string) => {
    const mappedStatus = mapInitiativeStatus(rawStatus);
    const updatedAt = new Date().toISOString();
    const shouldRemove = isHiddenInitiativeStatus(rawStatus);
    patchInitiativeTombstone(initiativeId, shouldRemove);

    const patchCollection = (current: unknown): unknown => {
      if (!Array.isArray(current)) return current;
      if (shouldRemove) {
        const next = current.filter((entry) => {
          if (!entry || typeof entry !== 'object') return true;
          const row = entry as Record<string, unknown>;
          return !(typeof row.id === 'string' && row.id === initiativeId);
        });
        return next.length === current.length ? current : next;
      }
      let changed = false;
      const next = current.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== 'string' || row.id !== initiativeId) return entry;
        changed = true;
        return {
          ...row,
          status: mappedStatus,
          rawStatus,
          updatedAt,
        };
      });
      return changed ? next : current;
    };

    queryClient.setQueriesData({ queryKey: ['entities'] }, patchCollection);
    queryClient.setQueriesData({ queryKey: ['live-initiatives'] }, patchCollection);
  };

  const patchLiveDataInitiative = (
    initiativeId: string,
    rawStatus: string,
    mode: 'status' | 'delete' = 'status'
  ) => {
    const sessionStatus = mapInitiativeStatusToSessionStatus(rawStatus);

    queryClient.setQueriesData({ queryKey: ['live-data'] }, (current: unknown): unknown => {
      if (!current || typeof current !== 'object') return current;
      const payload = current as Record<string, unknown>;
      const sessionsRaw = payload.sessions;
      if (!sessionsRaw || typeof sessionsRaw !== 'object') return current;
      const sessions = sessionsRaw as Record<string, unknown>;
      const nodesRaw = sessions.nodes;
      if (!Array.isArray(nodesRaw)) return current;

      let changed = false;
      const nextNodes =
        mode === 'delete'
          ? nodesRaw.filter((node) => {
              if (!node || typeof node !== 'object') return true;
              const row = node as Record<string, unknown>;
              const nodeInitiativeId =
                typeof row.initiativeId === 'string' ? row.initiativeId : null;
              const shouldRemove = nodeInitiativeId === initiativeId;
              if (shouldRemove) changed = true;
              return !shouldRemove;
            })
          : nodesRaw.map((node) => {
              if (!node || typeof node !== 'object') return node;
              const row = node as Record<string, unknown>;
              const nodeInitiativeId =
                typeof row.initiativeId === 'string' ? row.initiativeId : null;
              if (nodeInitiativeId !== initiativeId) return node;
              if (row.status === sessionStatus) return node;
              changed = true;
              return {
                ...row,
                status: sessionStatus,
              };
            });

      if (!changed) return current;

      const nodeIds = new Set<string>();
      const groupIds = new Set<string>();
      for (const node of nextNodes) {
        if (!node || typeof node !== 'object') continue;
        const row = node as Record<string, unknown>;
        if (typeof row.id === 'string') nodeIds.add(row.id);
        if (typeof row.groupId === 'string') groupIds.add(row.groupId);
      }

      const nextEdges = Array.isArray(sessions.edges)
        ? sessions.edges.filter((edge) => {
            if (!edge || typeof edge !== 'object') return false;
            const row = edge as Record<string, unknown>;
            const parentId = typeof row.parentId === 'string' ? row.parentId : null;
            const childId = typeof row.childId === 'string' ? row.childId : null;
            return (
              parentId !== null &&
              childId !== null &&
              nodeIds.has(parentId) &&
              nodeIds.has(childId)
            );
          })
        : sessions.edges;

      const nextGroups = Array.isArray(sessions.groups)
        ? sessions.groups.filter((group) => {
            if (!group || typeof group !== 'object') return false;
            const row = group as Record<string, unknown>;
            return typeof row.id === 'string' && groupIds.has(row.id);
          })
        : sessions.groups;

      return {
        ...payload,
        sessions: {
          ...sessions,
          nodes: nextNodes,
          edges: nextEdges,
          groups: nextGroups,
        },
      };
    });
  };

  const entityActionToStatus: Record<string, string> = {
    start: 'in_progress',
    complete: 'done',
    block: 'blocked',
    unblock: 'in_progress',
    pause: 'paused',
    resume: 'active',
  };

  const createEntity = useMutation({
    mutationFn: async (input: CreateEntityInput) => {
      const { type, ...data } = input;
      const res = await fetch('/orgx/api/entities', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type, ...data }),
      });
      await throwOnError(res);
      return res.json();
    },
    onSuccess: invalidateAll,
  });

  const updateEntity = useMutation({
    mutationFn: async (input: UpdateEntityInput) => {
      const { type, id, ...updates } = input;
      const res = await fetch('/orgx/api/entities', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ type, id, ...updates }),
      });
      await throwOnError(res);
      return res.json();
    },
    onSuccess: (_, input) => {
      if (
        input.type.trim().toLowerCase() === 'initiative' &&
        typeof input.status === 'string' &&
        input.status.trim().length > 0
      ) {
        patchInitiativeCaches(input.id, input.status);
        patchLiveDataInitiative(
          input.id,
          input.status,
          isHiddenInitiativeStatus(input.status) ? 'delete' : 'status'
        );
      }
      invalidateAll();
    },
  });

  const deleteEntity = useMutation({
    mutationFn: async (input: DeleteEntityInput) => {
      const res = await fetch(
        `/orgx/api/entities/${encodeURIComponent(input.type)}/${encodeURIComponent(input.id)}/delete`,
        { method: 'POST', headers, body: '{}' },
      );
      await throwOnError(res);
      return res.json();
    },
    onSuccess: (_, input) => {
      if (input.type.trim().toLowerCase() === 'initiative') {
        patchInitiativeCaches(input.id, 'archived');
        patchLiveDataInitiative(input.id, 'archived', 'delete');
      }
      invalidateAll();
    },
  });

  const entityAction = useMutation({
    mutationFn: async (input: EntityActionInput) => {
      const res = await fetch(
        `/orgx/api/entities/${encodeURIComponent(input.type)}/${encodeURIComponent(input.id)}/${encodeURIComponent(input.action)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ force: input.force ?? false }),
        },
      );
      await throwOnError(res);
      return res.json();
    },
    onSuccess: (_, input) => {
      if (input.type.trim().toLowerCase() === 'initiative') {
        const rawStatus = entityActionToStatus[input.action.trim().toLowerCase()];
        if (rawStatus) {
          patchInitiativeCaches(input.id, rawStatus);
          patchLiveDataInitiative(input.id, rawStatus, 'status');
        }
      }
      invalidateAll();
    },
  });

  const bulkEntityMutation = useMutation({
    mutationFn: async (
      input: BulkEntityMutationInput
    ): Promise<BulkEntityMutationResult> => {
      const uniqueItems = Array.from(
        new Map(
          (input.items ?? [])
            .filter(
              (item) =>
                typeof item?.type === 'string' &&
                item.type.trim().length > 0 &&
                typeof item?.id === 'string' &&
                item.id.trim().length > 0
            )
            .map((item) => [`${item.type}:${item.id}`, item] as const)
        ).values()
      );

      if (uniqueItems.length === 0) {
        return { updated: 0, failed: 0, errors: [] };
      }

      if (input.mode === 'action' && !input.action) {
        throw new Error('bulk action requires an action name');
      }

      const executeForItem = async (
        item: BulkEntityItem
      ): Promise<{ ok: true } | { ok: false; error: string }> => {
        try {
          if (input.mode === 'delete') {
            const res = await fetch(
              `/orgx/api/entities/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}/delete`,
              { method: 'POST', headers, body: '{}' }
            );
            await throwOnError(res);
            return { ok: true };
          }

          if (input.mode === 'update') {
            const res = await fetch('/orgx/api/entities', {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                type: item.type,
                id: item.id,
                ...(input.updates ?? {}),
              }),
            });
            await throwOnError(res);
            return { ok: true };
          }

          const res = await fetch(
            `/orgx/api/entities/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}/${encodeURIComponent(input.action as string)}`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ force: input.force ?? false }),
            }
          );
          await throwOnError(res);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown bulk mutation failure',
          };
        }
      };

      const settled = await Promise.all(uniqueItems.map((item) => executeForItem(item)));
      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const result of settled) {
        if (result.ok) {
          updated += 1;
        } else {
          failed += 1;
          errors.push(result.error);
        }
      }

      return { updated, failed, errors };
    },
    onSuccess: (_, input) => {
      const initiativeItems = (input.items ?? []).filter(
        (item) => item.type.trim().toLowerCase() === 'initiative'
      );
      if (initiativeItems.length > 0) {
        if (
          input.mode === 'update' &&
          typeof input.updates?.status === 'string' &&
          input.updates.status.trim().length > 0
        ) {
          for (const item of initiativeItems) {
            patchInitiativeCaches(item.id, input.updates.status);
            patchLiveDataInitiative(
              item.id,
              input.updates.status,
              isHiddenInitiativeStatus(input.updates.status) ? 'delete' : 'status'
            );
          }
        } else if (input.mode === 'delete') {
          for (const item of initiativeItems) {
            patchInitiativeCaches(item.id, 'archived');
            patchLiveDataInitiative(item.id, 'archived', 'delete');
          }
        } else if (input.mode === 'action' && input.action) {
          const rawStatus = entityActionToStatus[input.action.trim().toLowerCase()];
          if (rawStatus) {
            for (const item of initiativeItems) {
              patchInitiativeCaches(item.id, rawStatus);
              patchLiveDataInitiative(item.id, rawStatus, 'status');
            }
          }
        }
      }
      invalidateAll();
    },
  });

  return { createEntity, updateEntity, deleteEntity, entityAction, bulkEntityMutation };
}
