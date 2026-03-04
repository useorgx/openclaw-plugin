import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UsageControlPlaneSummary } from '@/types';
import { buildOrgxHeaders } from '@/lib/http';
import { humanizeWarning } from '@/lib/humanize';

interface UseUsageControlPlaneOptions {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

export function useUsageControlPlane({
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseUsageControlPlaneOptions = {}) {
  const queryKey = useMemo(
    () => ['usage-control-plane', { authToken, embedMode }] as const,
    [authToken, embedMode]
  );

  const summaryQuery = useQuery<UsageControlPlaneSummary, Error>({
    queryKey,
    enabled,
    queryFn: async () => {
      const response = await fetch('/orgx/api/usage/control-plane/summary', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as
        | UsageControlPlaneSummary
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        const error =
          (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : null) ??
          (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : null) ??
          `Failed to load usage summary (${response.status})`;
        throw new Error(humanizeWarning(error));
      }
      if (!body || typeof body !== 'object' || !('generatedAt' in body)) {
        throw new Error(humanizeWarning('Usage summary response is missing required fields.'));
      }
      return body as UsageControlPlaneSummary;
    },
    refetchInterval: 60_000,
  });

  return {
    summary: summaryQuery.data ?? null,
    isLoading: summaryQuery.isLoading,
    isFetching: summaryQuery.isFetching,
    error: summaryQuery.error?.message ?? null,
    refetch: summaryQuery.refetch,
  };
}
