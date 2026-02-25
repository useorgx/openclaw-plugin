import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { humanizeWarning } from '@/lib/humanize';

const LIVE_DATA_INVALIDATE_DEBOUNCE_MS = 750;

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
  if (response.status === 401 || response.status === 403) {
    return `${fallback}. Reconnect OrgX authentication in Settings.`;
  }
  if (response.status >= 500) {
    return `${fallback}. OrgX is temporarily unavailable. Try again in a moment.`;
  }
  const detail =
    (typeof body?.error === 'string' && body.error.trim()) ||
    (typeof body?.message === 'string' && body.message.trim()) ||
    `${fallback}.`;
  return humanizeWarning(detail);
}

export interface UseNextUpQueueActionsResult {
  pin: (payload: {
    initiativeId: string;
    workstreamId: string;
    taskId?: string | null;
    milestoneId?: string | null;
  }) => Promise<unknown>;
  unpin: (payload: { initiativeId: string; workstreamId: string }) => Promise<unknown>;
  reorder: (payload: { order: Array<{ initiativeId: string; workstreamId: string }> }) => Promise<unknown>;
  move: (payload: {
    initiativeId: string;
    workstreamId: string;
    placement?: 'top' | 'bottom';
  }) => Promise<unknown>;
  remove: (payload: { initiativeId: string; workstreamId: string }) => Promise<unknown>;
  stopTriage: (payload: {
    initiativeId: string;
    workstreamId: string;
    placement?: 'top' | 'bottom';
    resetToTodo?: boolean;
  }) => Promise<unknown>;
  clear: (payload: {
    initiativeId?: string | null;
    workstreamId?: string | null;
    states?: Array<'running' | 'blocked'>;
    placement?: 'top' | 'bottom';
  }) => Promise<unknown>;
  bulk: (payload: {
    action: 'move_top' | 'move_bottom' | 'remove';
    items: Array<{ initiativeId: string; workstreamId: string }>;
  }) => Promise<unknown>;
  isPinning: boolean;
  isUnpinning: boolean;
  isReordering: boolean;
  isMoving: boolean;
  isRemoving: boolean;
  isStoppingTriage: boolean;
  isClearing: boolean;
  isBulking: boolean;
}

