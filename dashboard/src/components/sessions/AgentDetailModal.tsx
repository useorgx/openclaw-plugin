import { useMemo, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { cn } from '@/lib/utils';
import { colors, getAgentRole } from '@/lib/tokens';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/time';
import { statusColor } from '@/lib/entityStatusColors';
import type { OpenClawCatalogAgent } from '@/hooks/useAgentCatalog';
import type { LiveActivityItem, SessionTreeNode } from '@/types';

interface AgentDetailModalProps {
  open: boolean;
  onClose: () => void;
  agentName: string;
  catalogAgent: OpenClawCatalogAgent | null;
  sessions: SessionTreeNode[];
  activity: LiveActivityItem[];
  onSelectSession: (sessionId: string) => void;
  onRefresh?: () => void;
}

const MAX_SESSIONS = 10;
const MAX_ACTIVITY = 20;

function toStatusBadge(status: string | null) {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'active') return { label: 'Active', color: colors.lime, bg: 'rgba(191,255,0,0.12)' };
  if (normalized === 'blocked') return { label: 'Blocked', color: '#fb7185', bg: 'rgba(244, 63, 94, 0.12)' };
  if (normalized === 'idle') return { label: 'Idle', color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.06)' };
  return { label: status ? status : 'Unknown', color: colors.iris, bg: 'rgba(124,124,255,0.10)' };
}

function activityTypeColor(type: string | undefined): string {
  if (!type) return colors.iris;
  if (type.includes('error') || type.includes('fail')) return colors.red;
  if (type.includes('decision') || type.includes('block')) return colors.amber;
  if (type.includes('complete') || type.includes('success')) return colors.teal;
  if (type.includes('start') || type.includes('launch')) return colors.lime;
  return colors.iris;
}

