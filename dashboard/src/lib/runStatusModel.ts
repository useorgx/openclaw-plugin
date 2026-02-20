import type { LiveActivityType } from '@/types';
import { normalizeStatus } from '@/lib/tokens';

export type CanonicalRunStatus =
  | 'in_progress'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface CanonicalRunProjection {
  status: CanonicalRunStatus;
  label: string;
  sentence: string;
  nextAction: string | null;
  tone: 'neutral' | 'warning' | 'critical' | 'positive';
  isTerminal: boolean;
  isActionRequired: boolean;
}

export interface RunStatusInputs {
  sessionStatus?: string | null;
  sessionPhase?: string | null;
  sessionState?: string | null;
  sliceStatus?: string | null;
  activityType?: LiveActivityType | string | null;
  activityStatus?: string | null;
  stopReason?: string | null;
  decisionRequired?: boolean | null;
  blockingDecisionCount?: number | null;
  nonBlockingDecisionCount?: number | null;
  blockerCount?: number | null;
  blockerReason?: string | null;
}

const FAILED_SIGNALS = new Set([
  'failed',
  'error',
  'timed_out',
  'timeout',
  'aborted',
  'crashed',
  'fatal',
]);

const HARD_ATTENTION_SIGNALS = new Set([
  'awaiting_input',
  'needs_review',
  'needs_decision',
  'review_required',
]);

const SOFT_ATTENTION_SIGNALS = new Set([
  'blocked',
  'paused',
  'rate_limited',
  'waiting_dependency',
  'stopping',
]);

const COMPLETED_SIGNALS = new Set([
  'completed',
  'complete',
  'done',
  'resolved',
  'success',
  'succeeded',
  'archived',
  'cancelled',
  'stopped',
]);

const IN_PROGRESS_SIGNALS = new Set([
  'running',
  'active',
  'in_progress',
  'working',
  'planning',
  'dispatching',
  'queued',
  'pending',
  'resumed',
  'handoff',
]);

function statusKey(value: string | null | undefined): string {
  if (!value) return '';
  return normalizeStatus(value);
}

function safeCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function hasFailureSignal(keys: string[]): boolean {
  return keys.some((key) => FAILED_SIGNALS.has(key));
}

function hasHardAttentionSignal(keys: string[]): boolean {
  return keys.some((key) => HARD_ATTENTION_SIGNALS.has(key));
}

function hasSoftAttentionSignal(keys: string[]): boolean {
  return keys.some((key) => SOFT_ATTENTION_SIGNALS.has(key));
}

function hasCompletionSignal(keys: string[]): boolean {
  return keys.some((key) => COMPLETED_SIGNALS.has(key));
}

function hasInProgressSignal(keys: string[]): boolean {
  return keys.some((key) => IN_PROGRESS_SIGNALS.has(key));
}

function projection(
  status: CanonicalRunStatus,
  sentence: string,
  options?: {
    nextAction?: string | null;
    tone?: CanonicalRunProjection['tone'];
  }
): CanonicalRunProjection {
  const label =
    status === 'in_progress'
      ? 'In progress'
      : status === 'needs_attention'
        ? 'Needs attention'
        : status === 'completed'
          ? 'Completed'
          : status === 'failed'
            ? 'Failed'
            : 'Update';

  const tone =
    options?.tone ??
    (status === 'completed'
      ? 'positive'
      : status === 'failed'
        ? 'critical'
        : status === 'needs_attention'
          ? 'warning'
          : 'neutral');

  const isTerminal = status === 'completed' || status === 'failed';
  const isActionRequired = status === 'needs_attention' || status === 'failed';

  return {
    status,
    label,
    sentence,
    nextAction: options?.nextAction ?? null,
    tone,
    isTerminal,
    isActionRequired,
  };
}

export function projectRunStatus(input: RunStatusInputs): CanonicalRunProjection {
  const sessionStatus = statusKey(input.sessionStatus);
  const sessionPhase = statusKey(input.sessionPhase);
  const sessionState = statusKey(input.sessionState);
  const sliceStatus = statusKey(input.sliceStatus);
  const activityStatus = statusKey(input.activityStatus);
  const stopReason = statusKey(input.stopReason);
  const activityType = (input.activityType ?? '').toString().trim().toLowerCase();

  const keys = [sessionStatus, sessionPhase, sessionState, sliceStatus, activityStatus, stopReason].filter(
    (value) => value.length > 0
  );

  const blockingDecisions = safeCount(input.blockingDecisionCount);
  const nonBlockingDecisions = safeCount(input.nonBlockingDecisionCount);
  const blockerCount = safeCount(input.blockerCount);

  const explicitFailureEvent = activityType === 'run_failed';
  const explicitCompletionEvent =
    activityType === 'run_completed' ||
    activityType === 'milestone_completed' ||
    activityType === 'decision_resolved';

  const failed = explicitFailureEvent || hasFailureSignal(keys);
  const hardAttention =
    hasHardAttentionSignal(keys) ||
    activityType === 'decision_requested' ||
    blockingDecisions > 0 ||
    input.decisionRequired === true;
  const softAttention = hasSoftAttentionSignal(keys) || blockerCount > 0;
  const completed = explicitCompletionEvent || hasCompletionSignal(keys);
  const inProgress = hasInProgressSignal(keys) || activityType === 'run_started';

  if (failed) {
    return projection('failed', 'Execution failed and needs intervention.', {
      nextAction: 'Review evidence',
      tone: 'critical',
    });
  }

  const canTreatAsCompleted =
    completed &&
    !hardAttention &&
    !failed &&
    // Allow completion to override soft "blocked" stop states when no concrete blocker exists.
    blockerCount === 0 &&
    !input.blockerReason;

  if (canTreatAsCompleted) {
    if (nonBlockingDecisions > 0) {
      return projection('completed', 'Execution completed with optional follow-up decisions.', {
        nextAction: 'Review optional follow-up',
        tone: 'positive',
      });
    }
    return projection('completed', 'Execution completed successfully.', {
      tone: 'positive',
    });
  }

  if (hardAttention || softAttention) {
    if (blockingDecisions > 0 || input.decisionRequired === true || activityType === 'decision_requested') {
      return projection('needs_attention', 'Execution is waiting for a decision.', {
        nextAction: 'Resolve decision',
        tone: 'warning',
      });
    }
    return projection('needs_attention', 'Execution is blocked and needs intervention.', {
      nextAction: 'Review blocker',
      tone: softAttention ? 'critical' : 'warning',
    });
  }

  if (completed) {
    if (nonBlockingDecisions > 0) {
      return projection('completed', 'Execution completed with optional follow-up decisions.', {
        nextAction: 'Review optional follow-up',
        tone: 'positive',
      });
    }
    return projection('completed', 'Execution completed successfully.', {
      tone: 'positive',
    });
  }

  if (inProgress) {
    return projection('in_progress', 'Execution is in progress.', {
      tone: 'neutral',
    });
  }

  return projection('unknown', 'Status is available but not fully classified yet.', {
    tone: 'neutral',
  });
}
