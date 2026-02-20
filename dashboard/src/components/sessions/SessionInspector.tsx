import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { sanitizeDisplayText } from '@/lib/humanize';
import { resolveProvider } from '@/lib/providers';
import type { Initiative, LiveActivityItem, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { useUndoToast } from '@/components/shared/UndoToast';

interface SessionInspectorProps {
  session: SessionTreeNode | null;
  activity: LiveActivityItem[];
  initiatives?: Initiative[];
  onOpenActivityItem?: (item: LiveActivityItem) => void;
  onContinueHighestPriority?: () => Promise<void> | void;
  onDispatchSession?: (session: SessionTreeNode) => Promise<void> | void;
  onPauseSession?: (session: SessionTreeNode) => Promise<void> | void;
  onResumeSession?: (session: SessionTreeNode) => Promise<void> | void;
  onCancelSession?: (session: SessionTreeNode) => Promise<void> | void;
  onCreateCheckpoint?: (session: SessionTreeNode) => Promise<void> | void;
  onRollbackSession?: (session: SessionTreeNode) => Promise<void> | void;
  onStartInitiative?: () => Promise<void> | void;
  onStartWorkstream?: (initiativeId: string | null) => Promise<void> | void;
  initialInterventionDraft?: {
    workstreamId: string | null;
    text: string;
  } | null;
  onSubmitIntervention?: (input: {
    session: SessionTreeNode;
    workstreamId: string | null;
    text: string;
  }) => Promise<void> | void;
}

const UUID_RE = /^[0-9a-f-]{20,}$/i;
const ACTIVE_SESSION_STATUSES = new Set([
  'running',
  'active',
  'queued',
  'pending',
  'in_progress',
  'working',
  'planning',
  'handoff',
  'review',
]);
const GENERIC_FAILURE_REASONS = new Set([
  'agent execution failed',
  'execution failed',
  'run failed',
  'failed',
]);

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStatus(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeReason(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isGenericFailureReason(value: string): boolean {
  return GENERIC_FAILURE_REASONS.has(normalizeReason(value));
}

function compactList(values: string[], max = 3): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} +${values.length - max} more`;
}

function resolveRunId(item: LiveActivityItem): string | null {
  if (item.runId && item.runId.trim().length > 0) return item.runId.trim();
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const keys = [
    'slice_run_id',
    'sliceRunId',
    'runId',
    'run_id',
    'correlation_id',
    'correlationId',
    'sessionId',
    'session_id',
    'agentRunId',
  ];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function effectiveSessionStatus(session: SessionTreeNode): string {
  const status = normalizeStatus(session.status);
  if (status === 'blocked' || status === 'failed' || status === 'completed' || status === 'cancelled') {
    return status;
  }

  const phase = normalizeStatus(session.phase);
  if (phase === 'blocked') return 'blocked';
  if (phase === 'handoff') return 'handoff';
  if (phase === 'completed') return 'completed';
  if (phase === 'review') return 'review';

  const state = normalizeStatus(session.state);
  if (state === 'error') return 'failed';
  if (state === 'stopped') return 'paused';
  if (state === 'stale') return 'queued';

  if (ACTIVE_SESSION_STATUSES.has(status)) return status;
  if (session.blockers.length > 0) return 'blocked';

  return status || 'unknown';
}

function resolveStatusReason(
  session: SessionTreeNode,
  sessionStatus: string,
  sessionSummary: string | null
): string | null {
  const candidates = [
    session.blockerDiagnostics?.reason ?? null,
    session.blockerReason ?? null,
    ...session.blockers,
    sessionStatus === 'blocked' || sessionStatus === 'failed' || sessionStatus === 'handoff'
      ? sessionSummary
      : null,
  ]
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);

  if (candidates.length > 0) {
    const specific = candidates.find((entry) => !isGenericFailureReason(entry));
    return specific ?? candidates[0];
  }

  if (sessionStatus === 'handoff') {
    return 'Waiting for handoff acceptance by the next agent.';
  }
  if (sessionStatus === 'blocked') {
    return 'Blocked without an explicit reason from runtime.';
  }
  if (sessionStatus === 'failed') {
    return 'Run failed without explicit error details.';
  }
  return null;
}

export const SessionInspector = memo(function SessionInspector({
  session,
  activity,
  initiatives = [],
  onOpenActivityItem,
  onContinueHighestPriority,
  onDispatchSession,
  onPauseSession,
  onResumeSession,
  onCancelSession,
  onCreateCheckpoint,
  onRollbackSession,
  onStartInitiative,
  onStartWorkstream,
  initialInterventionDraft = null,
  onSubmitIntervention,
}: SessionInspectorProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [interventionText, setInterventionText] = useState('');
  const { enqueue: enqueueUndo, ToastRenderer: UndoToastRenderer } = useUndoToast();

  useEffect(() => {
    if (!session) {
      setInterventionText('');
      return;
    }
    if (initialInterventionDraft?.text) {
      setInterventionText(initialInterventionDraft.text);
      return;
    }
    setInterventionText('');
  }, [initialInterventionDraft?.text, session?.id]);

  const recentEvents = useMemo(() => {
    if (!session) return [] as LiveActivityItem[];
    const runKeys = new Set<string>();
    if (session.runId?.trim()) runKeys.add(session.runId.trim());
    if (session.id?.trim()) runKeys.add(session.id.trim());
    if (session.blockerDiagnostics?.context?.sliceRunId?.trim()) {
      runKeys.add(session.blockerDiagnostics.context.sliceRunId.trim());
    }
    if (runKeys.size === 0) return [] as LiveActivityItem[];

    return activity
      .filter((item) => {
        const runId = resolveRunId(item);
        return Boolean(runId && runKeys.has(runId));
      })
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 12);
  }, [activity, session]);

  const breadcrumbs = useMemo(() => {
    if (!session) return [] as Array<{ label: string; value: string }>;

    const output: Array<{ label: string; value: string }> = [];

    // Initiative name from initiatives array
    const initiativeId = session.initiativeId ?? session.groupId;
    if (initiativeId) {
      const match = initiatives.find((i) => i.id === initiativeId);
      if (match) {
        output.push({ label: 'Initiative', value: match.name });
      } else if (session.groupLabel && session.groupLabel.trim().length > 0) {
        output.push({ label: 'Initiative', value: session.groupLabel });
      }
    }

    // Workstream name from initiatives workstreams
    if (session.workstreamId) {
      let wsName: string | null = null;
      for (const init of initiatives) {
        const ws = init.workstreams?.find((w) => w.id === session.workstreamId);
        if (ws) {
          wsName = ws.name;
          break;
        }
      }
      // Suppress raw UUIDs
      if (!wsName && !UUID_RE.test(session.workstreamId)) {
        wsName = session.workstreamId;
      }
      if (wsName) {
        output.push({ label: 'Workstream', value: wsName });
      }
    }

    // Milestone from phase
    const milestone = session.phase ?? null;
    if (milestone) {
      output.push({ label: 'Milestone', value: String(milestone) });
    }

    // Task
    if (session.title) {
      output.push({ label: 'Task', value: session.title });
    }

    return output;
  }, [initiatives, session]);

  const sessionSummary = useMemo(() => {
    if (!session) return null;
    const fromEvents = recentEvents[0]?.summary ?? recentEvents[0]?.description ?? null;
    const fromSession = session.lastEventSummary;
    const summary = fromSession ?? fromEvents ?? null;
    return summary && summary.trim().length > 0 ? summary.trim() : null;
  }, [recentEvents, session]);

  const provider = useMemo(() => {
    if (!session) return resolveProvider();
    return resolveProvider(
      session.agentName,
      session.title,
      session.lastEventSummary,
      sessionSummary,
      recentEvents[0]?.metadata
    );
  }, [recentEvents, session, sessionSummary]);

  const runAction = async (
    actionId: string,
    actionLabel: string,
    callback: (() => Promise<void> | void) | undefined
  ) => {
    if (!callback || busyAction) return;
    setBusyAction(actionId);
    setNotice(null);
    try {
      await callback();
      setNotice(`${actionLabel} requested.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `${actionLabel} failed.`);
    } finally {
      setBusyAction(null);
    }
  };

  if (!session) {
    return (
      <PremiumCard className="flex h-full min-h-0 flex-col overflow-hidden card-enter">
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3.5">
          <h2 className="text-heading font-semibold text-white">Session Detail</h2>
          <button
            onClick={() => setIsCollapsed((prev) => !prev)}
            className="text-muted transition-colors hover:text-primary"
            aria-label={isCollapsed ? 'Expand session detail' : 'Collapse session detail'}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={cn('transition-transform', isCollapsed ? '-rotate-90' : 'rotate-0')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
        <div className={cn(
          'transition-all',
          isCollapsed ? 'max-h-0 overflow-hidden' : 'min-h-0 flex-1'
        )}>
          <div className="h-full min-h-0 space-y-2 overflow-y-auto p-4 text-body text-secondary">
            <p>Select a session to inspect summary, breadcrumbs, blockers, and recent messages.</p>
            <button
              onClick={() =>
                runAction('continue-priority', 'Continue highest priority', onContinueHighestPriority)
              }
              disabled={!onContinueHighestPriority || !!busyAction}
              className="rounded-md border border-strong bg-white/[0.04] px-3 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              {busyAction === 'continue-priority' ? 'Dispatching…' : 'Continue highest priority'}
            </button>
            {notice && <p className="text-caption text-secondary">{notice}</p>}
          </div>
        </div>
      </PremiumCard>
    );
  }

  const progressValue = session.progress === null ? null : Math.round(session.progress);
  const sessionStatus = effectiveSessionStatus(session);
  const statusReason = resolveStatusReason(session, sessionStatus, sessionSummary);
  const statusReasonLabel =
    sessionStatus === 'handoff'
      ? 'Handoff'
      : sessionStatus === 'blocked'
        ? 'Blocker reason'
        : sessionStatus === 'failed'
          ? 'Failure reason'
          : 'Status note';
  const canPause = ['running', 'active', 'queued', 'pending'].includes(sessionStatus);
  const canResume = ['paused', 'blocked', 'queued', 'pending'].includes(sessionStatus);
  const canCancel = !['completed', 'archived', 'cancelled'].includes(sessionStatus);
  const canRollback = !['archived', 'cancelled'].includes(sessionStatus);
  const statusLabel = sessionStatus.replace(/_/g, ' ');
  const statusTone =
    sessionStatus === 'running' ||
    sessionStatus === 'active' ||
    sessionStatus === 'working' ||
    sessionStatus === 'in_progress' ||
    sessionStatus === 'planning' ||
    sessionStatus === 'review'
      ? 'border-lime/25 bg-lime/[0.08] text-lime'
      : sessionStatus === 'blocked' || sessionStatus === 'failed'
        ? 'border-red-400/30 bg-red-500/10 text-red-200'
        : sessionStatus === 'paused'
          ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
          : sessionStatus === 'handoff'
            ? 'border-teal-400/30 bg-teal-400/10 text-teal-200'
            : 'border-strong bg-white/[0.04] text-secondary';
  const isRunning = ['running', 'active', 'working', 'in_progress', 'planning', 'review'].includes(sessionStatus);
  const blockerDiagnostics = session.blockerDiagnostics ?? null;
  const blockerContext = blockerDiagnostics?.context ?? null;
  const blockerMetaChips = [
    hasText(blockerDiagnostics?.source) ? `Source: ${blockerDiagnostics.source.trim()}` : null,
    hasText(blockerDiagnostics?.errorCode) ? `Code: ${blockerDiagnostics.errorCode.trim()}` : null,
    hasText(blockerDiagnostics?.errorCategory)
      ? `Category: ${blockerDiagnostics.errorCategory.trim()}`
      : null,
    blockerDiagnostics?.retryable === true
      ? 'Retryable: yes'
      : blockerDiagnostics?.retryable === false
        ? 'Retryable: no'
        : null,
  ].filter((entry): entry is string => Boolean(entry));
  const blockerContextRows: Array<{ label: string; value: string }> = [];
  if (blockerContext) {
    if (hasText(blockerContext.workstreamTitle)) {
      blockerContextRows.push({
        label: 'Workstream',
        value: hasText(blockerContext.workstreamId)
          ? `${blockerContext.workstreamTitle.trim()} (${blockerContext.workstreamId.trim()})`
          : blockerContext.workstreamTitle.trim(),
      });
    } else if (hasText(blockerContext.workstreamId)) {
      blockerContextRows.push({ label: 'Workstream', value: blockerContext.workstreamId.trim() });
    }
    if (hasText(blockerContext.sliceRunId)) {
      blockerContextRows.push({ label: 'Slice run', value: blockerContext.sliceRunId.trim() });
    }
    if (hasText(blockerContext.parallelMode)) {
      blockerContextRows.push({ label: 'Mode', value: blockerContext.parallelMode.trim().toUpperCase() });
    }
    if (Array.isArray(blockerContext.taskIds) && blockerContext.taskIds.length > 0) {
      blockerContextRows.push({
        label: 'Tasks',
        value: compactList(blockerContext.taskIds),
      });
    }
    if (Array.isArray(blockerContext.milestoneIds) && blockerContext.milestoneIds.length > 0) {
      blockerContextRows.push({
        label: 'Milestones',
        value: compactList(blockerContext.milestoneIds),
      });
    }
    if (hasText(blockerContext.logPath)) {
      blockerContextRows.push({ label: 'Log path', value: blockerContext.logPath.trim() });
    }
    if (hasText(blockerContext.outputPath)) {
      blockerContextRows.push({ label: 'Output path', value: blockerContext.outputPath.trim() });
    }
  }
  const showBlockedContext =
    (sessionStatus === 'blocked' || sessionStatus === 'failed') &&
    Boolean(
      blockerDiagnostics &&
        (hasText(blockerDiagnostics.reason) ||
          blockerMetaChips.length > 0 ||
          blockerContextRows.length > 0 ||
          (Array.isArray(blockerDiagnostics.suggestedActions) &&
            blockerDiagnostics.suggestedActions.length > 0))
    );
  const statusReasonText = hasText(statusReason) ? statusReason : null;
  const showStatusReason =
    statusReasonText !== null &&
    !(
      sessionSummary &&
      (statusReasonText === sessionSummary || sessionSummary.includes(statusReasonText))
    ) &&
    !showBlockedContext;

  const handleCancelWithUndo = useCallback(() => {
    if (!onCancelSession || !session) return;
    setNotice('Session will be cancelled…');
    enqueueUndo({
      message: `Cancelled "${session.title}"`,
      onCommit: async () => {
        try {
          await onCancelSession(session);
          setNotice('Session cancelled.');
        } catch (err) {
          setNotice(err instanceof Error ? err.message : 'Cancel failed.');
        }
      },
      onUndo: () => {
        setNotice(null);
      },
    });
  }, [onCancelSession, session, enqueueUndo]);

  const timelineInfo = [
    { label: 'Started', value: session.startedAt ? formatRelativeTime(session.startedAt) : '—' },
    { label: 'Updated', value: session.updatedAt ? formatRelativeTime(session.updatedAt) : '—' },
    { label: 'ETA', value: session.eta ?? '—' },
    {
      label: 'Checkpoints',
      value: session.checkpointCount !== null && session.checkpointCount !== undefined
        ? String(session.checkpointCount)
        : '—',
    },
  ];

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col overflow-hidden card-enter">
      <div className="flex items-center justify-between border-b border-subtle px-4 py-3.5">
        <h2 className="text-heading font-semibold text-white">Session Detail</h2>
        <div className="flex items-center gap-2">
          <span className={cn('chip text-caption uppercase tracking-[0.14em]', statusTone)}>
            {statusLabel}
          </span>
          <button
            onClick={() => setIsCollapsed((prev) => !prev)}
            className="text-muted transition-colors hover:text-primary"
            aria-label={isCollapsed ? 'Expand session detail' : 'Collapse session detail'}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={cn('transition-transform', isCollapsed ? '-rotate-90' : 'rotate-0')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      <div className={cn(
        'transition-all',
        isCollapsed ? 'max-h-0 overflow-hidden' : 'min-h-0 flex-1'
      )}>
        <div className="h-full min-h-0 space-y-4 overflow-y-auto p-4">
          <div className="rounded-xl border border-subtle bg-white/[0.02] p-3">
            <div className="flex items-start gap-3">
              <ProviderLogo provider={provider.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-semibold text-white">{sanitizeDisplayText(session.title)}</p>
                <p className="mt-1 text-caption text-secondary">
                  {session.agentName ?? 'OrgX'} · {provider.label}
                </p>
              </div>
            </div>

            {breadcrumbs.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-micro uppercase tracking-[0.16em] text-muted">Context</p>
                <div className="flex flex-wrap items-center gap-1.5 text-caption">
                  {breadcrumbs.map((crumb, index) => (
                    <span key={`${crumb.label}-${crumb.value}`} className="inline-flex items-center gap-1.5">
                      <span className="rounded-full border border-strong bg-white/[0.02] px-2 py-0.5 text-secondary">
                        {crumb.value}
                      </span>
                      {index < breadcrumbs.length - 1 && (
                        <span className="text-caption text-muted">›</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {sessionSummary && (
              <div className="mt-3 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2">
                <p className="mb-1 text-micro uppercase tracking-[0.16em] text-muted">Summary</p>
                <MarkdownText text={sessionSummary} mode="block" />
              </div>
            )}

            {/* Phase/Runtime badges removed — status chip in header is sufficient */}

            {showStatusReason && (
              <div className="mt-3 rounded-lg border border-subtle bg-white/[0.02] px-3 py-2">
                <p className="mb-1 text-micro uppercase tracking-[0.16em] text-muted">{statusReasonLabel}</p>
                <p className="text-body text-secondary">{statusReasonText}</p>
              </div>
            )}

            {showBlockedContext && (
              <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5">
                <p className="mb-1 text-micro uppercase tracking-[0.16em] text-red-200/75">Why blocked</p>
                <p className="text-body text-red-100/90">
                  {blockerDiagnostics?.reason ?? statusReason ?? 'Runtime marked this run as blocked without details.'}
                </p>

                {blockerMetaChips.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {blockerMetaChips.map((chip) => (
                      <span
                        key={chip}
                        className="rounded-full border border-red-300/25 bg-red-500/10 px-2 py-0.5 text-micro text-red-100/85"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                )}

                {blockerContextRows.length > 0 && (
                  <div className="mt-2 rounded-md border border-red-300/20 bg-black/15 p-2.5">
                    <p className="mb-1 text-micro uppercase tracking-[0.14em] text-red-200/65">Associated context</p>
                    <dl className="grid grid-cols-1 gap-1.5 text-caption text-red-100/85">
                      {blockerContextRows.map((row) => (
                        <div key={row.label} className="grid grid-cols-[86px_1fr] gap-2">
                          <dt className="text-red-200/70">{row.label}</dt>
                          <dd className="break-all text-red-50/95">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {Array.isArray(blockerDiagnostics?.suggestedActions) &&
                  blockerDiagnostics.suggestedActions.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-micro uppercase tracking-[0.14em] text-red-200/65">Suggested actions</p>
                      <ul className="space-y-1 text-caption text-red-100/85">
                        {blockerDiagnostics.suggestedActions.map((action) => (
                          <li key={action}>• {action}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                {hasText(blockerDiagnostics?.eventTimestamp) && (
                  <p className="mt-2 text-micro text-red-200/60">
                    Last blocker event: {new Date(blockerDiagnostics.eventTimestamp).toLocaleString()} ·{' '}
                    {formatRelativeTime(blockerDiagnostics.eventTimestamp)}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-subtle bg-white/[0.02] p-3">
            {progressValue !== null && (
              <div>
                <div className="mb-1 flex items-center justify-between text-caption text-secondary">
                  <span>Progress</span>
                  <span className="text-primary">{progressValue}%</span>
                </div>
                <div className="h-2 rounded-full bg-white/[0.08]">
                  <div
                    className={cn('h-2 rounded-full transition-all duration-500', isRunning && 'live-pulse')}
                    style={{
                      width: `${progressValue}%`,
                      background: colors.lime,
                    }}
                  />
                </div>
              </div>
            )}

            <dl className={cn(
              'grid grid-cols-2 gap-3 text-caption text-secondary',
              progressValue !== null ? 'mt-3' : ''
            )}>
              {timelineInfo.map((row) => (
                <div key={row.label}>
                  <dt className="text-muted">{row.label}</dt>
                  <dd className="text-body font-semibold text-white">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-xl border border-subtle bg-white/[0.02] p-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  runAction('dispatch-session', 'Session started', () => onDispatchSession?.(session))
                }
                disabled={!onDispatchSession || !!busyAction}
                className="rounded-md border border-lime/25 bg-lime/10 px-3 py-2 text-caption font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
              >
                {busyAction === 'dispatch-session' ? 'Starting…' : 'Start'}
              </button>
              <button
                onClick={() =>
                  runAction('continue-priority', 'Resumed highest priority', onContinueHighestPriority)
                }
                disabled={!onContinueHighestPriority || !!busyAction}
                className="rounded-md border border-strong bg-white/[0.03] px-3 py-2 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
              >
                {busyAction === 'continue-priority' ? 'Resuming…' : 'Resume'}
              </button>
              {canPause && (
                <button
                  onClick={() => runAction('pause-session', 'Session paused', () => onPauseSession?.(session))}
                  disabled={!onPauseSession || !!busyAction}
                  className="rounded-md border border-strong bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
                >
                  {busyAction === 'pause-session' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              {canResume && (
                <button
                  onClick={() => runAction('resume-session', 'Session resumed', () => onResumeSession?.(session))}
                  disabled={!onResumeSession || !!busyAction}
                  className="rounded-md border border-strong bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
                >
                  {busyAction === 'resume-session' ? 'Resuming…' : 'Resume'}
                </button>
              )}
              <button
                onClick={() =>
                  runAction('checkpoint-session', 'Progress saved', () => onCreateCheckpoint?.(session))
                }
                disabled={!onCreateCheckpoint || !!busyAction}
                className="rounded-md border border-strong bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
              >
                {busyAction === 'checkpoint-session' ? 'Saving…' : 'Save progress'}
              </button>
              {canRollback && (
                <button
                  onClick={() => runAction('rollback-session', 'Undo requested', () => onRollbackSession?.(session))}
                  disabled={!onRollbackSession || !!busyAction}
                  className="rounded-md border border-strong bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
                >
                  {busyAction === 'rollback-session' ? 'Undoing…' : 'Undo last step'}
                </button>
              )}
            </div>
            {onSubmitIntervention && (
              <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/[0.18] px-3 py-2.5">
                <p className="mb-2 text-micro uppercase tracking-[0.16em] text-muted">Intervene</p>
                <textarea
                  value={interventionText}
                  onChange={(event) => setInterventionText(event.target.value)}
                  placeholder="Share guidance for this run..."
                  className="min-h-[84px] w-full resize-y rounded-lg border border-white/[0.10] bg-white/[0.03] px-3 py-2 text-body text-bright outline-none placeholder:text-faint focus:border-white/20"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-micro text-secondary">Visible to agents and collaborators.</p>
                  <button
                    type="button"
                    onClick={() => {
                      const text = interventionText.trim();
                      if (!text) {
                        setNotice('Intervention note cannot be empty.');
                        return;
                      }
                      void runAction('intervene-note', 'Intervention sent', async () => {
                        await onSubmitIntervention({
                          session,
                          workstreamId: initialInterventionDraft?.workstreamId ?? session.workstreamId ?? null,
                          text,
                        });
                        setInterventionText('');
                      });
                    }}
                    disabled={!!busyAction || interventionText.trim().length === 0}
                    className="rounded-md border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                  >
                    {busyAction === 'intervene-note' ? 'Sending…' : 'Send intervention'}
                  </button>
                </div>
              </div>
            )}
            {canCancel && onCancelSession && (
              <div className="mt-3 border-t border-subtle pt-3">
                <button
                  onClick={handleCancelWithUndo}
                  disabled={!!busyAction}
                  className="text-caption text-secondary transition-colors hover:text-red-300 disabled:opacity-45"
                >
                  Cancel session…
                </button>
              </div>
            )}
          </div>

          {notice && (
            <p className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-caption text-secondary">
              {notice}
            </p>
          )}

          {session.blockers.length > 0 && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
              <h3 className="mb-1 text-caption uppercase tracking-[0.12em] text-red-200/70">
                Blockers
              </h3>
              <ul className="space-y-1 text-body text-red-100/90">
                {session.blockers.map((blocker) => (
                  <li key={blocker}>• {blocker}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-caption uppercase tracking-[0.16em] text-secondary">
              Recent Messages
            </h3>

            {recentEvents.length === 0 && (
              <p className="text-body text-secondary">No recent messages for this run.</p>
            )}

            <div className="space-y-2">
              {recentEvents.map((event) => (
                <article
                  key={event.id}
                  className="rounded-lg border border-subtle bg-white/[0.02] px-2.5 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-caption text-bright">{event.title}</p>
                    {onOpenActivityItem && (
                      <button
                        type="button"
                        onClick={() => onOpenActivityItem(event)}
                        className="flex-shrink-0 rounded-full border border-strong bg-white/[0.03] px-2.5 py-0.5 text-micro font-semibold text-secondary transition-colors hover:bg-white/[0.08] hover:text-primary"
                      >
                        Open
                      </button>
                    )}
                  </div>
                  {(event.summary || event.description) && (
                    <p className="mt-0.5 line-clamp-2 text-caption text-secondary">
                      {event.summary ?? event.description}
                    </p>
                  )}
                  <p className="mt-1 text-micro text-muted">
                    {new Date(event.timestamp).toLocaleString()} · {formatRelativeTime(event.timestamp)}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
      <UndoToastRenderer />
    </PremiumCard>
  );
});