export function AgentDetailModal({
  open,
  onClose,
  agentName,
  catalogAgent,
  sessions,
  activity,
  onSelectSession,
  onRefresh,
}: AgentDetailModalProps) {
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const role = getAgentRole(agentName);
  const badge = toStatusBadge(catalogAgent?.status ?? null);

  const sessionMetrics = useMemo(() => {
    let running = 0;
    let blocked = 0;
    let failed = 0;
    let completed = 0;
    for (const s of sessions) {
      if (s.status === 'running' || s.status === 'queued' || s.status === 'pending') running++;
      else if (s.status === 'blocked') blocked++;
      else if (s.status === 'failed' || s.status === 'cancelled') failed++;
      else if (s.status === 'completed' || s.status === 'archived') completed++;
    }
    return { running, blocked, failed, completed };
  }, [sessions]);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          Date.parse(b.updatedAt ?? b.lastEventAt ?? b.startedAt ?? '') -
          Date.parse(a.updatedAt ?? a.lastEventAt ?? a.startedAt ?? '')
      ),
    [sessions]
  );

  const visibleSessions = showAllSessions
    ? sortedSessions
    : sortedSessions.slice(0, MAX_SESSIONS);
  const hasMoreSessions = sortedSessions.length > MAX_SESSIONS;

  const recentActivity = useMemo(
    () =>
      [...activity]
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, MAX_ACTIVITY),
    [activity]
  );

  const canControlRun = Boolean(catalogAgent?.run?.runId) && Boolean(catalogAgent?.run?.pid);

  const stopRun = async () => {
    if (!catalogAgent?.run?.runId || !canControlRun || actionLoading) return;
    setActionError(null);
    setActionLoading(true);
    try {
      const res = await fetch(
        `/orgx/api/agents/stop?runId=${encodeURIComponent(catalogAgent.run.runId)}`,
        { method: 'POST' }
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Stop failed (${res.status})`);
      }
      onRefresh?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setActionLoading(false);
    }
  };

  const restartRun = async () => {
    if (!catalogAgent?.run?.runId || actionLoading) return;
    setActionError(null);
    setActionLoading(true);
    try {
      const query = new URLSearchParams();
      query.set('runId', catalogAgent.run.runId);
      const res = await fetch(`/orgx/api/agents/restart?${query.toString()}`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Restart failed (${res.status})`);
      }
      onRefresh?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex h-full min-h-0 w-full flex-col">
          {/* Header with breadcrumb */}
        <div className="flex items-center justify-between gap-3 px-8 pt-6 pb-2">
          <div className="flex items-center gap-2 min-w-0 text-[13px] text-secondary">
            <span>Agents</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="flex-shrink-0 opacity-40"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            <span className="truncate text-white font-medium">{agentName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6 space-y-8">
          {/* Agent Info */}
          <div className="flex items-start gap-5">
            <AgentAvatar name={agentName} size="lg" hint={agentName} />
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-3">
                <h3 className="text-[28px] font-medium leading-none text-white truncate">{agentName}</h3>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
                  style={{
                    color: badge.color,
                    backgroundColor: badge.bg,
                  }}
                >
                  {badge.label}
                </span>
              </div>
              {role && (
                <p className="text-[15px] text-secondary mt-2">{role}</p>
              )}
            </div>
          </div>

          {/* Session Metrics */}
          <div className="flex items-center gap-12 pt-2 pb-6 border-b border-white/[0.04]">
            {([
              { label: 'Running', value: sessionMetrics.running, color: colors.lime },
              { label: 'Blocked', value: sessionMetrics.blocked, color: colors.red },
              { label: 'Failed', value: sessionMetrics.failed, color: colors.amber },
              { label: 'Completed', value: sessionMetrics.completed, color: colors.teal },
            ] as const).map((metric) => (
              <div key={metric.label}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">{metric.label}</p>
                <p
                  className="mt-1 text-2xl font-light"
                  style={{
                    color: metric.value > 0 ? metric.color : 'rgba(255,255,255,0.2)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {metric.value}
                </p>
              </div>
            ))}
          </div>

          {/* Timeline: Sessions & Activity */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-4">
            {/* Sessions Column */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted mb-6">
                Sessions
              </p>
              {sessions.length === 0 ? (
                <p className="text-body text-muted italic">No sessions recorded.</p>
              ) : (
                <div className="relative border-l border-white/[0.06] pl-6 ml-2 space-y-6">
                  {visibleSessions.map((node) => (
                    <div key={node.id} className="relative group">
                      {/* Timeline node */}
                      <div 
                        className="absolute -left-[29px] top-1.5 h-2 w-2 rounded-full border border-black ring-4 ring-black"
                        style={{ backgroundColor: statusColor(node.status) }}
                      />
                      
                      <button
                        onClick={() => {
                          onSelectSession(node.id);
                          onClose();
                        }}
                        className="w-full text-left focus:outline-none group-hover:bg-white/[0.02] -mx-3 px-3 py-2 rounded-lg transition-colors"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <p className="truncate text-[14px] font-medium text-white transition-colors group-hover:text-lime">
                            {node.title}
                          </p>
                          <span className="flex-shrink-0 text-[12px] text-muted tabular-nums">
                            {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[12px] text-secondary">
                          <span className="capitalize">{node.status}</span>
                          {node.progress !== null && (
                            <>
                              <span className="text-white/[0.15]">·</span>
                              <span>{Math.round(node.progress)}%</span>
                            </>
                          )}
                        </div>
                      </button>
                    </div>
                  ))}

                  {hasMoreSessions && (
                    <button
                      type="button"
                      onClick={() => setShowAllSessions((prev) => !prev)}
                      className="text-[12px] font-medium text-secondary hover:text-white transition-colors focus:outline-none"
                    >
                      {showAllSessions ? 'Collapse timeline' : `View ${sortedSessions.length - MAX_SESSIONS} older sessions`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Activity Column */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted mb-6">
                Live Activity
              </p>
              {recentActivity.length === 0 ? (
                <p className="text-body text-muted italic">No recent activity.</p>
              ) : (
                <div className="relative border-l border-white/[0.06] pl-6 ml-2 space-y-5">
                  {recentActivity.map((item, idx) => (
                    <div key={item.id ?? idx} className="relative group">
                      <div 
                        className="absolute -left-[27px] top-1.5 h-1.5 w-1.5 rounded-full ring-4 ring-black"
                        style={{ backgroundColor: activityTypeColor(item.type) }}
                      />
                      <div className="flex items-start justify-between gap-4 py-0.5">
                        <p className="text-[13px] leading-relaxed text-secondary group-hover:text-white transition-colors line-clamp-2">
                          {item.title ?? item.summary ?? item.description ?? 'Activity'}
                        </p>
                        <span className="flex-shrink-0 text-[11px] text-muted tabular-nums mt-0.5">
                          {formatRelativeTime(item.timestamp)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Agent Controls */}
          {catalogAgent?.run && (
            <div className="pt-4 border-t border-white/[0.04]">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted mb-4">Controls</p>
              <div className="flex flex-wrap items-center gap-6">
                <p className="text-[13px] text-secondary">
                  <span className="text-muted mr-2">Tracked run:</span>
                  {catalogAgent.run.runId.slice(0, 8)}…
                  <span className="text-muted ml-2">({catalogAgent.run.status})</span>
                </p>
                <div className="flex items-center gap-3 ml-auto">
                  <button
                    type="button"
                    onClick={stopRun}
                    disabled={!canControlRun || actionLoading}
                    className="rounded-lg px-4 py-2 text-[13px] font-medium text-rose-400 transition-colors hover:text-rose-300 hover:bg-rose-400/10 disabled:opacity-40 focus:outline-none"
                  >
                    {actionLoading ? 'Stopping…' : 'Stop Run'}
                  </button>
                  <button
                    type="button"
                    onClick={restartRun}
                    disabled={actionLoading}
                    className="rounded-lg px-4 py-2 text-[13px] font-medium text-white bg-white/[0.06] transition-colors hover:bg-white/[0.12] disabled:opacity-40 focus:outline-none"
                  >
                    {actionLoading ? 'Restarting…' : 'Restart'}
                  </button>
                </div>
                {actionError && (
                  <p className="w-full text-caption text-rose-400">{actionError}</p>
                )}
              </div>
            </div>
          )}

          {/* Agent Settings */}
          {catalogAgent && (
            <div className="pt-4 border-t border-white/[0.04]">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted mb-4">Settings</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
                <div>
                  <p className="text-[11px] text-muted mb-1">Provider</p>
                  <p className="text-[14px] text-primary">
                    {catalogAgent.model?.includes('openrouter')
                      ? 'OpenRouter'
                      : catalogAgent.model?.includes('anthropic')
                        ? 'Anthropic'
                        : catalogAgent.model?.includes('openai')
                          ? 'OpenAI'
                          : 'Auto'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted mb-1">Model</p>
                  <p className={cn('text-[14px] truncate', catalogAgent.model ? 'text-primary' : 'text-muted')}>
                    {catalogAgent.model ?? 'Not configured'}
                  </p>
                </div>
                {catalogAgent.workspace && (
                  <div>
                    <p className="text-[11px] text-muted mb-1">Workspace</p>
                    <p className="text-[14px] text-primary truncate">
                      {catalogAgent.workspace}
                    </p>
                  </div>
                )}
                {catalogAgent.context?.initiativeTitle && (
                  <div>
                    <p className="text-[11px] text-muted mb-1">Initiative</p>
                    <p className="text-[14px] text-primary truncate">
                      {catalogAgent.context.initiativeTitle}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
