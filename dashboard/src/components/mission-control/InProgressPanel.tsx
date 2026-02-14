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

/** Display label for a normalized status key. */
function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
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
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

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

  return (
    <PremiumCard className={`flex h-full min-h-0 flex-col overflow-hidden ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
          <span className="chip text-micro">{inProgress.length}</span>
        </div>
      </div>

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
