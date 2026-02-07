import { colors } from '@/lib/tokens';
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
  taskStatusClass[status.toLowerCase()] ?? 'text-white/60 bg-white/5 border-white/10';

export const getWorkstreamStatusClass = (status: string) => {
  const lower = status.toLowerCase();
  if (lower === 'active' || lower === 'in_progress')
    return 'text-[#BFFF00] bg-[#BFFF00]/10 border-[#BFFF00]/20';
  if (lower === 'blocked')
    return 'text-[#FF6B88] bg-[#FF6B88]/10 border-[#FF6B88]/20';
  if (lower === 'completed' || lower === 'done')
    return 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20';
  return 'text-white/60 bg-white/5 border-white/10';
};

export const getMilestoneStatusClass = (status: string) => {
  const lower = status.toLowerCase();
  if (lower === 'done' || lower === 'completed')
    return 'text-[#14B8A6] bg-[#14B8A6]/10 border-[#14B8A6]/20';
  if (lower === 'active' || lower === 'in_progress')
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
  const normalized = value.toLowerCase();
  if (normalized === 'blocked') return 0;
  if (normalized === 'in_progress' || normalized === 'active') return 1;
  if (normalized === 'todo' || normalized === 'planned') return 2;
  if (normalized === 'done' || normalized === 'completed') return 3;
  return 4;
};

export const statusColor = (status: string): string => {
  const lower = status.toLowerCase();
  if (lower === 'blocked') return colors.red;
  if (lower === 'active' || lower === 'in_progress') return colors.lime;
  if (lower === 'done' || lower === 'completed') return colors.teal;
  if (lower === 'paused') return colors.amber;
  return 'rgba(255,255,255,0.35)';
};
