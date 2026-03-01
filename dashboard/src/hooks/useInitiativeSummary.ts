import { useQuery } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';

export interface InitiativeSummaryItem {
  id: string;
  taskCounts: {
    total: number;
    done: number;
    blocked: number;
    active: number;
    todo: number;
  };
  progressPct: number;
}

export interface InitiativeSummaryAggregate {
  totalTasks: number;
  doneTasks: number;
  blockedCount: number;
  activeAgents: number;
  completionPercent: number;
}

interface InitiativeSummaryResponse {
  initiatives: InitiativeSummaryItem[];
  aggregate: InitiativeSummaryAggregate;
}

export function useInitiativeSummary({
  enabled = true,
  projectId = null,
}: {
  enabled?: boolean;
  projectId?: string | null;
} = {}) {
  return useQuery<InitiativeSummaryResponse>({
    queryKey: ['live-initiatives-summary', { projectId: projectId ?? null }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (projectId && projectId.trim().length > 0) {
        params.set('workspace_id', projectId);
      }
      const url = `/orgx/api/live/initiatives/summary${params.toString() ? `?${params}` : ''}`;
      const response = await fetch(url, {
        headers: buildOrgxHeaders({ workspaceId: projectId }),
      });
      if (!response.ok) {
        throw new Error(`Failed to load initiative summary (${response.status})`);
      }
      return (await response.json()) as InitiativeSummaryResponse;
    },
    enabled,
    refetchInterval: 60_000,
  });
}
