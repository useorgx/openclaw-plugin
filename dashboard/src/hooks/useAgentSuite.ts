import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentRuntimeSettings,
  AgentRuntimeSettingsAgent,
  AgentRuntimeSettingsData,
  AgentSuitePlan,
} from '@/types';
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

type AgentSuiteRuntimeSettingsApiRecord = {
  decision_v2_enabled?: boolean;
  decision_dedupe_enabled?: boolean;
  decision_evidence_required_for_blocking?: boolean;
  decision_auto_resolve_guarded_enabled?: boolean;
  custom_run_instructions?: string | null;
};

type AgentSuiteRuntimeSettingsApiAgent = {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  model?: string | null;
  runtime_settings?: AgentSuiteRuntimeSettingsApiRecord;
};

type AgentSuiteRuntimeSettingsEnvelope =
  | {
      ok: true;
      project_id: string | null;
      agents?: AgentSuiteRuntimeSettingsApiAgent[];
      agent?: AgentSuiteRuntimeSettingsApiAgent;
    }
  | { ok: false; error: string };

type AgentSuiteRuntimeSettingsRouteResponse =
  | {
      ok: true;
      data: AgentSuiteRuntimeSettingsEnvelope;
    }
  | { ok: false; error: string };

export interface AgentRuntimeSettingsSaveInput {
  projectId?: string | null;
  agentId: string;
  runtimeSettings: AgentRuntimeSettings;
}

interface UseAgentSuiteOptions {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

const DEFAULT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  decisionV2Enabled: true,
  decisionDedupeEnabled: true,
  decisionEvidenceRequiredForBlocking: false,
  decisionAutoResolveGuardedEnabled: true,
  customRunInstructions: '',
};

function normalizeRuntimeSettings(
  value: AgentSuiteRuntimeSettingsApiRecord | null | undefined
): AgentRuntimeSettings {
  return {
    decisionV2Enabled:
      typeof value?.decision_v2_enabled === 'boolean'
        ? value.decision_v2_enabled
        : DEFAULT_RUNTIME_SETTINGS.decisionV2Enabled,
    decisionDedupeEnabled:
      typeof value?.decision_dedupe_enabled === 'boolean'
        ? value.decision_dedupe_enabled
        : DEFAULT_RUNTIME_SETTINGS.decisionDedupeEnabled,
    decisionEvidenceRequiredForBlocking:
      typeof value?.decision_evidence_required_for_blocking === 'boolean'
        ? value.decision_evidence_required_for_blocking
        : DEFAULT_RUNTIME_SETTINGS.decisionEvidenceRequiredForBlocking,
    decisionAutoResolveGuardedEnabled:
      typeof value?.decision_auto_resolve_guarded_enabled === 'boolean'
        ? value.decision_auto_resolve_guarded_enabled
        : DEFAULT_RUNTIME_SETTINGS.decisionAutoResolveGuardedEnabled,
    customRunInstructions:
      typeof value?.custom_run_instructions === 'string'
        ? value.custom_run_instructions
        : DEFAULT_RUNTIME_SETTINGS.customRunInstructions,
  };
}

function normalizeRuntimeSettingsAgent(
  value: AgentSuiteRuntimeSettingsApiAgent
): AgentRuntimeSettingsAgent {
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : value.id,
    type: typeof value.type === 'string' ? value.type : 'custom',
    status: typeof value.status === 'string' ? value.status : 'active',
    model: typeof value.model === 'string' ? value.model : null,
    runtimeSettings: normalizeRuntimeSettings(value.runtime_settings),
  };
}

function normalizeRuntimeSettingsResponse(
  value: AgentSuiteRuntimeSettingsRouteResponse | null
): AgentRuntimeSettingsData {
  if (!value || value.ok !== true || !value.data || value.data.ok !== true) {
    return { projectId: null, agents: [] };
  }
  const envelope = value.data;
  const agents = Array.isArray(envelope.agents)
    ? envelope.agents
    : envelope.agent
    ? [envelope.agent]
    : [];
  return {
    projectId: typeof envelope.project_id === 'string' ? envelope.project_id : null,
    agents: agents.map(normalizeRuntimeSettingsAgent),
  };
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
  const runtimeSettingsQueryKey = useMemo(
    () => ['agent-suite-runtime-settings', { authToken, embedMode }] as const,
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
  const runtimeSettingsQuery = useQuery<AgentRuntimeSettingsData, Error>({
    queryKey: runtimeSettingsQueryKey,
    enabled,
    queryFn: async () => {
      const response = await fetch('/orgx/api/agent-suite/runtime-settings', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as
        | AgentSuiteRuntimeSettingsRouteResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        const raw = (body as any)?.error;
        const message =
          typeof raw === 'string' && raw.length > 0 && !raw.startsWith('<')
            ? raw
            : response.status === 404
            ? 'Agent runtime settings endpoint is not available in this plugin build.'
            : `Failed to load agent runtime settings (${response.status})`;
        throw new Error(message);
      }
      return normalizeRuntimeSettingsResponse(
        (body as AgentSuiteRuntimeSettingsRouteResponse) ?? null
      );
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
  const saveRuntimeSettingsMutation = useMutation<
    AgentRuntimeSettingsData,
    Error,
    AgentRuntimeSettingsSaveInput
  >({
    mutationFn: async (input) => {
      const response = await fetch('/orgx/api/agent-suite/runtime-settings', {
        method: 'PATCH',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({
          ...(input.projectId ? { project_id: input.projectId } : {}),
          agent_id: input.agentId,
          runtime_settings: {
            decision_v2_enabled: input.runtimeSettings.decisionV2Enabled,
            decision_dedupe_enabled: input.runtimeSettings.decisionDedupeEnabled,
            decision_evidence_required_for_blocking:
              input.runtimeSettings.decisionEvidenceRequiredForBlocking,
            decision_auto_resolve_guarded_enabled:
              input.runtimeSettings.decisionAutoResolveGuardedEnabled,
            custom_run_instructions: input.runtimeSettings.customRunInstructions,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | AgentSuiteRuntimeSettingsRouteResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          (body as any)?.error ??
            `Failed to save agent runtime settings (${response.status})`
        );
      }
      return normalizeRuntimeSettingsResponse(
        (body as AgentSuiteRuntimeSettingsRouteResponse) ?? null
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: runtimeSettingsQueryKey });
    },
  });

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isLoading,
    isRefetching: statusQuery.isRefetching,
    error:
      (statusQuery.data && 'error' in statusQuery.data ? statusQuery.data.error : null) ??
      statusQuery.error?.message ??
      null,
    installError: installMutation.error?.message ?? null,
    runtimeSettings: runtimeSettingsQuery.data ?? { projectId: null, agents: [] },
    runtimeSettingsError: runtimeSettingsQuery.error?.message ?? null,
    isRuntimeSettingsLoading: runtimeSettingsQuery.isLoading,
    isRuntimeSettingsRefetching: runtimeSettingsQuery.isRefetching,
    refetchRuntimeSettings: runtimeSettingsQuery.refetch,
    saveRuntimeSettings: saveRuntimeSettingsMutation.mutate,
    saveRuntimeSettingsAsync: saveRuntimeSettingsMutation.mutateAsync,
    saveRuntimeSettingsError: saveRuntimeSettingsMutation.error?.message ?? null,
    isSavingRuntimeSettings: saveRuntimeSettingsMutation.isPending,
    refetchStatus: statusQuery.refetch,
    install: installMutation.mutate,
    installAsync: installMutation.mutateAsync,
    resetInstall: installMutation.reset,
    installResult: installMutation.data ?? null,
    isInstalling: installMutation.isPending,
  };
}
