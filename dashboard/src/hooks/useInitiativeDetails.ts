import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  InitiativeDetails,
  InitiativeMilestone,
  InitiativeTask,
  InitiativeWorkstream,
} from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { canQueryInitiativeEntities, isDemoModeEnabled } from '@/lib/initiativeIds';

type WorkstreamApiItem = {
  id: string;
  name?: string;
  summary?: string | null;
  status?: string;
  progress?: number | null;
  sequence?: number | null;
  order?: number | null;
  initiative_id?: string;
  created_at?: string | null;
};

type MilestoneApiItem = {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  due_date?: string | null;
  sequence?: number | null;
  order?: number | null;
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
  sequence?: number | null;
  order?: number | null;
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

function normalizeSequenceIndex(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.max(0, Math.trunc(value));
  // OrgX persists sequence as 1-based; dashboard sequenceIndex is 0-based.
  if (integer > 0) return integer - 1;
  return integer;
}

function sequenceHierarchyLabel(prefix: 'W' | 'M' | 'T', sequenceIndex: number | undefined): string | undefined {
  if (typeof sequenceIndex !== 'number') return undefined;
  return `${prefix}${sequenceIndex + 1}`;
}

const mapWorkstream = (
  item: WorkstreamApiItem,
  fallbackInitiativeId: string
): InitiativeWorkstream => {
  const sequenceIndex = normalizeSequenceIndex(item.sequence ?? item.order);
  return {
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
    sequenceIndex,
    hierarchyLabel: sequenceHierarchyLabel('W', sequenceIndex),
  };
};

const mapMilestone = (
  item: MilestoneApiItem,
  fallbackInitiativeId: string
): InitiativeMilestone => {
  const sequenceIndex = normalizeSequenceIndex(item.sequence ?? item.order);
  return {
    id: item.id,
    title: item.title ?? 'Untitled milestone',
    description: item.description ?? null,
    status: item.status ?? 'planned',
    dueDate: item.due_date ?? null,
    initiativeId: item.initiative_id ?? fallbackInitiativeId,
    workstreamId: item.workstream_id ?? null,
    createdAt: item.created_at ?? null,
    sequenceIndex,
    hierarchyLabel: sequenceHierarchyLabel('M', sequenceIndex),
  };
};

const mapTask = (item: TaskApiItem, fallbackInitiativeId: string): InitiativeTask => {
  const sequenceIndex = normalizeSequenceIndex(item.sequence ?? item.order);
  return {
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
    sequenceIndex,
    hierarchyLabel: sequenceHierarchyLabel('T', sequenceIndex),
  };
};

function sortBySequence<T extends { sequenceIndex?: number; createdAt?: string | null }>(
  rows: T[]
): T[] {
  return [...rows].sort((left, right) => {
    const leftSeq =
      typeof left.sequenceIndex === 'number'
        ? left.sequenceIndex
        : Number.POSITIVE_INFINITY;
    const rightSeq =
      typeof right.sequenceIndex === 'number'
        ? right.sequenceIndex
        : Number.POSITIVE_INFINITY;
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    const leftEpoch = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightEpoch = right.createdAt ? Date.parse(right.createdAt) : 0;
    if (leftEpoch !== rightEpoch) return leftEpoch - rightEpoch;
    return 0;
  });
}

function buildDemoInitiativeDetails(initiativeId: string): InitiativeDetails {
  const nowIso = new Date().toISOString();
  if (initiativeId === 'init-1') {
    return {
      initiativeId,
      workstreams: [
        {
          id: 'ws-4',
          name: 'Dashboard UI pass',
          summary: 'Polish interaction details and close accessibility feedback.',
          status: 'active',
          progress: 70,
          initiativeId,
          createdAt: nowIso,
        },
        {
          id: 'ws-5',
          name: 'Usage tracking instrumentation',
          summary: 'Waiting on events table access.',
          status: 'blocked',
          progress: 25,
          initiativeId,
          createdAt: nowIso,
        },
      ],
      milestones: [
        {
          id: 'ms-1',
          title: 'UX polish complete',
          description: 'All blocking review comments resolved.',
          status: 'active',
          dueDate: null,
          initiativeId,
          workstreamId: 'ws-4',
          createdAt: nowIso,
        },
      ],
      tasks: [
        {
          id: 'task-1',
          title: 'Polish timeline controls',
          description: null,
          status: 'in_progress',
          priority: 'high',
          dueDate: null,
          initiativeId,
          milestoneId: 'ms-1',
          workstreamId: 'ws-4',
          createdAt: nowIso,
        },
        {
          id: 'task-2',
          title: 'Validate mobile overlays',
          description: null,
          status: 'todo',
          priority: 'medium',
          dueDate: null,
          initiativeId,
          milestoneId: 'ms-1',
          workstreamId: 'ws-4',
          createdAt: nowIso,
        },
        {
          id: 'task-3',
          title: 'Grant data pipeline access',
          description: null,
          status: 'blocked',
          priority: 'high',
          dueDate: null,
          initiativeId,
          milestoneId: null,
          workstreamId: 'ws-5',
          createdAt: nowIso,
        },
      ],
    };
  }

  return {
    initiativeId,
    workstreams: [
      {
        id: 'ws-9',
        name: 'Email campaign generation',
        summary: 'Final review of subject line variants.',
        status: 'active',
        progress: 55,
        initiativeId,
        createdAt: nowIso,
      },
    ],
    milestones: [],
    tasks: [
      {
        id: 'task-9',
        title: 'Prepare launch variants',
        description: null,
        status: 'in_progress',
        priority: 'medium',
        dueDate: null,
        initiativeId,
        milestoneId: null,
        workstreamId: 'ws-9',
        createdAt: nowIso,
      },
    ],
  };
}

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
      if (isDemoModeEnabled()) {
        return buildDemoInitiativeDetails(initiativeId);
      }
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
        ? sortBySequence(
            workstreamsResponse.data.map((item) => mapWorkstream(item, initiativeId))
          )
        : [];
      const milestones = Array.isArray(milestonesResponse.data)
        ? sortBySequence(
            milestonesResponse.data.map((item) => mapMilestone(item, initiativeId))
          )
        : [];
      const tasks = Array.isArray(tasksResponse.data)
        ? sortBySequence(
            tasksResponse.data.map((item) => mapTask(item, initiativeId))
          )
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
