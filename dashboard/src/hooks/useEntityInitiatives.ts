import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';
import { buildOrgxHeaders } from '@/lib/http';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { appendWorkspaceScopeParams } from '@/lib/workspaceScope';
import {
  isVisibleInitiativeStatus,
  toInitiative,
  type RawEntityInitiative,
} from '@/hooks/initiativeEntityMapper';

type EntityListResponse = {
  data?: RawEntityInitiative[];
  pagination?: {
    has_more?: boolean;
  };
};

const PAGE_SIZE = 150;
const MAX_PAGES = 12;

function toEpoch(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDemoEntityInitiatives(): Initiative[] {
  const now = new Date();
  const day = 86_400_000;
  return [
    {
      id: 'init-1',
      name: 'Content Engine: Dogfood the Larry Playbook',
      status: 'active',
      rawStatus: 'active',
      priority: 'critical',
      health: 56,
      daysRemaining: 9,
      targetDate: new Date(now.getTime() + 9 * day).toISOString(),
      createdAt: new Date(now.getTime() - 24 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
      activeAgents: 3,
      totalAgents: 4,
      description:
        'Drafting long-form content, clearing legal review, and preparing distribution schedule.',
    },
    {
      id: 'init-2',
      name: "Live View UX Redesign — The Conductor's Display",
      status: 'active',
      rawStatus: 'active',
      priority: 'high',
      health: 44,
      daysRemaining: 6,
      targetDate: new Date(now.getTime() + 6 * day).toISOString(),
      createdAt: new Date(now.getTime() - 17 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
      activeAgents: 3,
      totalAgents: 4,
      description:
        'Improving activity readability, developer-mode gating, and collapse-state spacing quality.',
    },
    {
      id: 'init-3',
      name: 'Directory Submissions & External References',
      status: 'active',
      rawStatus: 'active',
      priority: 'medium',
      health: 49,
      daysRemaining: 12,
      targetDate: new Date(now.getTime() + 12 * day).toISOString(),
      createdAt: new Date(now.getTime() - 19 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 1 * 60_000).toISOString(),
      activeAgents: 4,
      totalAgents: 5,
      description:
        'Parallel directory import, reference QA, and partner outreach with active artifact production.',
    },
    {
      id: 'init-4',
      name: 'Revenue Expansion Q2',
      status: 'completed',
      rawStatus: 'completed',
      priority: 'low',
      health: 100,
      daysRemaining: 0,
      targetDate: new Date(now.getTime() - 1 * day).toISOString(),
      createdAt: new Date(now.getTime() - 45 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 42 * 60_000).toISOString(),
      activeAgents: 0,
      totalAgents: 2,
      description:
        'Completed closeout package with reconciled variance sheet and executive sign-off trail.',
    },
    {
      id: 'init-5',
      name: 'Incident Replay & Reliability',
      status: 'blocked',
      rawStatus: 'blocked',
      priority: 'critical',
      health: 24,
      daysRemaining: 3,
      targetDate: new Date(now.getTime() + 3 * day).toISOString(),
      createdAt: new Date(now.getTime() - 13 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 25 * 60_000).toISOString(),
      activeAgents: 1,
      totalAgents: 2,
      description:
        'Replay pipeline is blocked on archive restore approval and backup snapshot decision.',
    },
  ];
}

export function useEntityInitiatives(enabled: boolean, projectId: string | null = null) {
  return useQuery<Initiative[]>({
    queryKey: queryKeys.entities({ type: 'initiative', projectId }),
    queryFn: async () => {
      if (isDemoModeEnabled()) return buildDemoEntityInitiatives();
      const rows: RawEntityInitiative[] = [];
      const workspaceScopeId = projectId?.trim() ?? '';
      let offset = 0;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({
          type: 'initiative',
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (workspaceScopeId) {
          appendWorkspaceScopeParams(params, workspaceScopeId);
        }

        const response = await fetch(`/orgx/api/entities?${params.toString()}`, {
          headers: buildOrgxHeaders({ workspaceId: workspaceScopeId }),
        });
        if (!response.ok) break;
        const json = (await response.json()) as EntityListResponse;
        const pageRows = json.data ?? [];
        rows.push(...pageRows);

        const hasMore = Boolean(json.pagination?.has_more);
        if (!hasMore || pageRows.length === 0) break;
        offset += PAGE_SIZE;
      }

      const hasWorkspaceDimension =
        workspaceScopeId.length > 0 &&
        rows.some((item) => {
          const commandCenterId = (item.command_center_id ?? item.commandCenterId ?? '').trim();
          return commandCenterId.length > 0;
        });

      const deduped = new Map<string, RawEntityInitiative>();
      for (const row of rows) {
        const current = deduped.get(row.id);
        if (!current) {
          deduped.set(row.id, row);
          continue;
        }
        if (toEpoch(row.updated_at ?? row.created_at) > toEpoch(current.updated_at ?? current.created_at)) {
          deduped.set(row.id, row);
        }
      }

      return Array.from(deduped.values())
        .filter((item) => {
          if (!workspaceScopeId || !hasWorkspaceDimension) return true;
          const commandCenterId = (item.command_center_id ?? item.commandCenterId ?? '').trim();
          return commandCenterId === workspaceScopeId;
        })
        .filter((item) => isVisibleInitiativeStatus(item.status))
        .sort((a, b) => {
          const aEpoch = Date.parse(a.updated_at ?? a.created_at ?? '') || 0;
          const bEpoch = Date.parse(b.updated_at ?? b.created_at ?? '') || 0;
          return bEpoch - aEpoch;
        })
        .map(toInitiative);
    },
    enabled,
    staleTime: 60_000,
  });
}
