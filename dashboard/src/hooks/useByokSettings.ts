import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ByokHealthResponse, ByokSettingsResponse } from '@/types';
import { buildOrgxHeaders } from '@/lib/http';

interface UseByokSettingsOptions {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

type ByokUpdateInput = {
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
  openrouterApiKey?: string | null;
};

export function useByokSettings({
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseByokSettingsOptions = {}) {
  const queryClient = useQueryClient();

  const statusQueryKey = useMemo(
    () => ['byok-settings', { authToken, embedMode }] as const,
    [authToken, embedMode]
  );
  const healthQueryKey = useMemo(
    () => ['byok-health', { authToken, embedMode }] as const,
    [authToken, embedMode]
  );

  const statusQuery = useQuery<ByokSettingsResponse, Error>({
    queryKey: statusQueryKey,
    enabled,
    queryFn: async () => {
      const response = await fetch('/orgx/api/settings/byok', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as ByokSettingsResponse | { error?: string } | null;
      if (!response.ok) {
        return {
          ok: false,
          updatedAt: null,
          providers: {
            openai: { configured: false, source: 'none', masked: null },
            anthropic: { configured: false, source: 'none', masked: null },
            openrouter: { configured: false, source: 'none', masked: null },
          },
          error: (body as any)?.error ?? `Failed to load settings (${response.status})`,
        };
      }
      return body as ByokSettingsResponse;
    },
    staleTime: 15_000,
  });

  const healthQuery = useQuery<ByokHealthResponse, Error>({
    queryKey: healthQueryKey,
    enabled: false,
    queryFn: async () => {
      const response = await fetch('/orgx/api/settings/byok/health', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as ByokHealthResponse | { error?: string } | null;
      if (!response.ok) {
        return {
          ok: false,
          agentId: 'main',
          providers: {
            openai: { ok: false, error: (body as any)?.error ?? `Probe failed (${response.status})` },
            anthropic: { ok: false, error: (body as any)?.error ?? `Probe failed (${response.status})` },
            openrouter: { ok: false, error: (body as any)?.error ?? `Probe failed (${response.status})` },
          },
          error: (body as any)?.error ?? `Probe failed (${response.status})`,
        };
      }
      return body as ByokHealthResponse;
    },
  });

  const updateMutation = useMutation<ByokSettingsResponse, Error, ByokUpdateInput>({
    mutationFn: async (input) => {
      const response = await fetch('/orgx/api/settings/byok', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(input ?? {}),
      });
      const body = (await response.json().catch(() => null)) as ByokSettingsResponse | { error?: string } | null;
      if (!response.ok) {
        throw new Error((body as any)?.error ?? `Failed to save settings (${response.status})`);
      }
      return body as ByokSettingsResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statusQueryKey });
    },
  });

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isLoading,
    error: statusQuery.data?.error ?? statusQuery.error?.message ?? null,
    refetchStatus: statusQuery.refetch,
    update: updateMutation.mutateAsync,
    isSaving: updateMutation.isPending,
    health: healthQuery.data ?? null,
    probe: healthQuery.refetch,
    isProbing: healthQuery.isFetching,
  };
}
