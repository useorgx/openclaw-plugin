import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentRuntimeSettings,
  AgentRuntimeSettingsAgent,
  AgentRuntimeSettingsData,
  AgentSuitePlan,
} from '@/types';
import { buildOrgxHeaders } from '@/lib/http';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { humanizeWarning } from '@/lib/humanize';

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
  question_auto_answer_enabled?: boolean;
  question_auto_answer_timeout_sec?: number;
  question_auto_answer_policy?: 'contextual' | 'approve_non_blocking' | 'defer_non_blocking';
  question_blocking_behavior?: 'require_human' | 'guarded_auto_resolve_then_human';
  question_policy_version?: number;
  question_auto_answer_delay_seconds?: number;
  question_auto_answer_action?: 'approve' | 'reject';
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
      workspace_id?: string | null;
      command_center_id?: string | null;
      project_id?: string | null;
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

const DEFAULT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  decisionV2Enabled: true,
  decisionDedupeEnabled: true,
  decisionEvidenceRequiredForBlocking: false,
  decisionAutoResolveGuardedEnabled: true,
  questionAutoAnswerEnabled: true,
  questionAutoAnswerTimeoutSec: 60,
  questionAutoAnswerPolicy: 'contextual',
  questionBlockingBehavior: 'require_human',
  questionPolicyVersion: 1,
  questionAutoAnswerDelaySeconds: 60,
  questionAutoAnswerAction: 'approve',
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
    questionAutoAnswerEnabled:
      typeof value?.question_auto_answer_enabled === 'boolean'
        ? value.question_auto_answer_enabled
        : DEFAULT_RUNTIME_SETTINGS.questionAutoAnswerEnabled,
    questionAutoAnswerTimeoutSec:
      typeof value?.question_auto_answer_timeout_sec === 'number' &&
      Number.isFinite(value.question_auto_answer_timeout_sec)
        ? Math.max(10, Math.min(3600, Math.floor(value.question_auto_answer_timeout_sec)))
        : typeof value?.question_auto_answer_delay_seconds === 'number' &&
            Number.isFinite(value.question_auto_answer_delay_seconds)
          ? Math.max(10, Math.min(3600, Math.floor(value.question_auto_answer_delay_seconds)))
          : DEFAULT_RUNTIME_SETTINGS.questionAutoAnswerTimeoutSec,
    questionAutoAnswerPolicy:
      value?.question_auto_answer_policy === 'approve_non_blocking' ||
      value?.question_auto_answer_policy === 'defer_non_blocking' ||
      value?.question_auto_answer_policy === 'contextual'
        ? value.question_auto_answer_policy
        : DEFAULT_RUNTIME_SETTINGS.questionAutoAnswerPolicy,
    questionBlockingBehavior:
      value?.question_blocking_behavior === 'guarded_auto_resolve_then_human' ||
      value?.question_blocking_behavior === 'require_human'
        ? value.question_blocking_behavior
        : DEFAULT_RUNTIME_SETTINGS.questionBlockingBehavior,
    questionPolicyVersion:
      typeof value?.question_policy_version === 'number' &&
      Number.isFinite(value.question_policy_version)
        ? Math.max(1, Math.min(10, Math.floor(value.question_policy_version)))
        : DEFAULT_RUNTIME_SETTINGS.questionPolicyVersion,
    questionAutoAnswerDelaySeconds:
      typeof value?.question_auto_answer_timeout_sec === 'number' &&
      Number.isFinite(value.question_auto_answer_timeout_sec)
        ? Math.max(1, Math.min(900, Math.floor(value.question_auto_answer_timeout_sec)))
        : typeof value?.question_auto_answer_delay_seconds === 'number' &&
            Number.isFinite(value.question_auto_answer_delay_seconds)
          ? Math.max(1, Math.min(900, Math.floor(value.question_auto_answer_delay_seconds)))
          : DEFAULT_RUNTIME_SETTINGS.questionAutoAnswerDelaySeconds,
    questionAutoAnswerAction:
      value?.question_auto_answer_action === 'reject'
        ? 'reject'
        : DEFAULT_RUNTIME_SETTINGS.questionAutoAnswerAction,
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
    projectId: normalizeUuid(
      typeof envelope.workspace_id === 'string'
        ? envelope.workspace_id
        : typeof envelope.command_center_id === 'string'
          ? envelope.command_center_id
          : typeof envelope.project_id === 'string'
            ? envelope.project_id
            : null
    ),
    agents: agents.map(normalizeRuntimeSettingsAgent),
  };
}

