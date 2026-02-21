import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

interface RawEntityInitiative {
  id: string;
  title: string;
  summary?: string | null;
  status: string;
  priority?: string | null;
  progress_pct?: number | null;
  start_date?: string | null;
  target_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  command_center_id?: string | null;
  commandCenterId?: string | null;
}

function mapStatus(raw: string): Initiative['status'] {
  const s = raw.toLowerCase();
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'blocked' || s === 'at_risk') return 'blocked';
  if (s === 'paused' || s === 'hold') return 'paused';
  return 'active';
}

function daysUntil(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const target = new Date(dateStr);
  const now = new Date();
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
}

function toInitiative(raw: RawEntityInitiative): Initiative {
  return {
    id: raw.id,
    name: raw.title,
    status: mapStatus(raw.status),
    rawStatus: raw.status ?? null,
    priority: raw.priority ?? null,
    health: raw.progress_pct ?? 0,
    daysRemaining: daysUntil(raw.target_date),
    targetDate: raw.target_date ?? null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? raw.created_at ?? null,
    activeAgents: 0,
    totalAgents: 0,
    description: raw.summary ?? undefined,
  };
}

function isVisibleStatus(rawStatus: string): boolean {
  const status = rawStatus.toLowerCase();
  return !['deleted', 'archived', 'cancelled'].includes(status);
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
      const params = new URLSearchParams({
        type: 'initiative',
        limit: '300',
      });
      if (projectId && projectId.trim().length > 0) {
        params.set('command_center_id', projectId.trim());
      }
      const res = await fetch(`/orgx/api/entities?${params.toString()}`);
      if (!res.ok) return [];
      const json = await res.json() as { data?: RawEntityInitiative[] };
      const rows = json.data ?? [];
      const workspaceScopeId = projectId?.trim() ?? '';
      const hasWorkspaceDimension =
        workspaceScopeId.length > 0 &&
        rows.some((item) => {
          const commandCenterId = (item.command_center_id ?? item.commandCenterId ?? '').trim();
          return commandCenterId.length > 0;
        });
      return rows
        .filter((item) => {
          if (!workspaceScopeId || !hasWorkspaceDimension) return true;
          const commandCenterId = (item.command_center_id ?? item.commandCenterId ?? '').trim();
          return commandCenterId === workspaceScopeId;
        })
        .filter((item) => isVisibleStatus(item.status ?? ''))
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
