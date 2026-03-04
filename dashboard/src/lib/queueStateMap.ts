import { colors } from '@/lib/tokens';

// ---------------------------------------------------------------------------
// Queue state constants — single source of truth for queue state strings
// in the dashboard. Avoids raw string comparisons scattered across components.
// ---------------------------------------------------------------------------

export const QueueState = {
  QUEUED: 'queued',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  IDLE: 'idle',
  COMPLETED: 'completed',
} as const;

export type QueueStateKey = (typeof QueueState)[keyof typeof QueueState];

// ---------------------------------------------------------------------------
// UI mappings — replaces 15+ duplicated mapping functions across components.
// ---------------------------------------------------------------------------

/** Tailwind class string for queue state pill/badge styling. */
export function queueTone(state: string): string {
  switch (state) {
    case QueueState.RUNNING:
      return 'border-teal-300/35 bg-teal-400/[0.12] text-teal-100';
    case QueueState.BLOCKED:
      return 'border-amber-300/35 bg-amber-400/[0.12] text-amber-100';
    case QueueState.IDLE:
      return 'border-strong bg-white/[0.05] text-secondary';
    default:
      return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
  }
}

/** Human-readable label. */
export function queueLabel(state: string): string {
  switch (state) {
    case QueueState.RUNNING:
      return 'Running';
    case QueueState.BLOCKED:
      return 'Needs input';
    case QueueState.IDLE:
      return 'Idle';
    case QueueState.COMPLETED:
      return 'Completed';
    case QueueState.QUEUED:
      return 'Queued';
    default:
      return state.replace(/_/g, ' ');
  }
}
/** Alias for SliceDetailModal compatibility. */
export const queueStateLabel = queueLabel;

/** Sort rank (lower = higher priority). */
export function queueStateRank(state: string): number {
  switch (state) {
    case QueueState.QUEUED:
    case QueueState.IDLE:
      return 0;
    case QueueState.BLOCKED:
      return 1;
    case QueueState.RUNNING:
      return 2;
    case QueueState.COMPLETED:
      return 3;
    default:
      return 4;
  }
}

/** Gradient highlight for queue state visual accent. */
export function queueHighlight(state: string): string {
  switch (state) {
    case QueueState.RUNNING:
      return 'from-teal-300/0 via-teal-300/60 to-teal-300/0';
    case QueueState.BLOCKED:
      return 'from-amber-300/0 via-amber-300/55 to-amber-300/0';
    case QueueState.IDLE:
      return 'from-white/0 via-white/35 to-white/0';
    default:
      return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
  }
}

/** Heading for the task/scope section. */
export function queueTaskHeading(state: string): string {
  switch (state) {
    case QueueState.RUNNING:
      return 'Current';
    case QueueState.BLOCKED:
      return 'Blocked on';
    default:
      return 'Next';
  }
}

/** Dot color for status indicators. */
export function queueStateDotColor(state: string): string {
  switch (state) {
    case QueueState.RUNNING:
      return colors.lime;
    case QueueState.BLOCKED:
      return colors.red;
    case QueueState.IDLE:
      return colors.iris;
    case QueueState.QUEUED:
      return colors.teal;
    default:
      return colors.amber;
  }
}

/** CSS gradient style for the accent bar. */
export function queueAccentStyle(state: string): React.CSSProperties {
  switch (state) {
    case QueueState.RUNNING:
      return { background: `linear-gradient(to right, ${colors.lime}, ${colors.teal})` };
    case QueueState.BLOCKED:
      return { background: `linear-gradient(to right, ${colors.red}, ${colors.amber})` };
    case QueueState.IDLE:
      return { background: `linear-gradient(to right, ${colors.iris}99, transparent)` };
    default:
      return { background: `linear-gradient(to right, ${colors.lime}B3, ${colors.teal}66)` };
  }
}

/** Section heading for work snapshot in detail modals. */
export function workSnapshotHeading(state: string, isReview?: boolean): string {
  if (isReview) return 'Scope Under Review';
  switch (state) {
    case QueueState.COMPLETED:
      return 'Completed Scope';
    case QueueState.RUNNING:
      return 'Current Work';
    case QueueState.BLOCKED:
      return 'Blocked Work';
    default:
      return 'Next Work';
  }
}

/** Derive aggregate queue state from a list of items. */
export function deriveQueueState(items: { queueState: string }[]): QueueStateKey {
  if (items.some((item) => item.queueState === QueueState.RUNNING)) return QueueState.RUNNING;
  if (items.some((item) => item.queueState === QueueState.BLOCKED)) return QueueState.BLOCKED;
  if (items.some((item) => item.queueState === QueueState.QUEUED)) return QueueState.QUEUED;
  if (items.some((item) => item.queueState === QueueState.IDLE)) return QueueState.IDLE;
  return QueueState.COMPLETED;
}
