import { normalizeStatus } from '@/lib/tokens';

const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
]);

export function isDoneStatus(status: string): boolean {
  return DONE_STATUSES.has(normalizeStatus(status));
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function completionPercent(doneCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return clampPercent((doneCount / totalCount) * 100);
}

export function completionFromItems<T extends { status: string }>(items: T[]): {
  done: number;
  total: number;
  percent: number;
} {
  const total = items.length;
  const done = items.filter((item) => isDoneStatus(item.status)).length;
  return { done, total, percent: completionPercent(done, total) };
}

