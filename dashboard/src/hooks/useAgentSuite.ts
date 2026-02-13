import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AgentSuitePlan } from '@/types';
import { buildOrgxHeaders } from '@/lib/http';

export type AgentSuiteStatusResponse =
  | { ok: true; data: AgentSuitePlan }
  | { ok: false; error: string };

export type AgentSuiteInstallResponse =
  | {
      ok: true;
      operationId: string;
      dryRun: boolean;
      applied: boolean;
      data: AgentSuitePlan;
    }
  | { ok: false; error: string };

interface UseAgentSuiteOptions {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

export function useAgentSuite({
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseAgentSuiteOptions = {}) {
  const queryClient = useQueryClient();

  const statusQueryKey = useMemo(
    () => ['agent-suite', { authToken, embedMode }] as const,
    [authToken, embedMode]
  );

  const statusQuery = useQuery<AgentSuiteStatusResponse, Error>({
    queryKey: statusQueryKey,
    enabled,
    queryFn: async () => {
      const response = await fetch('/orgx/api/agent-suite/status', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as AgentSuiteStatusResponse | { error?: string } | null;
      if (!response.ok) {
        return { ok: false, error: (body as any)?.error ?? `Failed to load agent suite (${response.status})` };
      }
      return body as AgentSuiteStatusResponse;
    },
    staleTime: 10_000,
  });

  const installMutation = useMutation<
    AgentSuiteInstallResponse,
    Error,
    { dryRun?: boolean; forceSkillPack?: boolean }
  >({
    mutationFn: async ({ dryRun, forceSkillPack } = {}) => {
      const response = await fetch('/orgx/api/agent-suite/install', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({
          dryRun: Boolean(dryRun),
          forceSkillPack: Boolean(forceSkillPack),
        }),
      });
      const body = (await response.json().catch(() => null)) as AgentSuiteInstallResponse | { error?: string } | null;
      if (!response.ok) {
        throw new Error((body as any)?.error ?? `Failed to install agent suite (${response.status})`);
      }
      return body as AgentSuiteInstallResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statusQueryKey });
    },
  });

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isLoading,
    error:
      (statusQuery.data && 'error' in statusQuery.data ? statusQuery.data.error : null) ??
      statusQuery.error?.message ??
      null,
    refetchStatus: statusQuery.refetch,
    install: installMutation.mutateAsync,
    installResult: installMutation.data ?? null,
    isInstalling: installMutation.isPending,
  };
}
