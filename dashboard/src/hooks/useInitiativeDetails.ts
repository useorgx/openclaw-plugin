import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  InitiativeDetails,
  InitiativeMilestone,
  InitiativeTask,
  InitiativeWorkstream,
} from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { canQueryInitiativeEntities } from '@/lib/initiativeIds';

type WorkstreamApiItem = {
  id: string;
  name?: string;
  summary?: string | null;
  status?: string;
  progress?: number | null;
  initiative_id?: string;
  created_at?: string | null;
};

type MilestoneApiItem = {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  due_date?: string | null;
  initiative_id?: string;
  workstream_id?: string | null;
  created_at?: string | null;
};

type TaskApiItem = {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string | null;
  due_date?: string | null;
  initiative_id?: string;
  milestone_id?: string | null;
  workstream_id?: string | null;
  created_at?: string | null;
};

type EntitiesResponse<T> = {
  data?: T[];
};

const EMPTY_DETAILS: InitiativeDetails = {
  initiativeId: '',
  workstreams: [],
  milestones: [],
  tasks: [],
};

interface UseInitiativeDetailsOptions {
  initiativeId: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

const mapWorkstream = (
  item: WorkstreamApiItem,
  fallbackInitiativeId: string
): InitiativeWorkstream => ({
  id: item.id,
  name: item.name ?? 'Untitled workstream',
  summary: item.summary ?? null,
  status: item.status ?? 'planned',
  progress:
    typeof item.progress === 'number' && !Number.isNaN(item.progress)
      ? Math.max(0, Math.min(100, item.progress <= 1 ? item.progress * 100 : item.progress))
      : null,
  initiativeId: item.initiative_id ?? fallbackInitiativeId,
  createdAt: item.created_at ?? null,
});

const mapMilestone = (
  item: MilestoneApiItem,
  fallbackInitiativeId: string
): InitiativeMilestone => ({
  id: item.id,
  title: item.title ?? 'Untitled milestone',
  description: item.description ?? null,
  status: item.status ?? 'planned',
  dueDate: item.due_date ?? null,
  initiativeId: item.initiative_id ?? fallbackInitiativeId,
  workstreamId: item.workstream_id ?? null,
  createdAt: item.created_at ?? null,
});

const mapTask = (item: TaskApiItem, fallbackInitiativeId: string): InitiativeTask => ({
  id: item.id,
  title: item.title ?? 'Untitled task',
  description: item.description ?? null,
  status: item.status ?? 'todo',
  priority: item.priority ?? null,
  dueDate: item.due_date ?? null,
  initiativeId: item.initiative_id ?? fallbackInitiativeId,
  milestoneId: item.milestone_id ?? null,
  workstreamId: item.workstream_id ?? null,
  createdAt: item.created_at ?? null,
});

export function useInitiativeDetails({
  initiativeId,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseInitiativeDetailsOptions) {
  const canQuery = canQueryInitiativeEntities(initiativeId);
  const queryKey = useMemo(
    () => queryKeys.initiativeDetails({ initiativeId, authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const queryResult = useQuery<InitiativeDetails, Error>({
    queryKey,
    enabled: enabled && Boolean(initiativeId) && canQuery,
    queryFn: async () => {
      if (!initiativeId) return EMPTY_DETAILS;
      if (!canQuery) {
        return { ...EMPTY_DETAILS, initiativeId };
      }

      const headers: Record<string, string> = {};
      if (embedMode) headers['X-Orgx-Embed'] = 'true';
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const requestHeaders = Object.keys(headers).length ? headers : undefined;

      const fetchEntities = async <T,>(type: 'workstream' | 'milestone' | 'task'): Promise<EntitiesResponse<T>> => {
        try {
          const params = new URLSearchParams({
            type,
            initiative_id: initiativeId,
            limit: '100',
          });
          const response = await fetch(`/orgx/api/entities?${params.toString()}`, {
            headers: requestHeaders,
          });
          if (!response.ok) {
            console.warn(`[useInitiativeDetails] ${type} fetch returned ${response.status}, using empty list`);
            return { data: [] };
          }
          return (await response.json()) as EntitiesResponse<T>;
        } catch (err) {
          console.warn(`[useInitiativeDetails] ${type} fetch failed:`, err);
          return { data: [] };
        }
      };

      const [workstreamsResponse, milestonesResponse, tasksResponse] = await Promise.all([
        fetchEntities<WorkstreamApiItem>('workstream'),
        fetchEntities<MilestoneApiItem>('milestone'),
        fetchEntities<TaskApiItem>('task'),
      ]);

      const workstreams = Array.isArray(workstreamsResponse.data)
        ? workstreamsResponse.data.map((item) => mapWorkstream(item, initiativeId))
        : [];
      const milestones = Array.isArray(milestonesResponse.data)
        ? milestonesResponse.data.map((item) => mapMilestone(item, initiativeId))
        : [];
      const tasks = Array.isArray(tasksResponse.data)
        ? tasksResponse.data.map((item) => mapTask(item, initiativeId))
        : [];

      return {
        initiativeId,
        workstreams,
        milestones,
        tasks,
      };
    },
  });

  return {
    details:
      (canQuery ? queryResult.data : null) ??
      (initiativeId
        ? { ...EMPTY_DETAILS, initiativeId }
        : EMPTY_DETAILS),
    isLoading: canQuery ? queryResult.isLoading : false,
    error: canQuery ? queryResult.error?.message ?? null : null,
    refetch: queryResult.refetch,
  };
}
