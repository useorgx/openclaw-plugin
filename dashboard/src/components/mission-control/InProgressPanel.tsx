import { memo, useMemo } from 'react';
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
  'blocked',
]);

function isInProgress(session: SessionTreeNode): boolean {
  const status = normalizeStatus(session.status ?? '');
  if (IN_PROGRESS_STATUSES.has(status)) return true;
  if (status === 'queued' || status === 'pending') return false;
  // Fallback: treat any non-terminal status with a heartbeat as in-progress.
  if (session.lastHeartbeatAt) return true;
  return false;
}

interface InProgressPanelProps {
  sessions: SessionTreeNode[];
  title?: string;
  className?: string;
  onOpenSession?: (sessionId: string) => void;
  onFocusRunId?: (runId: string) => void;
}

export const InProgressPanel = memo(function InProgressPanel({
  sessions,
  title = 'In Progress',
  className,
  onOpenSession,
  onFocusRunId,
}: InProgressPanelProps) {
  const inProgress = useMemo(() => {
    const rows = sessions.filter(isInProgress);
    rows.sort((a, b) => {
      const aEpoch = Date.parse(a.updatedAt ?? a.lastEventAt ?? a.startedAt ?? '');
      const bEpoch = Date.parse(b.updatedAt ?? b.lastEventAt ?? b.startedAt ?? '');
      const safeA = Number.isFinite(aEpoch) ? aEpoch : 0;
      const safeB = Number.isFinite(bEpoch) ? bEpoch : 0;
      return safeB - safeA;
    });
    return rows;
  }, [sessions]);

  return (
    <PremiumCard className={`flex h-full min-h-0 flex-col overflow-hidden ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
          <span className="chip text-micro">{inProgress.length}</span>
        </div>
      </div>

      {inProgress.length === 0 ? (
        <div className="px-4 py-4 text-body text-secondary">No runs in progress.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-2">
            {inProgress.map((session) => {
              const status = normalizeStatus(session.status ?? '');
              const when = session.lastEventAt ?? session.updatedAt ?? session.startedAt ?? null;
              const subtitle = session.lastEventSummary?.trim()
                ? session.lastEventSummary.trim()
                : when
                  ? `Updated ${formatRelativeTime(when)}`
                  : null;

              return (
                <div
                  key={session.id}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <AgentAvatar
                        name={session.agentName ?? 'OrgX'}
                        hint={session.agentId ?? session.runId}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <EntityIcon type="session" size={12} className="flex-shrink-0 opacity-80" />
                          <p className="truncate text-body font-semibold leading-snug text-white" title={session.title}>
                            {session.title}
                          </p>
                        </div>
                        {subtitle ? (
                          <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={subtitle}>
                            {subtitle}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-shrink-0 flex-col items-end gap-2">
                      <span className="rounded-full border border-white/[0.10] bg-white/[0.03] px-2 py-[1px] text-micro font-semibold uppercase tracking-[0.08em] text-secondary">
                        {status.replace(/_/g, ' ')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenSession?.(session.id)}
                          className="control-pill h-8 px-3 text-caption font-semibold"
                          title="Open session"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => onFocusRunId?.(session.runId)}
                          className="control-pill h-8 px-3 text-caption font-semibold"
                          title="Focus in Activity"
                        >
                          Focus
                        </button>
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
