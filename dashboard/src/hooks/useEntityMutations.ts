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

  return { createEntity, updateEntity, deleteEntity, entityAction };
}
