import { useMutation, useQueryClient } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';

async function readResponseJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function isUnknownApiEndpointError(response: Response, body: any | null): boolean {
  if (response.status !== 404) return false;
  const error = typeof body?.error === 'string' ? body.error : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  return /unknown api endpoint/i.test(`${error} ${message}`);
}

function normalizeErrorMessage(response: Response, body: any | null, fallback: string): string {
  if (isUnknownApiEndpointError(response, body)) {
    return `${fallback}. This queue control is unavailable in the running plugin build.`;
  }
  return (
    (typeof body?.error === 'string' && body.error.trim()) ||
    (typeof body?.message === 'string' && body.message.trim()) ||
    `${fallback} (${response.status})`
  );
}

export function useNextUpQueueActions(input: { authToken?: string | null; embedMode?: boolean }) {
  const authToken = input.authToken ?? null;
  const embedMode = input.embedMode ?? false;
  const queryClient = useQueryClient();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['mission-control-next-up'] });
    await queryClient.invalidateQueries({ queryKey: ['mission-control-graph'] });
    await queryClient.invalidateQueries({ queryKey: ['live-data'] });
  };

  const pin = useMutation({
    mutationFn: async (payload: {
      initiativeId: string;
      workstreamId: string;
      taskId?: string | null;
      milestoneId?: string | null;
    }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/pin', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(normalizeErrorMessage(response, body, 'Failed to pin Next Up item'));
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const unpin = useMutation({
    mutationFn: async (payload: { initiativeId: string; workstreamId: string }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/unpin', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(normalizeErrorMessage(response, body, 'Failed to unpin Next Up item'));
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const reorder = useMutation({
    mutationFn: async (payload: { order: Array<{ initiativeId: string; workstreamId: string }> }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/reorder', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(normalizeErrorMessage(response, body, 'Failed to reorder Next Up queue'));
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const move = useMutation({
    mutationFn: async (payload: {
      initiativeId: string;
      workstreamId: string;
      placement?: 'top' | 'bottom';
    }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/move', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        if (isUnknownApiEndpointError(response, body)) {
          throw new Error(
            'Queue placement controls require a newer plugin runtime. Refresh to latest main and retry.'
          );
        }
        throw new Error(normalizeErrorMessage(response, body, 'Failed to move Next Up item'));
      }
      return body;
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const stopTriage = useMutation({
    mutationFn: async (payload: {
      initiativeId: string;
      workstreamId: string;
      placement?: 'top' | 'bottom';
      resetToTodo?: boolean;
    }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/triage/stop', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        if (isUnknownApiEndpointError(response, body)) {
          const legacyResponse = await fetch('/orgx/api/mission-control/auto-continue/stop', {
            method: 'POST',
            headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
            body: JSON.stringify({ initiativeId: payload.initiativeId }),
          });
          const legacyBody = await readResponseJson<{ error?: string; message?: string }>(
            legacyResponse
          );
          if (!legacyResponse.ok) {
            throw new Error(
              normalizeErrorMessage(
                legacyResponse,
                legacyBody,
                'Failed to pause triage with legacy fallback'
              )
            );
          }
          return { ok: true, fallback: 'auto-continue-stop' };
        }
        throw new Error(normalizeErrorMessage(response, body, 'Failed to stop triage'));
      }
      return body;
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: async (payload: { initiativeId: string; workstreamId: string }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/remove', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(normalizeErrorMessage(response, body, 'Failed to remove item from queue'));
      }
      return body;
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const clear = useMutation({
    mutationFn: async (payload: {
      initiativeId?: string | null;
      workstreamId?: string | null;
      states?: Array<'running' | 'blocked'>;
      placement?: 'top' | 'bottom';
    }) => {
      const response = await fetch('/orgx/api/mission-control/next-up/clear', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        if (isUnknownApiEndpointError(response, body) && payload.initiativeId) {
          const legacyResponse = await fetch('/orgx/api/mission-control/auto-continue/stop', {
            method: 'POST',
            headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
            body: JSON.stringify({ initiativeId: payload.initiativeId }),
          });
          const legacyBody = await readResponseJson<{ error?: string; message?: string }>(
            legacyResponse
          );
          if (!legacyResponse.ok) {
            throw new Error(
              normalizeErrorMessage(
                legacyResponse,
                legacyBody,
                'Failed to clear lifecycle state with legacy fallback'
              )
            );
          }
          return { ok: true, fallback: 'auto-continue-stop' };
        }
        throw new Error(normalizeErrorMessage(response, body, 'Failed to clear Next Up lifecycle state'));
      }
      return body;
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  return {
    pin: pin.mutateAsync,
    unpin: unpin.mutateAsync,
    reorder: reorder.mutateAsync,
    move: move.mutateAsync,
    remove: remove.mutateAsync,
    stopTriage: stopTriage.mutateAsync,
    clear: clear.mutateAsync,
    isPinning: pin.isPending,
    isUnpinning: unpin.isPending,
    isReordering: reorder.isPending,
    isMoving: move.isPending,
    isRemoving: remove.isPending,
    isStoppingTriage: stopTriage.isPending,
    isClearing: clear.isPending,
  };
}
