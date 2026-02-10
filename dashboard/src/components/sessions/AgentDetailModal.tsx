import { useMemo, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { cn } from '@/lib/utils';
import { colors, getAgentRole } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
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

const statusColors: Record<string, string> = {
  running: colors.lime,
  queued: colors.amber,
  pending: colors.amber,
  blocked: colors.red,
  failed: colors.red,
  cancelled: colors.red,
  completed: colors.teal,
  archived: 'rgba(255,255,255,0.5)',
};

function statusColor(status: string): string {
  return statusColors[status] ?? colors.iris;
}

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
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3 sm:px-6">
          <div className="flex items-center gap-1.5 min-w-0 text-[12px] text-white/50">
            <span>Agents</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="flex-shrink-0 text-white/25"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
            <span className="truncate text-white/80 font-medium">{agentName}</span>
            <span className="ml-1 rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] text-white/40">
              agent
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 sm:px-6 space-y-5">
          {/* Agent Info */}
          <div className="flex items-center gap-3">
            <AgentAvatar name={agentName} size="md" hint={agentName} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-semibold text-white truncate">{agentName}</h3>
                <span
                  className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                  style={{
                    borderColor: `${badge.color}55`,
                    color: badge.color,
                    backgroundColor: badge.bg,
                  }}
                >
                  {badge.label}
                </span>
              </div>
              {role && (
                <p className="text-[12px] text-white/45 mt-0.5">{role}</p>
              )}
              {catalogAgent && (
                <div className="flex flex-wrap items-center gap-3 mt-1 text-[11px] text-white/40">
                  {catalogAgent.model && (
                    <span>
                      <span className="text-white/30">Model:</span> {catalogAgent.model}
                    </span>
                  )}
                  {catalogAgent.workspace && (
                    <span>
                      <span className="text-white/30">Workspace:</span> {catalogAgent.workspace}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Session Metrics */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              { label: 'Running', value: sessionMetrics.running, color: colors.lime },
              { label: 'Blocked', value: sessionMetrics.blocked, color: colors.red },
              { label: 'Failed', value: sessionMetrics.failed, color: colors.amber },
              { label: 'Completed', value: sessionMetrics.completed, color: colors.teal },
            ] as const).map((metric) => (
              <div
                key={metric.label}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
              >
                <p className="text-[10px] uppercase tracking-[0.1em] text-white/35">{metric.label}</p>
                <p
                  className="mt-0.5 text-[18px] font-semibold"
                  style={{
                    color: metric.value > 0 ? metric.color : 'rgba(255,255,255,0.3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {metric.value}
                </p>
              </div>
            ))}
          </div>

          {/* Session List */}
          <div>
            <p className="text-[10px] uppercase tracking-[0.1em] text-white/35 mb-2">
              Sessions ({sessions.length})
            </p>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-center text-[12px] text-white/35">
                No sessions recorded for this agent.
              </div>
            ) : (
              <div className="space-y-1.5">
                {visibleSessions.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => {
                      onSelectSession(node.id);
                      onClose();
                    }}
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: statusColor(node.status) }}
                      />
                      <p className="min-w-0 flex-1 truncate text-[12px] text-white/80">{node.title}</p>
                      <span className="text-[10px] text-white/35" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatRelativeTime(node.updatedAt ?? node.lastEventAt ?? node.startedAt ?? Date.now())}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-white/40">
                      <span className="uppercase tracking-[0.08em]">{node.status}</span>
                      {node.progress !== null && (
                        <span>{Math.round(node.progress)}%</span>
                      )}
                    </div>
                  </button>
                ))}

                {hasMoreSessions && (
                  <button
                    type="button"
                    onClick={() => setShowAllSessions((prev) => !prev)}
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[10px] text-white/50 transition-colors hover:bg-white/[0.05]"
                  >
                    {showAllSessions
                      ? 'Show fewer'
                      : `Show ${sortedSessions.length - MAX_SESSIONS} more`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Recent Activity */}
          {recentActivity.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.1em] text-white/35 mb-2">
                Recent Activity ({recentActivity.length})
              </p>
              <div className="space-y-1">
                {recentActivity.map((item, idx) => (
                  <div
                    key={item.id ?? idx}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[11px]"
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: activityTypeColor(item.type) }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-white/70">
                        {item.title ?? item.summary ?? item.description ?? 'Activity'}
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-[10px] text-white/30" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatRelativeTime(item.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Agent Controls */}
          {catalogAgent?.run && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.1em] text-white/35 mb-2">Controls</p>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <p className="text-[11px] text-white/50 mb-2">
                  <span className="text-white/30">Tracked run:</span>{' '}
                  {catalogAgent.run.runId.slice(0, 8)}…{' '}
                  <span className="text-white/35">({catalogAgent.run.status})</span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={stopRun}
                    disabled={!canControlRun || actionLoading}
                    className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-[11px] font-semibold text-rose-100 transition-colors hover:bg-rose-400/20 disabled:opacity-45"
                  >
                    {actionLoading ? 'Stopping…' : 'Stop Run'}
                  </button>
                  <button
                    type="button"
                    onClick={restartRun}
                    disabled={actionLoading}
                    className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-2 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                  >
                    {actionLoading ? 'Restarting…' : 'Restart'}
                  </button>
                </div>
                {actionError && (
                  <p className="mt-2 text-[11px] text-rose-200">{actionError}</p>
                )}
              </div>
            </div>
          )}

          {/* Agent Settings */}
          {catalogAgent && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.1em] text-white/35 mb-2">Settings</p>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-white/40">Provider</span>
                  <span className="text-white/70">
                    {catalogAgent.model?.includes('openrouter')
                      ? 'OpenRouter'
                      : catalogAgent.model?.includes('anthropic')
                        ? 'Anthropic'
                        : catalogAgent.model?.includes('openai')
                          ? 'OpenAI'
                          : 'Auto'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-white/40">Model</span>
                  <span className={cn('truncate max-w-[200px] text-right', catalogAgent.model ? 'text-white/70' : 'text-white/30')}>
                    {catalogAgent.model ?? 'Not configured'}
                  </span>
                </div>
                {catalogAgent.workspace && (
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-white/40">Workspace</span>
                    <span className="truncate max-w-[200px] text-right text-white/70">
                      {catalogAgent.workspace}
                    </span>
                  </div>
                )}
                {catalogAgent.context?.initiativeTitle && (
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-white/40">Initiative</span>
                    <span className="truncate max-w-[200px] text-right text-white/70">
                      {catalogAgent.context.initiativeTitle}
                    </span>
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
