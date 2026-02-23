import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

interface RawLiveInitiative {
  id: string;
  title: string;
  status?: string | null;
  priority?: string | null;
  progress?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  targetDate?: string | null;
  dueDate?: string | null;
  etaEndAt?: string | null;
  command_center_id?: string | null;
  commandCenterId?: string | null;
}

type LiveInitiativesResponse = {
  initiatives?: RawLiveInitiative[];
  total?: number;
  pagination?: {
    has_more?: boolean;
  };
};

const PAGE_SIZE = 50;
const MAX_PAGES = 8;

function mapStatus(raw: string | null | undefined): Initiative['status'] {
  const status = (raw ?? '').toLowerCase();
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'blocked' || status === 'at_risk') return 'blocked';
  if (status === 'paused' || status === 'hold') return 'paused';
  return 'active';
}

function isVisibleStatus(raw: string | null | undefined): boolean {
  const status = (raw ?? '').toLowerCase();
  return !['deleted', 'archived', 'cancelled'].includes(status);
}

function toInitiative(item: RawLiveInitiative): Initiative {
  return {
    id: item.id,
    name: item.title,
    status: mapStatus(item.status),
    rawStatus: item.status ?? null,
    priority: item.priority ?? null,
    category: undefined,
    health: Math.max(0, Math.min(100, Math.round(item.progress ?? 0))),
    daysRemaining: 0,
    targetDate: item.targetDate ?? item.dueDate ?? item.etaEndAt ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
    activeAgents: 0,
    totalAgents: 0,
    description: undefined,
  };
}

export function useLiveInitiatives(enabled: boolean, projectId: string | null = null) {
  return useQuery<Initiative[]>({
    queryKey: queryKeys.liveInitiatives({ limit: PAGE_SIZE * MAX_PAGES, projectId }),
    queryFn: async () => {
      if (isDemoModeEnabled()) return [];
      const rows: RawLiveInitiative[] = [];
      let offset = 0;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (projectId && projectId.trim().length > 0) {
          params.set('project_id', projectId.trim());
        }
        const response = await fetch(`/orgx/api/live/initiatives?${params.toString()}`);
        if (!response.ok) break;
        const json = (await response.json()) as LiveInitiativesResponse;
        const pageRows = json.initiatives ?? [];
        rows.push(...pageRows);

        const total = typeof json.total === 'number' ? json.total : null;
        const hasMoreFromPagination = json.pagination?.has_more;
        const hasMore =
          typeof hasMoreFromPagination === 'boolean'
            ? hasMoreFromPagination
            : total !== null
              ? offset + pageRows.length < total
              : pageRows.length === PAGE_SIZE;

        if (!hasMore || pageRows.length === 0) break;
        offset += PAGE_SIZE;
      }

      const workspaceScopeId = projectId?.trim() ?? '';
      const hasWorkspaceDimension =
        workspaceScopeId.length > 0 &&
        rows.some((initiative) => {
          const commandCenterId = (initiative.command_center_id ?? initiative.commandCenterId ?? '').trim();
          return commandCenterId.length > 0;
        });
      return rows
        .filter((initiative) => {
          if (!workspaceScopeId || !hasWorkspaceDimension) return true;
          const commandCenterId = (initiative.command_center_id ?? initiative.commandCenterId ?? '').trim();
          return commandCenterId === workspaceScopeId;
        })
        .filter((initiative) => isVisibleStatus(initiative.status))
        .map(toInitiative);
    },
    enabled,
    staleTime: 30_000,
  });
}
