import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';

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

export function useEntityInitiatives(enabled: boolean) {
  return useQuery<Initiative[]>({
    queryKey: queryKeys.entities({ type: 'initiative' }),
    queryFn: async () => {
      const res = await fetch('/orgx/api/entities?type=initiative&limit=300');
      if (!res.ok) return [];
      const json = await res.json() as { data?: RawEntityInitiative[] };
      return (json.data ?? [])
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
