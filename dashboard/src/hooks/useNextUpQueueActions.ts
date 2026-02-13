import { useMutation, useQueryClient } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';

async function readResponseJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function normalizeErrorMessage(response: Response, body: any | null, fallback: string): string {
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

  return {
    pin: pin.mutateAsync,
    unpin: unpin.mutateAsync,
    reorder: reorder.mutateAsync,
    isPinning: pin.isPending,
    isUnpinning: unpin.isPending,
    isReordering: reorder.isPending,
  };
}

