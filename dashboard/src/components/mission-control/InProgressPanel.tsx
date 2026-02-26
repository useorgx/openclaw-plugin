import { memo, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { Initiative, SessionTreeNode, SliceRunProjection, SliceScope } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Pill } from '@/components/shared/Pill';
import { ScopeProgressCard, buildScopeFromSliceRun } from '@/components/shared/ScopeProgressCard';
import { getAgentPersonality, inferAgentDomain } from '@/lib/agentPersonality';
import { humanizeId, humanizeWarning, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
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
const SLICE_RUNNING_STATUSES = new Set(['running', 'dispatching']);
const LIVE_HEARTBEAT_WINDOW_MS = 3 * 60_000;

function isFreshHeartbeat(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= LIVE_HEARTBEAT_WINDOW_MS;
}

export function isInProgressSession(session: SessionTreeNode): boolean {
  const status = normalizeStatus(session.status ?? '');
  const runtimeState = normalizeStatus(session.state ?? '');
  if (runtimeState === 'stale' || status === 'stale') return false;
  if (runtimeState === 'stopped' && status !== 'blocked') return false;
  if (IN_PROGRESS_STATUSES.has(status)) return true;
  if (status === 'queued' || status === 'pending' || status === 'paused' || status === 'completed') return false;
  if (session.lastHeartbeatAt) return isFreshHeartbeat(session.lastHeartbeatAt);
  return false;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function statusTone(status: string): string {
  const normalized = normalizeStatus(status);
  if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress' || normalized === 'working' || normalized === 'dispatching') {
    return 'border-teal-300/28 bg-teal-400/[0.10] text-teal-100';
  }
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'border-red-400/26 bg-red-500/[0.10] text-red-100';
  }
  if (normalized === 'paused' || normalized === 'pending' || normalized === 'queued') {
    return 'border-amber-300/28 bg-amber-300/[0.10] text-amber-100';
  }
  return 'border-[#BFFF00]/24 bg-[#BFFF00]/[0.10] text-[#E8FFD0]';
}

function statusHighlight(status: string): string {
  const normalized = normalizeStatus(status);
  if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress' || normalized === 'working' || normalized === 'dispatching') {
    return 'from-teal-300/0 via-teal-300/65 to-teal-300/0';
  }
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'from-red-300/0 via-red-300/65 to-red-300/0';
  }
  if (normalized === 'paused' || normalized === 'pending' || normalized === 'queued') {
    return 'from-amber-300/0 via-amber-300/65 to-amber-300/0';
  }
  return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
}

function coerceProgress(progress: number | null | undefined): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLineageIds(values: string[] | undefined, fallback?: string | null): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
    out.push(trimmed);
  };
  if (Array.isArray(values)) {
    for (const value of values) push(value);
  }
  push(fallback ?? null);
  return out;
}

function compactOpaqueLabel(value: string | null | undefined, prefix: string): string {
  if (!value) return prefix;
  const trimmed = value.trim();
  if (!trimmed) return prefix;
  return isOpaqueId(trimmed) ? `${prefix} ${humanizeId(trimmed)}` : trimmed;
}

export type InProgressRow = {
  key: string;
  source: 'slice' | 'session';
  session: SessionTreeNode | null;
  runId: string;
  status: string;
  title: string;
  subtitle: string | null;
  progress: number | null;
  initiativeId: string | null;
  initiativeIds?: string[];
  initiativeTitle: string | null;
  workstreamId: string | null;
  workstreamIds?: string[];
  iwmtId?: string | null;
  iwmtIds?: string[];
  workstreamTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  artifactCount: number;
  decisionCount: number;
  updatedAt: string | null;
  scope?: 'task' | 'milestone' | 'workstream';
  milestoneProgress?: Array<{ id: string; title: string; total: number; done: number }>;
};

interface SelectInProgressRowsInput {
  sessions: SessionTreeNode[];
  sliceRuns?: SliceRunProjection[];
  initiatives?: Initiative[];
}

