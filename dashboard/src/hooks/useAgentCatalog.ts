import { useQuery } from '@tanstack/react-query';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

export type AgentContext = {
  agentId: string;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  updatedAt: string;
};

export type AgentRunRecord = {
  runId: string;
  agentId: string;
  pid: number | null;
  message: string | null;
  provider: string | null;
  model: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  status: 'running' | 'stopped';
};

export type OpenClawCatalogAgent = {
  id: string;
  name: string;
  workspace: string | null;
  model: string | null;
  isDefault: boolean;
  status: string | null;
  currentTask: string | null;
  runId: string | null;
  startedAt: string | null;
  blockers: string[];
  context: AgentContext | null;
  run?: AgentRunRecord | null;
};

export type AgentCatalogResponse = {
  generatedAt: string;
  agents: OpenClawCatalogAgent[];
};

function buildDemoCatalogResponse(): AgentCatalogResponse {
  const nowIso = new Date().toISOString();
  return {
    generatedAt: nowIso,
    agents: [
      {
        id: 'eli',
        name: 'Eli',
        workspace: 'Q4 Feature Ship',
        model: 'gpt-5',
        isDefault: true,
        status: 'running',
        currentTask: 'Planning',
        runId: 'run-1',
        startedAt: nowIso,
        blockers: [],
        context: null,
      },
      {
        id: 'dana',
        name: 'Dana',
        workspace: 'Q4 Feature Ship',
        model: 'claude-sonnet-4.5',
        isDefault: false,
        status: 'running',
        currentTask: 'Dashboard UI pass',
        runId: 'run-2',
        startedAt: nowIso,
        blockers: ['Approval pending'],
        context: null,
      },
      {
        id: 'mark',
        name: 'Mark',
        workspace: 'Black Friday Email',
        model: 'gpt-5-mini',
        isDefault: false,
        status: 'running',
        currentTask: 'Campaign variants',
        runId: 'run-4',
        startedAt: nowIso,
        blockers: [],
        context: null,
      },
    ],
  };
}

export function useAgentCatalog(
  {
    enabled = true,
    staleTime = 5_000,
    refetchInterval,
  }: {
    enabled?: boolean;
    staleTime?: number;
    refetchInterval?: number | false;
  } = {}
) {
  return useQuery<AgentCatalogResponse>({
    queryKey: ['openclaw-agent-catalog'],
    queryFn: async () => {
      if (isDemoModeEnabled()) {
        return buildDemoCatalogResponse();
      }
      const res = await fetch('/orgx/api/agents/catalog');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Agent catalog failed (${res.status})`);
      }
      return (await res.json()) as AgentCatalogResponse;
    },
    enabled,
    staleTime,
    refetchInterval: refetchInterval ?? (enabled ? 8_000 : false),
  });
}