export function useAgentSuite({
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseAgentSuiteOptions = {}) {
  const queryClient = useQueryClient();
  const demoMode = isDemoModeEnabled();

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
      if (demoMode) {
        return {
          ok: false,
          error: 'Agent suite controls are unavailable in demo mode.',
        };
      }
      const response = await fetch('/orgx/api/agent-suite/status', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as AgentSuiteStatusResponse | { error?: string } | null;
      if (!response.ok) {
        const raw = (body as any)?.error ?? `Failed to load agent suite (${response.status})`;
        return { ok: false, error: humanizeWarning(String(raw)) };
      }
      return body as AgentSuiteStatusResponse;
    },
    staleTime: 10_000,
  });
  const runtimeSettingsQuery = useQuery<AgentRuntimeSettingsData, Error>({
    queryKey: runtimeSettingsQueryKey,
    enabled,
    queryFn: async () => {
      if (demoMode) {
        return { projectId: null, agents: [] };
      }
      const response = await fetch('/orgx/api/agent-suite/runtime-settings', {
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      const body = (await response.json().catch(() => null)) as
        | AgentSuiteRuntimeSettingsRouteResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        const raw = (body as any)?.error;
        const normalizedRaw = typeof raw === 'string' ? raw.trim() : '';
        const rawLooksHtml =
          normalizedRaw.includes('<!DOCTYPE') || normalizedRaw.includes('<html');
        const message =
          response.status === 404
            ? 'Agent runtime settings endpoint is not available in this plugin build.'
            : normalizedRaw.length > 0 && !rawLooksHtml
              ? normalizedRaw
              : `Failed to load agent runtime settings (${response.status})`;
        throw new Error(humanizeWarning(message));
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
      if (demoMode) {
        return {
          ok: false,
          error: 'Agent suite install is unavailable in demo mode.',
        };
      }
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
        const raw = (body as any)?.error ?? `Failed to install agent suite (${response.status})`;
        throw new Error(humanizeWarning(String(raw)));
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
      if (demoMode) {
        return { projectId: null, agents: [] };
      }
      const projectId = normalizeUuid(input.projectId ?? null);
      const response = await fetch('/orgx/api/agent-suite/runtime-settings', {
        method: 'PATCH',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({
          ...(projectId
            ? { workspace_id: projectId }
            : {}),
          agent_id: input.agentId,
          runtime_settings: {
            decision_v2_enabled: input.runtimeSettings.decisionV2Enabled,
            decision_dedupe_enabled: input.runtimeSettings.decisionDedupeEnabled,
            decision_evidence_required_for_blocking:
              input.runtimeSettings.decisionEvidenceRequiredForBlocking,
            decision_auto_resolve_guarded_enabled:
              input.runtimeSettings.decisionAutoResolveGuardedEnabled,
            question_auto_answer_enabled:
              input.runtimeSettings.questionAutoAnswerEnabled,
            question_auto_answer_timeout_sec:
              input.runtimeSettings.questionAutoAnswerTimeoutSec,
            question_auto_answer_policy:
              input.runtimeSettings.questionAutoAnswerPolicy,
            question_blocking_behavior:
              input.runtimeSettings.questionBlockingBehavior,
            question_policy_version:
              input.runtimeSettings.questionPolicyVersion,
            question_auto_answer_delay_seconds:
              input.runtimeSettings.questionAutoAnswerDelaySeconds,
            question_auto_answer_action:
              input.runtimeSettings.questionAutoAnswerAction,
            custom_run_instructions: input.runtimeSettings.customRunInstructions,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | AgentSuiteRuntimeSettingsRouteResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        const raw =
          (body as any)?.error ??
          `Failed to save agent runtime settings (${response.status})`;
        throw new Error(humanizeWarning(String(raw)));
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
