import { memo, useMemo, useState } from 'react';
import type { SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { formatRelativeTime } from '@/lib/time';
import { normalizeStatus } from '@/lib/tokens';

const IN_PROGRESS_STATUSES = new Set([
  'running',
  'active',
  'in_progress',
  'working',
  'planning',
  'dispatching',
]);

const LIVE_HEARTBEAT_WINDOW_MS = 3 * 60_000;

function isFreshHeartbeat(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= LIVE_HEARTBEAT_WINDOW_MS;
}

function isInProgress(session: SessionTreeNode): boolean {
  const status = normalizeStatus(session.status ?? '');
  const runtimeState = normalizeStatus(session.state ?? '');
  if (runtimeState === 'stale' || status === 'stale') return false;
  if (runtimeState === 'stopped' && status !== 'blocked') return false;
  if (IN_PROGRESS_STATUSES.has(status)) return true;
  if (status === 'queued' || status === 'pending' || status === 'paused' || status === 'completed') return false;
  // Fallback: treat non-terminal sessions as in-progress only if heartbeat is recent.
  if (session.lastHeartbeatAt) return isFreshHeartbeat(session.lastHeartbeatAt);
  return false;
}

/** Display label for a normalized status key. */
function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function coerceProgress(progress: number | null | undefined): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

interface InProgressPanelProps {
  sessions: SessionTreeNode[];
  title?: string;
  className?: string;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  onOpenSession?: (sessionId: string) => void;
  onFocusRunId?: (runId: string) => void;
  onPlayWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onPauseWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onResumeWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onRestartSession?: (session: SessionTreeNode) => Promise<void> | void;
  onIntervene?: (session: SessionTreeNode) => Promise<void> | void;
}

export const InProgressPanel = memo(function InProgressPanel({
  sessions,
  title = 'In Progress',
  className,
  showHeader = true,
  panelStyle = 'card',
  onOpenSession,
  onFocusRunId,
  onPlayWorkstream,
  onPauseWorkstream,
  onResumeWorkstream,
  onRestartSession,
  onIntervene,
}: InProgressPanelProps) {
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inProgress = useMemo(() => {
    const rows = sessions.filter(isInProgress);
    rows.sort((a, b) => {
      const aEpoch = Date.parse(a.updatedAt ?? a.lastEventAt ?? a.startedAt ?? '');
      const bEpoch = Date.parse(b.updatedAt ?? b.lastEventAt ?? b.startedAt ?? '');
      const safeA = Number.isFinite(aEpoch) ? aEpoch : 0;
      const safeB = Number.isFinite(bEpoch) ? bEpoch : 0;
      return safeB - safeA;
    });
    const deduped: SessionTreeNode[] = [];
    const seen = new Set<string>();
    for (const session of rows) {
      const dedupeKey =
        session.workstreamId && session.workstreamId.trim().length > 0
          ? `${session.initiativeId ?? 'none'}:${session.workstreamId}`
          : session.runId;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      deduped.push(session);
    }
    return deduped;
  }, [sessions]);

  /** Distinct statuses present in the current list, sorted by count desc. */
  const statusOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of inProgress) {
      const s = normalizeStatus(session.status ?? '');
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }));
  }, [inProgress]);

  const filtered = useMemo(() => {
    if (!activeFilter) return inProgress;
    return inProgress.filter(
      (session) => normalizeStatus(session.status ?? '') === activeFilter,
    );
  }, [inProgress, activeFilter]);

  const runWorkstreamAction = async (
    session: SessionTreeNode,
    action: (session: SessionTreeNode) => Promise<void> | void,
    successMessage: string
  ) => {
    setNotice(null);
    setBusySessionId(session.id);
    try {
      await action(session);
      setNotice(successMessage);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Workstream action failed');
    } finally {
      setBusySessionId(null);
    }
  };

  return (
    <PremiumCard
      surface={panelStyle === 'card'}
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        panelStyle === 'flat' ? '!rounded-none !border-none !bg-transparent !shadow-none' : ''
      } ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip text-micro">{inProgress.length}</span>
          </div>
        </div>
      ) : null}

      {statusOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-subtle px-3 py-2">
          <button
            type="button"
            onClick={() => setActiveFilter(null)}
            className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-micro font-semibold transition-colors ${
              activeFilter === null
                ? 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]'
                : 'border-strong bg-white/[0.04] text-secondary hover:bg-white/[0.08]'
            }`}
          >
            All
            <span className="tabular-nums opacity-70">{inProgress.length}</span>
          </button>
          {statusOptions.map(({ status, count }) => (
            <button
              key={status}
              type="button"
              onClick={() =>
                setActiveFilter((prev) => (prev === status ? null : status))
              }
              className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-micro font-semibold capitalize transition-colors ${
                activeFilter === status
                  ? 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]'
                  : 'border-strong bg-white/[0.04] text-secondary hover:bg-white/[0.08]'
              }`}
            >
              {statusLabel(status)}
              <span className="tabular-nums opacity-70">{count}</span>
            </button>
          ))}
        </div>
      )}

      {notice && (
        <div className="border-b border-subtle px-3 py-2 text-caption text-secondary">
          {notice}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="px-4 py-4 text-body text-secondary">
          {inProgress.length === 0
            ? 'No runs in progress.'
            : 'No runs match this filter.'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-2">
            {filtered.map((session) => {
              const status = normalizeStatus(session.status ?? '');
              const when = session.lastEventAt ?? session.updatedAt ?? session.startedAt ?? null;
              const subtitle = session.lastEventSummary?.trim()
                ? session.lastEventSummary.trim()
                : when
                  ? `Updated ${formatRelativeTime(when)}`
                  : null;
              const progressValue = coerceProgress(session.progress);
              const canPauseAction = [
                'running',
                'active',
                'in_progress',
                'working',
                'planning',
                'dispatching',
              ].includes(status);
              const canResumeAction = ['paused', 'blocked', 'queued', 'pending'].includes(status);
              const restartHandler = onRestartSession ?? onPlayWorkstream;
              const showEstimatedProgress =
                progressValue === null &&
                ['running', 'active', 'in_progress', 'working', 'planning', 'dispatching'].includes(
                  status
                );

              return (
                <div
                  key={session.id}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <AgentAvatar
                      name={session.agentName ?? 'OrgX'}
                      hint={session.agentId ?? session.runId}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start gap-1.5">
                        <EntityIcon type="session" size={12} className="mt-[3px] flex-shrink-0 opacity-80" />
                        <p className="min-w-0 line-clamp-2 text-body font-semibold leading-snug text-white" title={session.title}>
                          {session.title}
                        </p>
                        <span className="ml-auto flex-shrink-0 rounded-full border border-white/[0.10] bg-white/[0.03] px-2 py-[1px] text-micro font-semibold uppercase tracking-[0.08em] text-secondary">
                          {statusLabel(status)}
                        </span>
                      </div>
                      {subtitle ? (
                        <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={subtitle}>
                          {subtitle}
                        </p>
                      ) : null}
                      {(progressValue !== null || showEstimatedProgress) && (
                        <div className="mt-2">
                          <div className="mb-1 flex items-center justify-between text-micro">
                            <span className="text-secondary">Progress</span>
                            <span className="font-semibold text-primary tabular-nums">
                              {progressValue === null ? 'Tracking…' : `${progressValue}%`}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.09]">
                            {progressValue === null ? (
                              <div className="h-full w-1/3 rounded-full bg-[#7dd3c0]/70 animate-pulse" />
                            ) : (
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-[#BFFF00]/80 to-[#7dd3c0]"
                                style={{ width: `${Math.max(3, progressValue)}%` }}
                              />
                            )}
                          </div>
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenSession?.(session.id)}
                          className="control-pill h-7 px-2.5 text-micro font-semibold"
                          title="Open session"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => onFocusRunId?.(session.runId)}
                          className="control-pill h-7 px-2.5 text-micro font-semibold"
                          title="Focus in Activity"
                        >
                          Focus
                        </button>
                        {canPauseAction && onPauseWorkstream && session.initiativeId && session.workstreamId && (
                          <button
                            type="button"
                            disabled={busySessionId === session.id}
                            onClick={() =>
                              void runWorkstreamAction(
                                session,
                                onPauseWorkstream,
                                `Paused ${session.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Pause and return this workstream to queue"
                          >
                            Pause
                          </button>
                        )}
                        {canResumeAction && onResumeWorkstream && session.initiativeId && session.workstreamId && (
                          <button
                            type="button"
                            disabled={busySessionId === session.id}
                            onClick={() =>
                              void runWorkstreamAction(
                                session,
                                onResumeWorkstream,
                                `Resumed ${session.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Resume this workstream"
                          >
                            Resume
                          </button>
                        )}
                        {restartHandler && session.initiativeId && session.workstreamId && (
                          <button
                            type="button"
                            disabled={busySessionId === session.id}
                            onClick={() =>
                              void runWorkstreamAction(
                                session,
                                restartHandler,
                                `Restarted ${session.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Restart this workstream"
                          >
                            Restart
                          </button>
                        )}
                        {onIntervene && (
                          <button
                            type="button"
                            disabled={busySessionId === session.id}
                            onClick={() =>
                              void runWorkstreamAction(
                                session,
                                onIntervene,
                                `Opened intervention for ${session.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Intervene with context and guidance"
                          >
                            Intervene
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PremiumCard>
  );
});
