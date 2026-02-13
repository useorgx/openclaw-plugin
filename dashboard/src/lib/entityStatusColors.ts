import { colors, normalizeStatus } from '@/lib/tokens';
import type { Initiative } from '@/types';

// Adapted to target palette: lime #BFFF00, teal #14B8A6, red #FF6B88, amber #F5B700
// Tailwind JIT needs full static class strings, so we hardcode the hex values.

export const initiativeStatusClass: Record<Initiative['status'], string> = {
  active: 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20',
  paused: 'text-[#F5B700] bg-[#F5B700]/10 border-[#F5B700]/20',
  blocked: 'text-[#FF6B88] bg-[#FF6B88]/10 border-[#FF6B88]/20',
  completed: 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20',
};

const taskStatusClass: Record<string, string> = {
  done: 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20',
  completed: 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20',
  in_progress: 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20',
  active: 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20',
  blocked: 'text-[#FF6B88] bg-[#FF6B88]/10 border-[#FF6B88]/20',
  todo: 'text-white/60 bg-white/5 border-white/10',
};

export const getTaskStatusClass = (status: string) =>
  taskStatusClass[normalizeStatus(status)] ?? 'text-white/60 bg-white/5 border-white/10';

export const getWorkstreamStatusClass = (status: string) => {
  const s = normalizeStatus(status);
  if (s === 'active' || s === 'in_progress')
    return 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20';
  if (s === 'blocked')
    return 'text-[#FF6B88] bg-[#FF6B88]/10 border-[#FF6B88]/20';
  if (s === 'completed' || s === 'done')
    return 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20';
  return 'text-white/60 bg-white/5 border-white/10';
};

export const getMilestoneStatusClass = (status: string) => {
  const s = normalizeStatus(status);
  if (s === 'done' || s === 'completed')
    return 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20';
  if (s === 'active' || s === 'in_progress')
    return 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20';
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
  if (s === 'blocked' || s === 'failed' || s === 'cancelled') return colors.red;
  if (s === 'active' || s === 'in_progress' || s === 'running') return colors.lime;
  if (s === 'done' || s === 'completed') return colors.teal;
  if (s === 'paused') return colors.amber;
  if (s === 'queued' || s === 'pending' || s === 'working' || s === 'planning') return colors.amber;
  if (s === 'archived' || s === 'draft') return 'rgba(255,255,255,0.5)';
  return 'rgba(255,255,255,0.35)';
};
