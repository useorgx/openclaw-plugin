/**
 * Canonical status groups for the entire dashboard.
 * Import from here instead of defining inline Sets in each component.
 */
import { normalizeStatus } from '@/lib/tokens';

export const TERMINAL_STATUSES = new Set([
  'completed', 'complete', 'done', 'resolved', 'success', 'succeeded',
  'archived', 'cancelled', 'canceled', 'stopped', 'deleted',
]);

export const FAILED_STATUSES = new Set([
  'failed', 'error', 'timed_out', 'timeout', 'aborted', 'crashed', 'fatal',
]);

export const ACTIVE_STATUSES = new Set([
  'running', 'active', 'in_progress', 'working', 'planning',
  'dispatching', 'queued', 'pending', 'resumed', 'handoff', 'review',
]);

export const BLOCKED_STATUSES = new Set([
  'blocked', 'paused', 'rate_limited', 'waiting_dependency', 'stopping',
  'stalled', 'awaiting_input', 'needs_review', 'needs_decision', 'review_required',
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

export function isFailedStatus(status: string): boolean {
  return FAILED_STATUSES.has(normalizeStatus(status));
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(normalizeStatus(status));
}

export function isBlockedStatus(status: string): boolean {
  return BLOCKED_STATUSES.has(normalizeStatus(status));
}

/** Returns true for any status that means "done" for progress tracking. */
export function isDoneForProgress(status: string): boolean {
  const s = normalizeStatus(status);
  return TERMINAL_STATUSES.has(s) || FAILED_STATUSES.has(s);
}

// ---------------------------------------------------------------------------
// Lifecycle State (premium user-facing labels)
// ---------------------------------------------------------------------------

/** Lifecycle states displayed directly to users — premium product copy. */
export type LifecycleState =
  | 'Queued'
  | 'Dispatching'
  | 'In Progress'
  | 'Blocked'
  | 'Completed'
  | 'Paused'
  | 'Failed';

/**
 * Derive a human-readable lifecycle state from an entity's raw status
 * and optional child stream/task information.
 */
export function deriveLifecycleState(
  rawStatus: string,
  childContext?: {
    hasActiveStreams?: boolean;
    hasDispatchingStreams?: boolean;
    totalTasks?: number;
    completedTasks?: number;
    blockedTasks?: number;
  },
): LifecycleState {
  const s = normalizeStatus(rawStatus);

  // Terminal states
  if (TERMINAL_STATUSES.has(s)) return 'Completed';
  if (FAILED_STATUSES.has(s)) return 'Failed';
  if (s === 'blocked' || s === 'paused') {
    if (s === 'paused') return 'Paused';
    return 'Blocked';
  }
  if (BLOCKED_STATUSES.has(s)) return 'Blocked';

  // Active states with child context
  if (childContext) {
    if (childContext.hasDispatchingStreams) return 'Dispatching';
    if (childContext.hasActiveStreams) return 'In Progress';
    if (childContext.totalTasks && childContext.completedTasks === childContext.totalTasks) return 'Completed';
    if (childContext.blockedTasks && childContext.blockedTasks > 0 && !childContext.hasActiveStreams) return 'Blocked';
  }

  // Simple active/queued derivation
  if (s === 'dispatching') return 'Dispatching';
  if (s === 'queued' || s === 'pending') return 'Queued';
  if (ACTIVE_STATUSES.has(s)) return 'In Progress';

  return 'Queued';
}
