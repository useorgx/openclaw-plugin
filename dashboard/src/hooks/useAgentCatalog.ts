import { useQuery } from '@tanstack/react-query';

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

export function useAgentCatalog({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<AgentCatalogResponse>({
    queryKey: ['openclaw-agent-catalog'],
    queryFn: async () => {
      const res = await fetch('/orgx/api/agents/catalog');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Agent catalog failed (${res.status})`);
      }
      return (await res.json()) as AgentCatalogResponse;
    },
    enabled,
    staleTime: 5_000,
    refetchInterval: enabled ? 8_000 : false,
  });
}

