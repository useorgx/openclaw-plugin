import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NextUpQueueItem, NextUpQueueResponse } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { isSyntheticInitiativeId } from '@/lib/initiativeIds';
import { parseUpgradeRequiredError } from '@/lib/upgradeGate';

interface UseNextUpQueueOptions {
  initiativeId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

interface NextUpActionInput {
  initiativeId: string;
  workstreamId: string;
  agentId?: string | null;
}

interface StartAutoContinueInput extends NextUpActionInput {
  tokenBudgetTokens?: number;
  scope?: 'initiative' | 'workstream';
  maxParallelSlices?: number;
  parallelMode?: 'iwmt';
}

interface NextUpPlayResponse {
  ok: boolean;
  initiativeId?: string;
  workstreamId?: string;
  agentId?: string;
  dispatchMode?: 'slice' | 'fallback' | 'none' | 'pending' | string;
  sessionId?: string | null;
  run?: unknown;
  error?: string;
  message?: string;
  code?: string;
}

async function readResponseJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function isUnknownApiEndpointError(response: Response, body: any | null): boolean {
  if (response.status !== 404) return false;
  const error = typeof body?.error === 'string' ? body.error : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  return /unknown api endpoint/i.test(`${error} ${message}`);
}

function normalizeErrorMessage(
  response: Response,
  body: any | null,
  fallback: string
): string {
  if (isUnknownApiEndpointError(response, body)) {
    return `${fallback}. This queue route is unavailable in the running plugin build.`;
  }
  return (
    (typeof body?.error === 'string' && body.error.trim()) ||
    (typeof body?.message === 'string' && body.message.trim()) ||
    `${fallback} (${response.status})`
  );
}

function shouldIncludeSyntheticEntities(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') return true;
  } catch {
    // ignore
  }
  try {
    return window.localStorage.getItem('orgx.show_synthetic_entities') === '1';
  } catch {
    return false;
  }
}

function resolveAutoRuntimeState(item: NextUpQueueItem): NextUpQueueItem['autoRuntimeState'] {
  const status = item.autoContinue?.status ?? 'stopped';
  if (status === 'running') return 'running';
  if (status === 'stopping') return 'stopping';
  if (item.autoContinue?.stopReason === 'error') return 'error';
  return 'idle';
}

function hasExplicitAutoIntent(item: NextUpQueueItem): boolean {
  if (!item.autoContinue) return false;
  const status = item.autoContinue.status;
  if (status !== 'running' && status !== 'stopping') return false;
  const hasLegacyPointer = Boolean(item.autoContinue.activeRunId || item.autoContinue.activeTaskId);
  const hasLanePointer = Boolean(
    Array.isArray(item.autoContinue.activeRunIds) && item.autoContinue.activeRunIds.length > 0
  );
  return hasLegacyPointer || hasLanePointer;
}

function decorateQueueItem(item: NextUpQueueItem): NextUpQueueItem {
  return {
    ...item,
    playbackState: item.queueState,
    autoIntentEnabled: hasExplicitAutoIntent(item),
    autoRuntimeState: resolveAutoRuntimeState(item),
    queueOrigin: item.queueOrigin ?? 'system',
  };
}

function normalizeQueueResponse(response: NextUpQueueResponse): NextUpQueueResponse {
  const items = response.items.map((item) => decorateQueueItem(item));
  return {
    ...response,
    items,
    total: items.length,
  };
}

