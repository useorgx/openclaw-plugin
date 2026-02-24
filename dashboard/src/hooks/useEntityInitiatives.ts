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
      name: 'Q4 Feature Ship',
      status: 'active',
      rawStatus: 'active',
      priority: 'high',
      health: 38,
      daysRemaining: 16,
      targetDate: new Date(now.getTime() + 16 * day).toISOString(),
      createdAt: new Date(now.getTime() - 18 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      activeAgents: 2,
      totalAgents: 3,
      description: 'Finalize launch readiness for the Q4 initiative.',
    },
    {
      id: 'init-2',
      name: 'Black Friday Email',
      status: 'active',
      rawStatus: 'active',
      priority: 'medium',
      health: 55,
      daysRemaining: 10,
      targetDate: new Date(now.getTime() + 10 * day).toISOString(),
      createdAt: new Date(now.getTime() - 22 * day).toISOString(),
      updatedAt: new Date(now.getTime() - 15 * 60_000).toISOString(),
      activeAgents: 1,
      totalAgents: 2,
      description: 'Generate and validate campaign assets for holiday launch.',
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
          appendWorkspaceScopeParams(params, workspaceScopeId, {
            includeCenterAlias: true,
            includeProjectAlias: false,
          });
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