export function selectInProgressRows({
  sessions,
  sliceRuns = [],
  initiatives = [],
}: SelectInProgressRowsInput): InProgressRow[] {
  const initiativeNameById = new Map<string, string>();
  for (const item of initiatives) {
    if (!item.id) continue;
    initiativeNameById.set(item.id, item.name ?? item.id);
  }

  const sessionByRunId = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    const runId = session.runId?.trim();
    if (!runId || sessionByRunId.has(runId)) continue;
    sessionByRunId.set(runId, session);
  }

  const sessionByScope = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    const initiativeId = session.initiativeId?.trim() ?? '';
    const workstreamId = session.workstreamId?.trim() ?? '';
    if (!initiativeId || !workstreamId) continue;
    const key = `${initiativeId}:${workstreamId}`;
    if (!sessionByScope.has(key)) {
      sessionByScope.set(key, session);
    }
  }

  const sessionRunIdsInScope = new Set<string>();
  for (const session of sessions) {
    const runId = session.runId?.trim();
    if (runId) sessionRunIdsInScope.add(runId);
  }

  const runningSliceRows: InProgressRow[] = [];
  for (const slice of sliceRuns) {
    if (!SLICE_RUNNING_STATUSES.has(slice.status)) continue;
    const runId = (slice.runId ?? slice.sliceRunId ?? '').trim();
    if (!runId) continue;
    const initiativeIds = normalizeLineageIds(slice.initiativeIds, slice.initiativeId);
    const workstreamIds = normalizeLineageIds(slice.workstreamIds, slice.workstreamId);
    const primaryInitiativeId = initiativeIds[0] ?? null;
    const primaryWorkstreamId = workstreamIds[0] ?? null;
    const scopeKeys: string[] = [];
    for (const iId of initiativeIds) {
      for (const wId of workstreamIds) {
        if (!iId || !wId) continue;
        scopeKeys.push(`${iId}:${wId}`);
      }
    }

    const inScopedSessions =
      sessionRunIdsInScope.has(runId) || scopeKeys.some((key) => sessionByScope.has(key));
    if (!inScopedSessions) continue;

    const linkedSession =
      sessionByRunId.get(runId) ??
      (scopeKeys.length > 0
        ? scopeKeys
            .map((key) => sessionByScope.get(key) ?? null)
            .find((session): session is SessionTreeNode => Boolean(session)) ?? null
        : null);
    const initiativeTitle = primaryInitiativeId
      ? initiativeNameById.get(primaryInitiativeId) ?? primaryInitiativeId
      : null;

    const sliceProgress =
      slice.scopeProgress &&
      typeof slice.scopeProgress.totalTasks === 'number' &&
      slice.scopeProgress.totalTasks > 0
        ? Math.round(
            (slice.scopeProgress.completedTasks / slice.scopeProgress.totalTasks) * 100
          )
        : null;

    runningSliceRows.push({
      key: `slice:${slice.sliceRunId}`,
      source: 'slice',
      session: linkedSession ?? null,
      runId,
      status: normalizeStatus(slice.status),
      title: slice.workstreamTitle ?? linkedSession?.title ?? `Work slice ${slice.sliceRunId.slice(0, 8)}`,
      subtitle: slice.statusExplainer ?? slice.lastEventSummary ?? linkedSession?.lastEventSummary ?? null,
      progress: sliceProgress ?? linkedSession?.progress ?? null,
      initiativeId: primaryInitiativeId,
      initiativeIds,
      initiativeTitle,
      workstreamId: primaryWorkstreamId,
      workstreamIds,
      iwmtId: slice.iwmtId ?? null,
      iwmtIds: normalizeLineageIds(slice.iwmtIds, slice.iwmtId),
      workstreamTitle: slice.workstreamTitle ?? linkedSession?.title ?? null,
      taskIds: Array.isArray(slice.taskIds) ? slice.taskIds : [],
      milestoneIds: Array.isArray(slice.milestoneIds) ? slice.milestoneIds : [],
      artifactCount: slice.artifactCount ?? 0,
      decisionCount: slice.blockingDecisionCount ?? slice.decisionCount ?? 0,
      updatedAt: slice.updatedAt ?? slice.lastEventAt ?? linkedSession?.updatedAt ?? null,
      scope: slice.scope,
      milestoneProgress: slice.scopeProgress?.milestones,
    });
  }

  runningSliceRows.sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt));
  if (runningSliceRows.length > 0) return runningSliceRows;

  const fallbackSessions = sessions.filter(isInProgressSession);
  fallbackSessions.sort((a, b) => {
    const safeA = toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt);
    const safeB = toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt);
    return safeB - safeA;
  });

  const deduped: SessionTreeNode[] = [];
  const seen = new Set<string>();
  for (const session of fallbackSessions) {
    const dedupeKey =
      session.workstreamId && session.workstreamId.trim().length > 0
        ? `${session.initiativeId ?? 'none'}:${session.workstreamId}`
        : session.runId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(session);
  }

  return deduped.map((session) => ({
    key: `session:${session.id}`,
    source: 'session',
    session,
    runId: session.runId,
    status: normalizeStatus(session.status ?? ''),
    title: session.title,
    subtitle: session.lastEventSummary?.trim() ? session.lastEventSummary.trim() : null,
    progress: session.progress,
    initiativeId: session.initiativeId,
    initiativeIds: normalizeLineageIds(undefined, session.initiativeId),
    initiativeTitle: session.initiativeId
      ? initiativeNameById.get(session.initiativeId) ?? session.groupLabel ?? null
      : session.groupLabel ?? null,
    workstreamId: session.workstreamId,
    workstreamIds: normalizeLineageIds(undefined, session.workstreamId),
    iwmtId: null,
    iwmtIds: [],
    workstreamTitle: session.title,
    taskIds: [],
    milestoneIds: [],
    artifactCount: 0,
    decisionCount: 0,
    updatedAt: session.updatedAt ?? session.lastEventAt ?? session.startedAt ?? null,
  }));
}