export function useNextUpQueueActions(input: { authToken?: string | null; embedMode?: boolean }) {
  const authToken = input.authToken ?? null;
  const embedMode = input.embedMode ?? false;
  const demoMode = isDemoModeEnabled();
  const queryClient = useQueryClient();
  const liveDataInvalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (liveDataInvalidateTimerRef.current) {
        clearTimeout(liveDataInvalidateTimerRef.current);
        liveDataInvalidateTimerRef.current = null;
      }
    };
  }, []);

  const scheduleLiveDataInvalidate = () => {
    if (liveDataInvalidateTimerRef.current) {
      clearTimeout(liveDataInvalidateTimerRef.current);
      liveDataInvalidateTimerRef.current = null;
    }
    liveDataInvalidateTimerRef.current = setTimeout(() => {
      liveDataInvalidateTimerRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ['live-data'] });
    }, LIVE_DATA_INVALIDATE_DEBOUNCE_MS);
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['mission-control-next-up'] }),
      queryClient.invalidateQueries({ queryKey: ['mission-control-graph'] }),
      queryClient.invalidateQueries({ queryKey: ['mission-control-slices'] }),
    ]);
    scheduleLiveDataInvalidate();
  };

  const moveQueueItem = async (payload: {
    initiativeId: string;
    workstreamId: string;
    placement?: 'top' | 'bottom';
  }) => {
    if (demoMode) {
      return {
        ok: true,
        demo: true,
        initiativeId: payload.initiativeId,
        workstreamId: payload.workstreamId,
        placement: payload.placement ?? 'top',
      } as const;
    }

    const response = await fetch('/orgx/api/mission-control/next-up/move', {
      method: 'POST',
      headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
      body: JSON.stringify(payload),
    });
    const body = await readResponseJson<{ error?: string; message?: string }>(response);
    if (response.ok) return body;

    if (!isUnknownApiEndpointError(response, body)) {
      throw new Error(normalizeErrorMessage(response, body, 'Failed to move Next Up item'));
    }

    // Fallback for older runtimes: emulate move via fetch + reorder.
    const queueResponse = await fetch('/orgx/api/mission-control/next-up', {
      headers: buildOrgxHeaders({ authToken, embedMode }),
    });
    const queueBody = await readResponseJson<{ items?: Array<{ initiativeId?: string; workstreamId?: string }>; error?: string; message?: string }>(queueResponse);
    if (!queueResponse.ok) {
      throw new Error(
        normalizeErrorMessage(queueResponse, queueBody, 'Failed to read queue for move fallback')
      );
    }
    const queueItems = Array.isArray(queueBody?.items) ? queueBody.items : [];
    const currentOrder = queueItems
      .map((item) => {
        const initiativeId =
          typeof item?.initiativeId === 'string' ? item.initiativeId : null;
        const workstreamId =
          typeof item?.workstreamId === 'string' ? item.workstreamId : null;
        if (!initiativeId || !workstreamId) return null;
        return { initiativeId, workstreamId };
      })
      .filter((item): item is { initiativeId: string; workstreamId: string } => Boolean(item));

    if (currentOrder.length === 0) {
      throw new Error('Queue placement controls require a newer plugin runtime. Refresh to latest main and retry.');
    }

    const targetIndex = currentOrder.findIndex(
      (item) =>
        item.initiativeId === payload.initiativeId && item.workstreamId === payload.workstreamId
    );
    if (targetIndex === -1) return { ok: true, fallback: 'reorder-move-skip' };

    const [target] = currentOrder.splice(targetIndex, 1);
    if ((payload.placement ?? 'top') === 'bottom') currentOrder.push(target);
    else currentOrder.unshift(target);

    const reorderResponse = await fetch('/orgx/api/mission-control/next-up/reorder', {
      method: 'POST',
      headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
      body: JSON.stringify({ order: currentOrder }),
    });
    const reorderBody = await readResponseJson<{ error?: string; message?: string }>(reorderResponse);
    if (!reorderResponse.ok) {
      throw new Error(
        normalizeErrorMessage(
          reorderResponse,
          reorderBody,
          'Failed to move Next Up item with reorder fallback'
        )
      );
    }
    return reorderBody ?? { ok: true, fallback: 'reorder-move' };
  };

  const removeQueueItem = async (payload: { initiativeId: string; workstreamId: string }) => {
    if (demoMode) {
      return {
        ok: true,
        demo: true,
        initiativeId: payload.initiativeId,
        workstreamId: payload.workstreamId,
      } as const;
    }

    const response = await fetch('/orgx/api/mission-control/next-up/remove', {
      method: 'POST',
      headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
      body: JSON.stringify(payload),
    });
    const body = await readResponseJson<{ error?: string; message?: string }>(response);
    if (response.ok) return body;

    if (isUnknownApiEndpointError(response, body)) {
      const legacyResponse = await fetch('/orgx/api/mission-control/next-up/unpin', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const legacyBody = await readResponseJson<{ error?: string; message?: string }>(legacyResponse);
      if (!legacyResponse.ok) {
        throw new Error(
          normalizeErrorMessage(
            legacyResponse,
            legacyBody,
            'Failed to remove item from queue with legacy fallback'
          )
        );
      }
      return legacyBody ?? { ok: true, fallback: 'next-up-unpin' };
    }

    throw new Error(normalizeErrorMessage(response, body, 'Failed to remove item from queue'));
  };

  const pin = useMutation({
    mutationFn: async (payload: {
      initiativeId: string;
      workstreamId: string;
      taskId?: string | null;
      milestoneId?: string | null;
    }) => {
      if (demoMode) return { ok: true, demo: true } as const;

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
      if (demoMode) return { ok: true, demo: true } as const;

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
      if (demoMode) {
        return {
          ok: true,
          demo: true,
          updated: payload.order.length,
        } as const;
      }

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
    mutationFn: moveQueueItem,
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
      if (demoMode) {
        return {
          ok: true,
          demo: true,
          initiativeId: payload.initiativeId,
          workstreamId: payload.workstreamId,
        } as const;
      }

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
    mutationFn: removeQueueItem,
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
      if (demoMode) {
        return {
          ok: true,
          demo: true,
          cleared: true,
        } as const;
      }

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

  const bulk = useMutation({
    mutationFn: async (payload: {
      action: 'move_top' | 'move_bottom' | 'remove';
      items: Array<{ initiativeId: string; workstreamId: string }>;
    }) => {
      if (demoMode) {
        return {
          ok: true,
          demo: true,
          updated: payload.items.length,
          failed: 0,
          errors: [],
          fallback: 'demo',
        } as const;
      }

      const response = await fetch('/orgx/api/mission-control/next-up/bulk', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        if (!isUnknownApiEndpointError(response, body)) {
          throw new Error(normalizeErrorMessage(response, body, 'Failed to apply bulk queue action'));
        }
        const settled = await Promise.all(
          payload.items.map(async (item) => {
            try {
              if (payload.action === 'remove') {
                await removeQueueItem(item);
              } else {
                await moveQueueItem({
                  initiativeId: item.initiativeId,
                  workstreamId: item.workstreamId,
                  placement: payload.action === 'move_top' ? 'top' : 'bottom',
                });
              }
              return { ok: true as const, error: null };
            } catch (err) {
              return {
                ok: false as const,
                error: err instanceof Error ? err.message : 'Queue action failed',
              };
            }
          })
        );
        const updated = settled.filter((entry) => entry.ok).length;
        const failed = settled.length - updated;
        const errors = settled
          .filter((entry) => !entry.ok && entry.error)
          .map((entry) => entry.error as string);
        return {
          ok: failed === 0,
          updated,
          failed,
          errors,
          fallback: 'sequential',
        } as const;
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
    bulk: bulk.mutateAsync,
    isPinning: pin.isPending,
    isUnpinning: unpin.isPending,
    isReordering: reorder.isPending,
    isMoving: move.isPending,
    isRemoving: remove.isPending,
    isStoppingTriage: stopTriage.isPending,
    isClearing: clear.isPending,
    isBulking: bulk.isPending,
  };
}
