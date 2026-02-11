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

export function useEntityMutations(ctx: MutationContext) {
  const queryClient = useQueryClient();
  const headers = buildOrgxHeaders({
    authToken: ctx.authToken,
    embedMode: ctx.embedMode,
    contentTypeJson: true,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['live-data'] });
    queryClient.invalidateQueries({ queryKey: ['initiative-details'] });
    queryClient.invalidateQueries({ queryKey: ['entities'] });
    queryClient.invalidateQueries({ queryKey: ['mission-control-graph'] });
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
    onSuccess: invalidateAll,
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
    onSuccess: invalidateAll,
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
    onSuccess: invalidateAll,
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
    onSuccess: invalidateAll,
  });

  return { createEntity, updateEntity, deleteEntity, entityAction, bulkEntityMutation };
}
