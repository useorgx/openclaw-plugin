import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';

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
}

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

export function useLiveInitiatives(enabled: boolean) {
  return useQuery<Initiative[]>({
    queryKey: queryKeys.liveInitiatives({ limit: 300 }),
    queryFn: async () => {
      const response = await fetch('/orgx/api/live/initiatives?limit=300');
      if (!response.ok) return [];
      const json = (await response.json()) as {
        initiatives?: RawLiveInitiative[];
      };
      return (json.initiatives ?? [])
        .filter((initiative) => isVisibleStatus(initiative.status))
        .map(toInitiative);
    },
    enabled,
    staleTime: 30_000,
  });
}
