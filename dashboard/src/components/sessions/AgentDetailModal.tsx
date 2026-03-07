import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Modal } from '@/components/shared/Modal';
import { ModalShell } from '@/components/shared/ModalShell';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { AgentHealthRing } from '@/components/agents/AgentHealthRing';
import { cn } from '@/lib/utils';
import { colors, getAgentColor, getAgentRole } from '@/lib/tokens';
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

const heroVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] },
  }),
};

const sectionVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.22, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] },
  }),
};

function SectionDivider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />;
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
  const agentColor = getAgentColor(agentName);

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

  const footerContent = catalogAgent?.run ? (
    <div className="flex items-center justify-between gap-3">
      <p className="text-caption text-secondary">
        Run {catalogAgent.run.runId.slice(0, 8)}&hellip;
        <span className="text-muted ml-1">({catalogAgent.run.status})</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={stopRun}
          disabled={!canControlRun || actionLoading}
          className="rounded-md px-2.5 py-1.5 text-caption font-medium text-red-400/70 hover:bg-red-500/[0.08] hover:text-red-300 disabled:opacity-40 transition-colors"
        >
          {actionLoading ? 'Stopping\u2026' : 'Stop'}
        </button>
        <button
          type="button"
          onClick={restartRun}
          disabled={actionLoading}
          className="h-8 rounded-lg border border-lime/25 bg-lime/10 px-4 text-caption font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-40"
        >
          {actionLoading ? 'Restarting\u2026' : 'Restart'}
        </button>
      </div>
    </div>
  ) : undefined;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      {/* Accent bar */}
      <div className="h-[2px] rounded-t-xl" style={{ background: `linear-gradient(90deg, ${agentColor}, transparent)` }} />

      <ModalShell
        breadcrumbs={[{ label: 'Agents' }, { label: agentName }]}
        onClose={onClose}
        footer={footerContent}
      >
        <div className="px-8 py-6 space-y-8">
          {/* Hero */}
          <motion.div
            className="flex items-start gap-5"
            variants={heroVariants}
            initial="hidden"
            animate="visible"
            custom={0}
          >
            <AgentHealthRing
              running={sessionMetrics.running}
              blocked={sessionMetrics.blocked + sessionMetrics.failed}
              paused={0}
              size={72}
            >
              <AgentAvatar name={agentName} size="lg" hint={agentName} />
            </AgentHealthRing>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-3">
                <h3 className="text-display font-medium leading-none text-white truncate">{agentName}</h3>
                <span
                  className="status-pill"
                  style={{
                    color: badge.color,
                    backgroundColor: badge.bg,
                    borderColor: `${badge.color}30`,
                  }}
                >
                  {badge.label}
                </span>
              </div>
              {role && (
                <p className="text-micro uppercase tracking-[0.12em] text-muted mt-2">{role}</p>
              )}
            </div>
          </motion.div>

          {/* Session Metrics */}
          <motion.div
            className="flex items-center gap-12 pt-2 pb-6 border-b border-white/[0.04]"
            variants={sectionVariants}
            initial="hidden"
            animate="visible"
            custom={1}
          >
            {([
              { label: 'Running', value: sessionMetrics.running, color: colors.lime },
              { label: 'Blocked', value: sessionMetrics.blocked, color: colors.red },
              { label: 'Failed', value: sessionMetrics.failed, color: colors.amber },
              { label: 'Completed', value: sessionMetrics.completed, color: colors.teal },
            ] as const).map((metric) => (
              <div key={metric.label}>
                <p className="section-kicker">{metric.label}</p>
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
          </motion.div>

          {/* Timeline: Sessions & Activity */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-4">
            {/* Sessions Column */}
            <motion.div
              variants={sectionVariants}
              initial="hidden"
              animate="visible"
              custom={2}
            >
              <p className="section-kicker mb-6">Sessions</p>
              {sessions.length === 0 ? (
                <p className="text-body text-muted italic">No sessions recorded.</p>
              ) : (
                <div className="relative border-l border-white/[0.06] pl-6 ml-2 space-y-6">
                  {visibleSessions.map((node) => (
                    <div key={node.id} className="relative group">
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
                              <span className="text-white/[0.15]">&middot;</span>
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
            </motion.div>

            {/* Activity Column */}
            <motion.div
              variants={sectionVariants}
              initial="hidden"
              animate="visible"
              custom={3}
            >
              <p className="section-kicker mb-6">Live Activity</p>
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
            </motion.div>
          </div>

          <SectionDivider />

          {/* Agent Settings */}
          {catalogAgent && (
            <motion.div
              variants={sectionVariants}
              initial="hidden"
              animate="visible"
              custom={4}
            >
              <p className="section-kicker mb-4">Configuration</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
                <div>
                  <p className="text-micro text-muted mb-1">Provider</p>
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
                  <p className="text-micro text-muted mb-1">Model</p>
                  <p className={cn('text-[14px] truncate', catalogAgent.model ? 'text-primary' : 'text-muted')}>
                    {catalogAgent.model ?? 'Not configured'}
                  </p>
                </div>
                {catalogAgent.workspace && (
                  <div>
                    <p className="text-micro text-muted mb-1">Workspace</p>
                    <p className="text-[14px] text-primary truncate">
                      {catalogAgent.workspace}
                    </p>
                  </div>
                )}
                {catalogAgent.context?.initiativeTitle && (
                  <div>
                    <p className="text-micro text-muted mb-1">Initiative</p>
                    <p className="text-[14px] text-primary truncate">
                      {catalogAgent.context.initiativeTitle}
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {actionError && (
            <p className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-caption text-red-200">
              {actionError}
            </p>
          )}
        </div>
      </ModalShell>
    </Modal>
  );
}
