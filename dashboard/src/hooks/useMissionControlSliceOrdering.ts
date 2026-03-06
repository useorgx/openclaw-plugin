import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  MissionControlSliceOrderMode,
  MissionControlSlicesResponse,
} from '@/types';
import { buildOrgxHeaders } from '@/lib/http';
import { invalidateMissionControlQueries } from '@/lib/missionControlInvalidation';

interface UseMissionControlSliceOrderingOptions {
  workspaceId?: string | null;
  initiativeId?: string | null;
  level: 'initiative' | 'workstream' | 'milestone' | 'task';
  authToken?: string | null;
  embedMode?: boolean;
}

function appendWorkspaceScope(payload: Record<string, unknown>, workspaceId: string | null | undefined): void {
  if (!workspaceId || workspaceId.trim().length === 0) return;
  const normalized = workspaceId.trim();
  payload.workspace_id = normalized;
}

async function readResponseOrThrow(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      (body && typeof body.error === 'string' && body.error) ||
      (body && typeof body.message === 'string' && body.message) ||
      `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body ?? {};
}

export function useMissionControlSliceOrdering({
  workspaceId = null,
  initiativeId = null,
  level,
  authToken = null,
  embedMode = false,
}: UseMissionControlSliceOrderingOptions) {
  const queryClient = useQueryClient();

  const reorder = useMutation({
    mutationFn: async (order: string[]) => {
      const payload: Record<string, unknown> = {
        level,
        order: order.map((sliceId) => ({ sliceId })),
      };
      appendWorkspaceScope(payload, workspaceId);
      if (initiativeId) payload.initiative_id = initiativeId;

      const response = await fetch('/orgx/api/mission-control/slices/reorder', {
        method: 'POST',
        headers: buildOrgxHeaders({
          authToken,
          embedMode,
          contentTypeJson: true,
          workspaceId,
        }),
        body: JSON.stringify(payload),
      });
      return readResponseOrThrow(response);
    },
    onMutate: async (order) => {
      const snapshots = queryClient.getQueriesData<MissionControlSlicesResponse>({
        queryKey: ['mission-control-slices'],
      });
      for (const [key, value] of snapshots) {
        if (!value || value.level !== level) continue;
        if (initiativeId && value.initiativeId && value.initiativeId !== initiativeId) continue;
        const byId = new Map(value.items.map((item) => [item.sliceId, item]));
        const reordered = order
          .map((sliceId) => byId.get(sliceId) ?? null)
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (reordered.length === 0) continue;
        const used = new Set(reordered.map((item) => item.sliceId));
        for (const item of value.items) {
          if (used.has(item.sliceId)) continue;
          reordered.push(item);
        }
        queryClient.setQueryData<MissionControlSlicesResponse>(key, {
          ...value,
          items: reordered.map((item, index) => ({
            ...item,
            manualRank: index + 1,
            finalRank: index + 1,
          })),
          orderMode: 'manual',
        });
      }
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, value] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, value);
      }
    },
    onSettled: () => {
      void invalidateMissionControlQueries(queryClient, {
        initiativeId,
        projectId: workspaceId,
        authToken,
        embedMode,
        includeQueue: false,
        includeGraph: false,
        includeAutoContinue: false,
      });
    },
  });

  const setOrderMode = useMutation({
    mutationFn: async (orderMode: MissionControlSliceOrderMode) => {
      const payload: Record<string, unknown> = {
        level,
        order_mode: orderMode,
      };
      appendWorkspaceScope(payload, workspaceId);
      if (initiativeId) payload.initiative_id = initiativeId;

      const response = await fetch('/orgx/api/mission-control/slices/order-mode', {
        method: 'POST',
        headers: buildOrgxHeaders({
          authToken,
          embedMode,
          contentTypeJson: true,
          workspaceId,
        }),
        body: JSON.stringify(payload),
      });
      return readResponseOrThrow(response);
    },
    onMutate: async (orderMode) => {
      const snapshots = queryClient.getQueriesData<MissionControlSlicesResponse>({
        queryKey: ['mission-control-slices'],
      });
      for (const [key, value] of snapshots) {
        if (!value || value.level !== level) continue;
        if (initiativeId && value.initiativeId && value.initiativeId !== initiativeId) continue;
        queryClient.setQueryData<MissionControlSlicesResponse>(key, {
          ...value,
          orderMode,
        });
      }
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, value] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, value);
      }
    },
    onSettled: () => {
      void invalidateMissionControlQueries(queryClient, {
        initiativeId,
        projectId: workspaceId,
        authToken,
        embedMode,
        includeQueue: false,
        includeGraph: false,
        includeAutoContinue: false,
      });
    },
  });

  return {
    reorder: reorder.mutateAsync,
    setOrderMode: setOrderMode.mutateAsync,
    isReordering: reorder.isPending,
    isSettingOrderMode: setOrderMode.isPending,
    error:
      (reorder.error instanceof Error ? reorder.error.message : null) ??
      (setOrderMode.error instanceof Error
        ? setOrderMode.error.message
        : null),
  };
}