export function useNextUpQueue({
  initiativeId = null,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseNextUpQueueOptions) {
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => queryKeys.nextUpQueue({ initiativeId, authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.autoContinueStatus({ initiativeId, authToken, embedMode }),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.liveData({ authToken, embedMode }),
    });
  };

  const query = useQuery<NextUpQueueResponse, Error>({
    queryKey,
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (initiativeId) params.set('initiative_id', initiativeId);
      const response = await fetch(`/orgx/api/mission-control/next-up?${params.toString()}`, {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = await readResponseJson<NextUpQueueResponse | { error?: string; message?: string }>(
        response
      );
      if (!response.ok) {
        const message = normalizeErrorMessage(
          response,
          body as { error?: string; message?: string } | null,
          'Failed to load next up queue'
        );
        throw new Error(message);
      }

      const normalized = (body ?? null) as NextUpQueueResponse | null;
      if (!normalized || normalized.ok !== true) {
        return {
          ok: true,
          generatedAt: new Date().toISOString(),
          total: 0,
          items: [],
          degraded: ['next-up queue response missing expected payload'],
        } satisfies NextUpQueueResponse;
      }
      if (shouldIncludeSyntheticEntities()) {
        return normalizeQueueResponse(normalized);
      }
      const visibleItems = normalized.items.filter(
        (item) => !isSyntheticInitiativeId(item.initiativeId)
      );
      return normalizeQueueResponse({
        ...normalized,
        items: visibleItems,
      });
    },
    refetchInterval: (state) => {
      const payload = state.state.data;
      if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return 10_000;
      const hasRunning = payload.items.some((item) => item.queueState === 'running');
      return hasRunning ? 2_500 : 8_000;
    },
  });

  const playMutation = useMutation({
    mutationFn: async (input: NextUpActionInput) => {
      const response = await fetch('/orgx/api/mission-control/next-up/play', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({
          initiativeId: input.initiativeId,
          workstreamId: input.workstreamId,
          agentId: input.agentId ?? undefined,
          fastAck: true,
          // Explicit user play action should bypass soft spawn-guard rate limits.
          ignoreSpawnGuardRateLimit: true,
        }),
      });

      const body = await readResponseJson<NextUpPlayResponse>(response);
      if (!response.ok) {
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to dispatch queued workstream')
        );
      }
      return body;
    },
    onMutate: async (input: NextUpActionInput) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<NextUpQueueResponse>(queryKey);
      if (!previous) return { previous };

      queryClient.setQueryData<NextUpQueueResponse>(queryKey, {
        ...previous,
        items: previous.items.map((item) => {
          if (item.initiativeId === input.initiativeId && item.workstreamId === input.workstreamId) {
            return { ...item, queueState: 'running', playbackState: 'running' };
          }
          // Only one workstream can be "running" in the queue UI.
          if (item.queueState === 'running') return { ...item, queueState: 'idle', playbackState: 'idle' };
          return item;
        }),
      });

      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const startAutoContinueMutation = useMutation({
    mutationFn: async (input: StartAutoContinueInput) => {
      const payload: Record<string, unknown> = {
        initiativeId: input.initiativeId,
        agentId: input.agentId ?? undefined,
        tokenBudgetTokens: input.tokenBudgetTokens,
        // Explicit user auto-enable should bypass soft spawn-guard rate limits.
        ignoreSpawnGuardRateLimit: true,
      };
      if (input.scope === 'workstream' && input.workstreamId) {
        payload.workstreamIds = [input.workstreamId];
      }
      if (typeof input.maxParallelSlices === 'number' && Number.isFinite(input.maxParallelSlices)) {
        payload.maxParallelSlices = input.maxParallelSlices;
      }
      if (input.parallelMode === 'iwmt') {
        payload.parallelMode = input.parallelMode;
      }

      const response = await fetch('/orgx/api/mission-control/auto-continue/start', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });

      const body = await readResponseJson<unknown>(response);
      if (!response.ok) {
        const upgradeError = parseUpgradeRequiredError(body);
        if (upgradeError) throw upgradeError;
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to start auto-continue')
        );
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const stopAutoContinueMutation = useMutation({
    mutationFn: async (input: { initiativeId: string }) => {
      const response = await fetch('/orgx/api/mission-control/auto-continue/stop', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({ initiativeId: input.initiativeId }),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to stop auto-continue')
        );
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    degraded: query.data?.degraded ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error?.message ?? null,
    refetch: query.refetch,
    playWorkstream: playMutation.mutateAsync,
    startWorkstreamAutoContinue: startAutoContinueMutation.mutateAsync,
    stopInitiativeAutoContinue: stopAutoContinueMutation.mutateAsync,
    isPlaying: playMutation.isPending,
    isStartingAutoContinue: startAutoContinueMutation.isPending,
    isStoppingAutoContinue: stopAutoContinueMutation.isPending,
  };
}

export type { NextUpQueueItem };
