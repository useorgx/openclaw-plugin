import { isTerminalStatus } from '@/lib/status-taxonomy';

export function isDoneStatus(status: string): boolean {
  return isTerminalStatus(status);
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

// ---------------------------------------------------------------------------
// Cascade Progress (parent progress derived from child task states)
// ---------------------------------------------------------------------------

export interface CascadeProgress {
  workstreamPct: number;
  milestonePct: number;
  initiativePct: number;
}

/**
 * Compute cascaded progress percentages from child task completion data.
 * Used to derive parent entity progress from actual task states.
 */
export function cascadeProgress(tasks: Array<{ status: string; workstreamId?: string; milestoneId?: string }>): CascadeProgress {
  if (tasks.length === 0) return { workstreamPct: 0, milestonePct: 0, initiativePct: 0 };

  // Group tasks by workstream and milestone
  const byWorkstream = new Map<string, { done: number; total: number }>();
  const byMilestone = new Map<string, { done: number; total: number }>();

  for (const task of tasks) {
    const done = isDoneStatus(task.status) ? 1 : 0;

    const wsKey = task.workstreamId ?? '__none__';
    const ws = byWorkstream.get(wsKey) ?? { done: 0, total: 0 };
    ws.done += done;
    ws.total += 1;
    byWorkstream.set(wsKey, ws);

    if (task.milestoneId) {
      const ms = byMilestone.get(task.milestoneId) ?? { done: 0, total: 0 };
      ms.done += done;
      ms.total += 1;
      byMilestone.set(task.milestoneId, ms);
    }
  }

  // Average progress across workstreams
  const wsPcts = [...byWorkstream.values()].map(ws => completionPercent(ws.done, ws.total));
  const workstreamPct = wsPcts.length > 0 ? clampPercent(wsPcts.reduce((a, b) => a + b, 0) / wsPcts.length) : 0;

  // Average progress across milestones
  const msPcts = [...byMilestone.values()].map(ms => completionPercent(ms.done, ms.total));
  const milestonePct = msPcts.length > 0 ? clampPercent(msPcts.reduce((a, b) => a + b, 0) / msPcts.length) : 0;

  // Initiative progress = overall task completion
  const totalDone = tasks.filter(t => isDoneStatus(t.status)).length;
  const initiativePct = completionPercent(totalDone, tasks.length);

  return { workstreamPct, milestonePct, initiativePct };
}

