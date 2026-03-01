import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MissionControlGraphResponse, MissionControlNode } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { canQueryInitiativeEntities, isDemoModeEnabled } from '@/lib/initiativeIds';

interface UseMissionControlGraphOptions {
  initiativeId: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

function normalizeSequenceIndex(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.max(0, Math.trunc(value));
  // OrgX persists sequence as 1-based; dashboard sequenceIndex is 0-based.
  if (integer > 0) return integer - 1;
  return integer;
}

function hierarchyPrefix(type: string): 'W' | 'M' | 'T' | 'I' {
  if (type === 'workstream') return 'W';
  if (type === 'milestone') return 'M';
  if (type === 'task') return 'T';
  return 'I';
}

function fallbackGraph(initiativeId: string): MissionControlGraphResponse {
  return {
    initiative: {
      id: initiativeId,
      title: 'Initiative',
      status: 'active',
      summary: null,
      assignedAgents: [],
    },
    nodes: [],
    edges: [],
    recentTodos: [],
  };
}

function buildDemoGraph(initiativeId: string): MissionControlGraphResponse {
  const nowIso = new Date().toISOString();
  const initiativeTitle = initiativeId === 'init-2' ? 'Black Friday Email' : 'Q4 Feature Ship';

  const workstreamId = `${initiativeId}:ws:design`;
  const milestoneId = `${initiativeId}:ms:polish`;
  const taskAId = `${initiativeId}:task:tokens`;
  const taskBId = `${initiativeId}:task:qa`;

  return {
    initiative: {
      id: initiativeId,
      title: initiativeTitle,
      status: 'active',
      summary: 'Demo mode graph from local fixture data.',
      assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
    },
    nodes: [
      {
        id: workstreamId,
        type: 'workstream',
        title: 'Dashboard UI pass',
        status: 'active',
        parentId: initiativeId,
        initiativeId,
        workstreamId,
        milestoneId: null,
        priorityNum: 1,
        priorityLabel: 'P1',
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 8,
        expectedBudgetUsd: 1500,
        assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
        updatedAt: nowIso,
      },
      {
        id: milestoneId,
        type: 'milestone',
        title: 'Polish pass',
        status: 'active',
        parentId: workstreamId,
        initiativeId,
        workstreamId,
        milestoneId,
        priorityNum: 1,
        priorityLabel: 'P1',
        dependencyIds: [workstreamId],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 4,
        expectedBudgetUsd: 900,
        assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
        updatedAt: nowIso,
      },
      {
        id: taskAId,
        type: 'task',
        title: 'Refine queue action ergonomics',
        status: 'todo',
        parentId: milestoneId,
        initiativeId,
        workstreamId,
        milestoneId,
        priorityNum: 1,
        priorityLabel: 'P1',
        dependencyIds: [milestoneId],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 2,
        expectedBudgetUsd: 450,
        assignedAgents: [{ id: 'dana', name: 'Dana', domain: 'design' }],
        updatedAt: nowIso,
      },
      {
        id: taskBId,
        type: 'task',
        title: 'Mobile QA sweep',
        status: 'active',
        parentId: milestoneId,
        initiativeId,
        workstreamId,
        milestoneId,
        priorityNum: 2,
        priorityLabel: 'P2',
        dependencyIds: [taskAId],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: 2,
        expectedBudgetUsd: 420,
        assignedAgents: [{ id: 'mark', name: 'Mark', domain: 'engineering' }],
        updatedAt: nowIso,
      },
    ],
    edges: [
      { from: workstreamId, to: milestoneId, kind: 'depends_on' },
      { from: milestoneId, to: taskAId, kind: 'depends_on' },
      { from: taskAId, to: taskBId, kind: 'depends_on' },
    ],
    recentTodos: [taskAId, taskBId],
  };
}

export function useMissionControlGraph({
  initiativeId,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseMissionControlGraphOptions) {
  const demoMode = isDemoModeEnabled();
  const canQuery = canQueryInitiativeEntities(initiativeId);
  const queryKey = useMemo(
    () => queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
    [initiativeId, authToken, embedMode]
  );

  const queryResult = useQuery<MissionControlGraphResponse, Error>({
    queryKey,
    enabled: enabled && Boolean(initiativeId) && canQuery,
    queryFn: async () => {
      if (!initiativeId) {
        throw new Error('initiativeId is required');
      }
      if (demoMode) {
        return buildDemoGraph(initiativeId);
      }
      if (!canQuery) {
        return fallbackGraph(initiativeId);
      }

      const params = new URLSearchParams({ initiative_id: initiativeId });
      const headers: Record<string, string> = {};
      if (embedMode) headers['X-Orgx-Embed'] = 'true';
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const requestHeaders = Object.keys(headers).length > 0 ? headers : undefined;

      const response = await fetch(`/orgx/api/mission-control/graph?${params.toString()}`, {
        headers: requestHeaders,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        const message =
          (typeof body?.error === 'string' && body.error) ||
          (typeof body?.message === 'string' && body.message) ||
          `Failed to fetch Mission Control graph (${response.status})`;
        // Return a degraded fallback instead of throwing, so the UI can still render
        console.warn(`[useMissionControlGraph] ${message}`);
        const fb = fallbackGraph(initiativeId);
        return { ...fb, degraded: [message] } as MissionControlGraphResponse;
      }
      const data = (await response.json()) as MissionControlGraphResponse;

      const normalizedNodes = Array.isArray(data.nodes)
        ? data.nodes.map((node) => {
            const nodeWithSequence = node as MissionControlNode & {
              sequence?: unknown;
            };
            const sequenceIndex = normalizeSequenceIndex(
              nodeWithSequence.sequenceIndex ?? nodeWithSequence.sequence
            );
            if (typeof sequenceIndex !== 'number') return node;
            const hasHierarchyLabel =
              typeof nodeWithSequence.hierarchyLabel === 'string' &&
              nodeWithSequence.hierarchyLabel.trim().length > 0;
            return {
              ...nodeWithSequence,
              sequenceIndex,
              hierarchyLabel: hasHierarchyLabel
                ? nodeWithSequence.hierarchyLabel
                : `${hierarchyPrefix(String(nodeWithSequence.type ?? 'initiative'))}${sequenceIndex + 1}`,
            };
          })
        : [];

      return {
        ...data,
        nodes:
          normalizedNodes.length > 0
            ? normalizedNodes
            : data.nodes,
      };
    },
  });

  const graph =
    queryResult.data ??
    (initiativeId ? fallbackGraph(initiativeId) : null);

  return {
    graph,
    isLoading: canQuery ? queryResult.isLoading : false,
    error: canQuery ? queryResult.error?.message ?? null : null,
    degraded: canQuery ? queryResult.data?.degraded ?? [] : [],
    refetch: queryResult.refetch,
  };
}
