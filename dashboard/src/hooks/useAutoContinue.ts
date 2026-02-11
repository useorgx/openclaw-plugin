import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutoContinueStatusResponse } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';

interface UseAutoContinueOptions {
  initiativeId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

type AutoContinueStartInput = {
  tokenBudgetTokens?: number;
  agentId?: string;
};

export function useAutoContinue({
  initiativeId = null,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseAutoContinueOptions) {
  const queryClient = useQueryClient();

  const statusQueryKey = useMemo(
    () => queryKeys.autoContinueStatus({ initiativeId: initiativeId ?? '__global__', authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const statusQuery = useQuery<AutoContinueStatusResponse, Error>({
    queryKey: statusQueryKey,
    enabled: enabled && (Boolean(initiativeId) || initiativeId === null),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (initiativeId) {
        params.set('initiative_id', initiativeId);
      }
      const response = await fetch(
        `/orgx/api/mission-control/auto-continue/status?${params.toString()}`,
        { headers: buildOrgxHeaders({ authToken, embedMode }) }
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
    // Poll frequently only while a run is active; otherwise back off to keep the UI snappy.
    refetchInterval: (query) => {
      const data = query.state.data as AutoContinueStatusResponse | undefined;
      const maybeUnavailable = data?.error?.toLowerCase().includes('404') ?? false;
      if (maybeUnavailable) return false;
      const status = data?.run?.status ?? null;
      if (status === 'running' || status === 'stopping') return 2_500;
      return 12_000;
    },
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
      const payload: Record<string, unknown> = {};
      if (initiativeId) {
        payload.initiativeId = initiativeId;
      }
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
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
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
      const payload: Record<string, unknown> = {};
      if (initiativeId) {
        payload.initiativeId = initiativeId;
      }

      const response = await fetch('/orgx/api/mission-control/auto-continue/stop', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
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
