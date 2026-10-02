import { colors, normalizeStatus } from '@/lib/tokens';
import type { Initiative } from '@/types';

// Classes resolve to the OrgX kit tokens (tailwind.config.js maps lime / teal /
// orgx-amber / orgx-red onto --ox-*). Tailwind JIT needs full static class strings.
// Kit semantics: amber = needs you, teal = accepted / done, red = failed and retryable.

export const initiativeStatusClass: Record<Initiative['status'], string> = {
  active: 'text-lime bg-lime/10 border-lime/20',
  paused: 'text-orgx-amber bg-orgx-amber/10 border-orgx-amber/20',
  blocked: 'text-orgx-red bg-orgx-red/10 border-orgx-red/20',
  completed: 'text-teal bg-teal/10 border-teal/20',
};

const taskStatusClass: Record<string, string> = {
  done: 'text-teal bg-teal/10 border-teal/20',
  completed: 'text-teal bg-teal/10 border-teal/20',
  in_progress: 'text-lime bg-lime/10 border-lime/20',
  active: 'text-lime bg-lime/10 border-lime/20',
  blocked: 'text-orgx-red bg-orgx-red/10 border-orgx-red/20',
  todo: 'text-white/60 bg-white/5 border-white/10',
};

export const getTaskStatusClass = (status: string) =>
  taskStatusClass[normalizeStatus(status)] ?? 'text-white/60 bg-white/5 border-white/10';

export const getWorkstreamStatusClass = (status: string) => {
  const s = normalizeStatus(status);
  if (s === 'active' || s === 'in_progress')
    return 'text-lime bg-lime/10 border-lime/20';
  if (s === 'blocked')
    return 'text-orgx-red bg-orgx-red/10 border-orgx-red/20';
  if (s === 'completed' || s === 'done')
    return 'text-teal bg-teal/10 border-teal/20';
  return 'text-white/60 bg-white/5 border-white/10';
};

export const getMilestoneStatusClass = (status: string) => {
  const s = normalizeStatus(status);
  if (s === 'done' || s === 'completed')
    return 'text-teal bg-teal/10 border-teal/20';
  if (s === 'active' || s === 'in_progress')
    return 'text-lime bg-lime/10 border-lime/20';
  return 'text-white/60 bg-white/5 border-white/10';
};

export const formatEntityStatus = (status: string) =>
  status
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

export const statusRank = (value: string): number => {
  const s = normalizeStatus(value);
  if (s === 'blocked') return 0;
  if (s === 'in_progress' || s === 'active') return 1;
  if (s === 'todo' || s === 'planned') return 2;
  if (s === 'done' || s === 'completed') return 3;
  return 4;
};

export const statusColor = (status: string): string => {
  const s = normalizeStatus(status);
  if (s === 'blocked' || s === 'failed') return colors.red;
  if (s === 'needs_input' || s === 'needs_attention' || s === 'awaiting_input') return colors.amber;
  if (s === 'active' || s === 'in_progress' || s === 'running' || s === 'working' || s === 'planning') {
    return colors.lime;
  }
  if (s === 'handoff' || s === 'review') return colors.teal;
  if (s === 'done' || s === 'completed') return colors.teal;
  // Paused, queued and cancelled are out of your hands, not alarms: muted.
  if (s === 'paused' || s === 'queued' || s === 'pending' || s === 'cancelled') return 'rgba(255,255,255,0.5)';
  if (s === 'archived' || s === 'draft') return 'rgba(255,255,255,0.5)';
  return 'rgba(255,255,255,0.35)';
};