interface InProgressPanelProps {
  sessions: SessionTreeNode[];
  sliceRuns?: SliceRunProjection[];
  initiatives?: Initiative[];
  title?: string;
  className?: string;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  needsAttentionCount?: number;
  onSwitchToNeedsAttention?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onFocusRunId?: (runId: string) => void;
  onPlayWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onPauseWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onResumeWorkstream?: (session: SessionTreeNode) => Promise<void> | void;
  onRestartSession?: (session: SessionTreeNode) => Promise<void> | void;
  onIntervene?: (session: SessionTreeNode) => Promise<void> | void;
  onOpenSliceDetail?: (row: InProgressRow, sliceRun: SliceRunProjection | null) => void;
}

export const InProgressPanel = memo(function InProgressPanel({
  sessions,
  sliceRuns = [],
  initiatives = [],
  title = 'In Progress',
  className,
  showHeader = true,
  panelStyle = 'card',
  needsAttentionCount = 0,
  onSwitchToNeedsAttention,
  onOpenSession,
  onFocusRunId,
  onPlayWorkstream,
  onPauseWorkstream,
  onResumeWorkstream,
  onRestartSession,
  onIntervene,
  onOpenSliceDetail,
}: InProgressPanelProps) {
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sliceRunByScope = useMemo(() => {
    const map = new Map<string, SliceRunProjection>();
    if (!Array.isArray(sliceRuns)) return map;
    for (const slice of sliceRuns) {
      const initiativeIds = normalizeLineageIds(slice.initiativeIds, slice.initiativeId);
      const workstreamIds = normalizeLineageIds(slice.workstreamIds, slice.workstreamId);
      for (const iId of initiativeIds) {
        for (const wId of workstreamIds) {
          if (!iId || !wId) continue;
          const key = `${iId}:${wId}`;
          if (!map.has(key)) map.set(key, slice);
        }
      }
      const runId = (slice.runId ?? slice.sliceRunId ?? '').trim();
      if (runId && !map.has(`run:${runId}`)) map.set(`run:${runId}`, slice);
    }
    return map;
  }, [sliceRuns]);

  const rows = useMemo(
    () =>
      selectInProgressRows({
        sessions,
        sliceRuns,
        initiatives,
      }),
    [initiatives, sessions, sliceRuns]
  );

  const statusOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const status = normalizeStatus(row.status);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }));
  }, [rows]);

  const filtered = useMemo(() => {
    if (!activeFilter) return rows;
    return rows.filter((row) => normalizeStatus(row.status) === activeFilter);
  }, [activeFilter, rows]);

  const runWorkstreamAction = async (
    row: InProgressRow,
    action: (session: SessionTreeNode) => Promise<void> | void,
    successMessage: string
  ) => {
    if (!row.session) return;
    setNotice(null);
    setBusySessionId(row.session.id);
    try {
      await action(row.session);
      setNotice(successMessage);
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      setNotice(raw ? humanizeWarning(raw) : 'Workstream action failed');
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
            <span className="chip text-micro">{rows.length}</span>
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
            <span className="tabular-nums opacity-70">{rows.length}</span>
          </button>
          {statusOptions.map(({ status, count }) => (
            <button
              key={status}
              type="button"
              onClick={() => setActiveFilter((prev) => (prev === status ? null : status))}
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
        rows.length === 0 && needsAttentionCount > 0 && onSwitchToNeedsAttention ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03]">
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-secondary" aria-hidden>
                <path d="M10 6v4m0 4h.01M3 10a7 7 0 1114 0 7 7 0 01-14 0z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="text-body font-medium text-primary">All clear</p>
              <p className="mt-1 text-caption leading-relaxed text-secondary">
                No active runs right now.{' '}
                <span className="tabular-nums font-semibold text-[#F5B700]/90">{needsAttentionCount}</span>{' '}
                {needsAttentionCount === 1 ? 'item needs' : 'items need'} your attention.
              </p>
            </div>
            <button
              type="button"
              onClick={onSwitchToNeedsAttention}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#F5B700]/25 bg-[#F5B700]/[0.08] px-4 text-caption font-semibold text-[#FFE7A8] transition-colors hover:border-[#F5B700]/40 hover:bg-[#F5B700]/[0.14]"
            >
              <span>Review needs attention</span>
              <span className="tabular-nums opacity-80">{needsAttentionCount}</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 py-10">
            <p className="text-body text-secondary">
              {rows.length === 0 ? 'No runs in progress.' : 'No runs match this filter.'}
            </p>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="space-y-2">
            {filtered.map((row, index) => {
              const status = normalizeStatus(row.status ?? '');
              const when = row.updatedAt;
              const subtitle = row.subtitle
                ? row.subtitle
                : when
                  ? `Updated ${formatRelativeTime(when)}`
                  : null;
              const initiativeDisplay =
                row.initiativeTitle || row.initiativeId
                  ? sanitizeDisplayText(
                      row.initiativeTitle && !isOpaqueId(row.initiativeTitle)
                        ? row.initiativeTitle
                        : compactOpaqueLabel(row.initiativeId, 'Initiative')
                    )
                  : null;
              const rowTitleRaw = row.title?.trim() ? row.title : row.workstreamTitle ?? '';
              const rowTitleFallback = compactOpaqueLabel(
                row.workstreamId ?? row.runId,
                row.scope === 'milestone' ? 'Milestone' : row.scope === 'task' ? 'Task' : 'Workstream'
              );
              const rowTitleDisplay = sanitizeDisplayText(
                rowTitleRaw && !isOpaqueId(rowTitleRaw) ? rowTitleRaw : rowTitleFallback
              );
              const subtitleDisplay = subtitle ? sanitizeDisplayText(subtitle) : null;
              const progressValue = coerceProgress(row.progress);
              const canPauseAction = ['running', 'active', 'in_progress', 'working', 'planning', 'dispatching'].includes(status);
              const canResumeAction = ['paused', 'blocked', 'queued', 'pending'].includes(status);
              const restartHandler = onRestartSession ?? onPlayWorkstream;
              const showEstimatedProgress =
                progressValue === null &&
                ['running', 'active', 'in_progress', 'working', 'planning', 'dispatching'].includes(status);
              const sessionBusy = row.session ? busySessionId === row.session.id : false;
              const isExpanded = expandedRowKey === row.key;
              const hasSliceDetails =
                row.source === 'slice' &&
                (row.taskIds.length > 0 ||
                  row.milestoneIds.length > 0 ||
                  row.artifactCount > 0 ||
                  row.decisionCount > 0);

              const linkedSliceRun =
                (row.initiativeId && row.workstreamId
                  ? sliceRunByScope.get(`${row.initiativeId}:${row.workstreamId}`) ?? null
                  : null) ??
                (row.runId ? sliceRunByScope.get(`run:${row.runId}`) ?? null : null);

              return (
                <motion.article
                  initial={{ opacity: 0, y: 10, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{
                    duration: 0.24,
                    delay: Math.min(index, 7) * 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  key={row.key}
                  className="group hover-lift relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 cursor-pointer transition-colors hover:border-white/[0.14]"
                  onClick={() => onOpenSliceDetail?.(row, linkedSliceRun)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSliceDetail?.(row, linkedSliceRun); } }}
                >
                  <div
                    className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${statusHighlight(status)}`}
                    aria-hidden
                  />
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div
                      className={row.status === 'running' ? 'agent-glow-ring rounded-full' : ''}
                      style={row.status === 'running' ? { '--agent-glow-color': getAgentPersonality(inferAgentDomain(row.session?.agentId)).glowColor } as React.CSSProperties : undefined}
                    >
                      <AgentAvatar
                        name={row.session?.agentName ?? 'OrgX'}
                        hint={row.session?.agentId ?? row.runId}
                        size="sm"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      {initiativeDisplay ? (
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">
                          {initiativeDisplay}
                        </p>
                      ) : null}
                      <div className="flex min-w-0 items-start gap-1.5">
                        <EntityIcon type="session" size={12} className="mt-[3px] flex-shrink-0 opacity-80" />
                        <p className="min-w-0 line-clamp-2 text-body font-semibold leading-snug text-white" title={rowTitleDisplay}>
                          {rowTitleDisplay}
                        </p>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {row.scope && row.scope !== 'task' && (
                          <Pill tone={row.scope === 'milestone' ? 'cyan' : 'lime'}>
                            {row.scope}
                          </Pill>
                        )}
                        <span className={`inline-flex rounded-full border px-2 py-[1px] text-micro font-semibold uppercase tracking-[0.08em] ${statusTone(status)}`}>
                          {statusLabel(status)}
                        </span>
                      </div>
                      {subtitleDisplay ? (
                        <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={subtitleDisplay}>
                          {subtitleDisplay}
                        </p>
                      ) : null}
                      {(progressValue !== null || showEstimatedProgress) && (
                        <div className="mt-2">
                          <div className="mb-1 flex items-center justify-between text-micro">
                            <span className="text-secondary">Progress</span>
                            <span className="font-semibold text-primary tabular-nums">
                              {progressValue === null ? 'In progress' : `${progressValue}%`}
                            </span>
                          </div>
                          <div className={`h-1.5 overflow-hidden rounded-full bg-white/[0.09]${progressValue === 100 ? ' shimmer-on-complete' : ''}`}>
                            {progressValue === null ? (
                              <div className="h-full w-1/3 animate-pulse rounded-full bg-[#7dd3c0]/70" />
                            ) : (
                              <div
                                className="h-full rounded-full transition-[width] duration-500"
                                style={{
                                  width: `${Math.max(3, progressValue)}%`,
                                  background: `linear-gradient(90deg, ${getAgentPersonality(inferAgentDomain(row.session?.agentId)).gradient[0]}, ${getAgentPersonality(inferAgentDomain(row.session?.agentId)).gradient[1]})`,
                                }}
                              />
                            )}
                          </div>
                        </div>
                      )}
                      {row.milestoneProgress && row.milestoneProgress.length > 0 && (
                        <div className="mt-2">
                          <ScopeProgressCard
                            nodes={buildScopeFromSliceRun({
                              initiativeId: row.initiativeId,
                              initiativeTitle: row.initiativeTitle,
                              workstreamId: row.workstreamId,
                              workstreamTitle: row.workstreamTitle,
                              taskIds: row.taskIds,
                              milestoneIds: row.milestoneIds,
                              scopeProgress: row.milestoneProgress
                                ? {
                                    totalTasks: row.milestoneProgress.reduce((s, m) => s + m.total, 0),
                                    completedTasks: row.milestoneProgress.reduce((s, m) => s + m.done, 0),
                                    milestones: row.milestoneProgress,
                                  }
                                : null,
                              status: row.status,
                            })}
                            activeId={row.workstreamId}
                            compact
                          />
                        </div>
                      )}

                      {hasSliceDetails ? (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() => setExpandedRowKey((prev) => (prev === row.key ? null : row.key))}
                            className="inline-flex h-6 items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 text-micro font-semibold text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
                          >
                            {isExpanded ? 'Hide details' : 'Slice details'}
                          </button>
                          {isExpanded ? (
                            <div className="mt-2 space-y-2 rounded-lg border border-white/[0.08] bg-black/[0.18] px-2.5 py-2">
                              {row.workstreamTitle ? (
                                <p className="text-caption text-secondary">
                                  Workstream: <span className="text-white/90">{row.workstreamTitle}</span>
                                </p>
                              ) : null}
                              <div className="flex flex-wrap gap-1.5 text-micro">
                                <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-secondary">
                                  Tasks {row.taskIds.length}
                                </span>
                                <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-secondary">
                                  Milestones {row.milestoneIds.length}
                                </span>
                                <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-secondary">
                                  Artifacts {row.artifactCount}
                                </span>
                                <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-secondary">
                                  Needs input {row.decisionCount}
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.07] pt-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => {
                            if (row.session) {
                              onOpenSession?.(row.session.id);
                              return;
                            }
                            onFocusRunId?.(row.runId);
                          }}
                          className="control-pill h-7 px-2.5 text-micro font-semibold"
                          title={row.session ? 'Open session detail' : 'Focus in Activity'}
                        >
                          {row.session ? 'Open' : 'Focus'}
                        </button>
                        {row.session && canPauseAction && onPauseWorkstream && row.session.initiativeId && row.session.workstreamId && (
                          <button
                            type="button"
                            disabled={sessionBusy}
                            onClick={() =>
                              void runWorkstreamAction(
                                row,
                                onPauseWorkstream,
                                `Paused ${row.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Pause and return this workstream to queue"
                          >
                            Pause
                          </button>
                        )}
                        {row.session && canResumeAction && onResumeWorkstream && row.session.initiativeId && row.session.workstreamId && (
                          <button
                            type="button"
                            disabled={sessionBusy}
                            onClick={() =>
                              void runWorkstreamAction(
                                row,
                                onResumeWorkstream,
                                `Resumed ${row.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Resume this workstream"
                          >
                            Resume
                          </button>
                        )}
                        {row.session && restartHandler && row.session.initiativeId && row.session.workstreamId && (
                          <button
                            type="button"
                            disabled={sessionBusy}
                            onClick={() =>
                              void runWorkstreamAction(
                                row,
                                restartHandler,
                                `Restarted ${row.title}.`
                              )
                            }
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                            title="Restart this workstream"
                          >
                            Restart
                          </button>
                        )}
                        {row.session && onIntervene && (
                          <button
                            type="button"
                            disabled={sessionBusy}
                            onClick={() =>
                              void runWorkstreamAction(
                                row,
                                onIntervene,
                                `Opened intervention for ${row.title}.`
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
                </motion.article>
              );
            })}
          </div>
        </div>
      )}
    </PremiumCard>
  );
});
