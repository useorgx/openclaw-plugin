import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import type {
  LiveTriageItem,
  TriageActionRequest,
  TriageActionResponse,
  TriageListResponse,
} from '@/types';

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

interface UseTriageQueueOptions {
  enabled?: boolean;
  workspaceId?: string | null;
  status?: string;
  authToken?: string | null;
  embedMode?: boolean;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function buildOrgxHeaders(authToken?: string | null, embedMode?: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (embedMode) headers['X-OrgX-Embed'] = '1';
  return headers;
}

async function fetchTriageQueue(
  workspaceId: string | null,
  status: string,
  authToken?: string | null,
  embedMode?: boolean
): Promise<TriageListResponse> {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspace_id', workspaceId);
  if (status) params.set('status', status);
  params.set('limit', '100');

  const url = `/orgx/api/live/triage?${params.toString()}`;
  const res = await fetch(url, {
    headers: buildOrgxHeaders(authToken, embedMode),
  });

  if (!res.ok) {
    throw new Error(`Triage fetch failed: ${res.status}`);
  }

  return res.json();
}

async function postTriageAction(
  itemId: string,
  payload: TriageActionRequest,
  authToken?: string | null,
  embedMode?: boolean
): Promise<TriageActionResponse> {
  const params = new URLSearchParams({ id: itemId });
  const url = `/orgx/api/live/triage/action?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildOrgxHeaders(authToken, embedMode),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Action failed: ${res.status}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface TriageQueueModel {
  items: LiveTriageItem[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  degraded: string[];
  refetch: () => void;
}

export interface TriageQueueActions {
  performAction: (
    itemId: string,
    action: string,
    opts?: { note?: string; optionId?: string; snoozeDurationMinutes?: number }
  ) => Promise<TriageActionResponse>;
  isActing: boolean;
  lastActionError: string | null;
}

export function useTriageQueue(options: UseTriageQueueOptions = {}): {
  model: TriageQueueModel;
  actions: TriageQueueActions;
} {
  const {
    enabled = true,
    workspaceId = null,
    status = 'open',
    authToken = null,
    embedMode = false,
  } = options;

  const queryClient = useQueryClient();

  const queryKey = queryKeys.triageQueue({
    workspaceId,
    status,
    authToken,
    embedMode,
  });

  const query = useQuery({
    queryKey,
    queryFn: () => fetchTriageQueue(workspaceId, status, authToken, embedMode),
    enabled,
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const actionMutation = useMutation({
    mutationFn: async ({
      itemId,
      payload,
    }: {
      itemId: string;
      payload: TriageActionRequest;
    }) => postTriageAction(itemId, payload, authToken, embedMode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const performAction = useCallback(
    async (
      itemId: string,
      action: string,
      opts?: { note?: string; optionId?: string; snoozeDurationMinutes?: number }
    ) => {
      return actionMutation.mutateAsync({
        itemId,
        payload: {
          action,
          note: opts?.note,
          optionId: opts?.optionId,
          snoozeDurationMinutes: opts?.snoozeDurationMinutes,
        },
      });
    },
    [actionMutation]
  );

  const model: TriageQueueModel = useMemo(
    () => ({
      items: query.data?.items ?? [],
      total: query.data?.total ?? 0,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error as Error | null,
      degraded: query.data?.degraded ?? [],
      refetch: query.refetch,
    }),
    [query]
  );

  const actions: TriageQueueActions = useMemo(
    () => ({
      performAction,
      isActing: actionMutation.isPending,
      lastActionError: actionMutation.error
        ? (actionMutation.error as Error).message
        : null,
    }),
    [performAction, actionMutation.isPending, actionMutation.error]
  );

  return { model, actions };
}
