import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MissionControlGraphResponse } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { canQueryInitiativeEntities } from '@/lib/initiativeIds';

interface UseMissionControlGraphOptions {
  initiativeId: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

function fallbackGraph(initiativeId: string): MissionControlGraphResponse {
  return {
    initiative: {
      id: initiativeId,
      title: 'Initiative',
      status: 'active',
      summary: null,
      assignedAgents: [],
    },
    nodes: [],
    edges: [],
    recentTodos: [],
  };
}

export function useMissionControlGraph({
  initiativeId,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseMissionControlGraphOptions) {
  const canQuery = canQueryInitiativeEntities(initiativeId);
  const queryKey = useMemo(
    () => queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const queryResult = useQuery<MissionControlGraphResponse, Error>({
    queryKey,
    enabled: enabled && Boolean(initiativeId) && canQuery,
    queryFn: async () => {
      if (!initiativeId) {
        throw new Error('initiativeId is required');
      }
      if (!canQuery) {
        return fallbackGraph(initiativeId);
      }

      const params = new URLSearchParams({ initiative_id: initiativeId });
      const headers: Record<string, string> = {};
      if (embedMode) headers['X-Orgx-Embed'] = 'true';
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const requestHeaders = Object.keys(headers).length > 0 ? headers : undefined;

      const response = await fetch(`/orgx/api/mission-control/graph?${params.toString()}`, {
        headers: requestHeaders,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        const message =
          (typeof body?.error === 'string' && body.error) ||
          (typeof body?.message === 'string' && body.message) ||
          `Failed to fetch Mission Control graph (${response.status})`;
        // Return a degraded fallback instead of throwing, so the UI can still render
        console.warn(`[useMissionControlGraph] ${message}`);
        const fb = fallbackGraph(initiativeId);
        return { ...fb, degraded: [message] } as MissionControlGraphResponse;
      }
      return (await response.json()) as MissionControlGraphResponse;
    },
  });

  const graph =
    queryResult.data ??
    (initiativeId ? fallbackGraph(initiativeId) : null);

  return {
    graph,
    isLoading: canQuery ? queryResult.isLoading : false,
    error: canQuery ? queryResult.error?.message ?? null : null,
    degraded: canQuery ? queryResult.data?.degraded ?? [] : [],
    refetch: queryResult.refetch,
  };
}
