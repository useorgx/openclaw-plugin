import type { Initiative } from '@/types';

export interface RawEntityInitiative {
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
  const status = raw.toLowerCase();
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'blocked' || status === 'at_risk') return 'blocked';
  if (status === 'paused' || status === 'hold') return 'paused';
  return 'active';
}

function daysUntil(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const target = new Date(dateStr);
  const now = new Date();
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
}

export function isVisibleInitiativeStatus(rawStatus: string | null | undefined): boolean {
  const normalized = (rawStatus ?? '').toLowerCase();
  return !['deleted', 'archived', 'cancelled'].includes(normalized);
}

export function toInitiative(raw: RawEntityInitiative): Initiative {
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
