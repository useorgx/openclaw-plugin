import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutoContinueStatusResponse } from '@/types';
import { queryKeys } from '@/lib/queryKeys';

interface UseAutoContinueOptions {
  initiativeId: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

type AutoContinueStartInput = {
  tokenBudgetTokens?: number;
  agentId?: string;
};

function buildHeaders(input: { authToken: string | null; embedMode: boolean }): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (input.embedMode) headers['X-Orgx-Embed'] = 'true';
  if (input.authToken) headers.Authorization = `Bearer ${input.authToken}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function useAutoContinue({
  initiativeId,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseAutoContinueOptions) {
  const queryClient = useQueryClient();

  const statusQueryKey = useMemo(
    () => queryKeys.autoContinueStatus({ initiativeId, authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const statusQuery = useQuery<AutoContinueStatusResponse, Error>({
    queryKey: statusQueryKey,
    enabled: enabled && Boolean(initiativeId),
    queryFn: async () => {
      if (!initiativeId) {
        throw new Error('initiativeId is required');
      }

      const params = new URLSearchParams({ initiative_id: initiativeId });
      const response = await fetch(
        `/orgx/api/mission-control/auto-continue/status?${params.toString()}`,
        { headers: buildHeaders({ authToken, embedMode }) }
      );

      const body = (await response.json().catch(() => null)) as
        | AutoContinueStatusResponse
        | { error?: string; message?: string }
        | null;

      if (!response.ok) {
        const message =
          (typeof (body as any)?.error === 'string' && (body as any).error) ||
          (typeof (body as any)?.message === 'string' && (body as any).message) ||
          `Failed to load auto-continue status (${response.status})`;
        return {
          ok: false,
          initiativeId,
          run: null,
          defaults: { tokenBudget: 0, tickMs: 0 },
          error: message,
        };
      }

      return body as AutoContinueStatusResponse;
    },
    refetchInterval: 2_500,
  });

  const invalidateRelated = async () => {
    await queryClient.invalidateQueries({ queryKey: statusQueryKey });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.liveData({ authToken, embedMode }),
    });
  };

  const startMutation = useMutation<AutoContinueStatusResponse, Error, AutoContinueStartInput | void>({
    mutationFn: async (input) => {
      if (!initiativeId) {
        throw new Error('initiativeId is required');
      }

      const payload: Record<string, unknown> = {
        initiativeId,
      };
      if (input && typeof input === 'object') {
        if (typeof input.tokenBudgetTokens === 'number') {
          payload.tokenBudgetTokens = input.tokenBudgetTokens;
        }
        if (typeof input.agentId === 'string' && input.agentId.trim().length > 0) {
          payload.agentId = input.agentId.trim();
        }
      }

      const response = await fetch('/orgx/api/mission-control/auto-continue/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(buildHeaders({ authToken, embedMode }) ?? {}),
        },
        body: JSON.stringify(payload),
      });

      const body = (await response.json().catch(() => null)) as
        | AutoContinueStatusResponse
        | { ok?: boolean; run?: unknown; error?: string; message?: string }
        | null;

      if (!response.ok) {
        const message =
          (typeof (body as any)?.error === 'string' && (body as any).error) ||
          (typeof (body as any)?.message === 'string' && (body as any).message) ||
          `Failed to start auto-continue (${response.status})`;
        throw new Error(message);
      }

      // Handler returns { ok, run }. Normalize to AutoContinueStatusResponse shape.
      if (body && typeof body === 'object' && 'run' in body) {
        const status = statusQuery.data ?? null;
        return {
          ok: true,
          initiativeId,
          run: (body as any).run ?? null,
          defaults: status?.defaults ?? { tokenBudget: 0, tickMs: 0 },
        };
      }

      return body as AutoContinueStatusResponse;
    },
    onSuccess: () => {
      void invalidateRelated();
    },
  });

  const stopMutation = useMutation<AutoContinueStatusResponse, Error, void>({
    mutationFn: async () => {
      if (!initiativeId) {
        throw new Error('initiativeId is required');
      }

      const response = await fetch('/orgx/api/mission-control/auto-continue/stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(buildHeaders({ authToken, embedMode }) ?? {}),
        },
        body: JSON.stringify({ initiativeId }),
      });

      const body = (await response.json().catch(() => null)) as
        | AutoContinueStatusResponse
        | { ok?: boolean; run?: unknown; error?: string; message?: string }
        | null;

      if (!response.ok) {
        const message =
          (typeof (body as any)?.error === 'string' && (body as any).error) ||
          (typeof (body as any)?.message === 'string' && (body as any).message) ||
          `Failed to stop auto-continue (${response.status})`;
        throw new Error(message);
      }

      if (body && typeof body === 'object' && 'run' in body) {
        const status = statusQuery.data ?? null;
        return {
          ok: true,
          initiativeId,
          run: (body as any).run ?? null,
          defaults: status?.defaults ?? { tokenBudget: 0, tickMs: 0 },
        };
      }

      return body as AutoContinueStatusResponse;
    },
    onSuccess: () => {
      void invalidateRelated();
    },
  });

  const run = statusQuery.data?.run ?? null;
  const isRunning = run?.status === 'running' || run?.status === 'stopping';

  return {
    status: statusQuery.data ?? null,
    run,
    isRunning,
    isLoading: statusQuery.isLoading,
    error: statusQuery.data?.error ?? statusQuery.error?.message ?? null,
    start: startMutation.mutateAsync,
    stop: stopMutation.mutateAsync,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    refetch: statusQuery.refetch,
  };
}

