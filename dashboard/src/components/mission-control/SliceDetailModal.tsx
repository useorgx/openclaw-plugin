import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Modal } from '@/components/shared/Modal';
import { ModalShell } from '@/components/shared/ModalShell';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Pill } from '@/components/shared/Pill';
import { formatRelativeTime } from '@/lib/time';
import { sanitizeDisplayText, humanizeStopReason, humanizeLaneState } from '@/lib/humanize';
import { colors, motion as motionTokens } from '@/lib/tokens';
import { projectRunStatus } from '@/lib/runStatusModel';
import type { NextUpQueueItem, SliceRunProjection } from '@/types';
import type { InProgressRow } from './InProgressPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SliceDetailTarget =
  | { source: 'queue'; item: NextUpQueueItem; linkedSliceRun: SliceRunProjection | null }
  | { source: 'in_progress'; row: InProgressRow; sliceRun: SliceRunProjection | null }
  | { source: 'needs_input'; sliceRun: SliceRunProjection };

interface SliceDetailModalProps {
  target: SliceDetailTarget | null;
  onClose: () => void;
  onPlayWorkstream?: (initiativeId: string, workstreamId: string, agentId?: string) => void;
  onStartAutoContinue?: (initiativeId: string, workstreamId: string, agentId?: string) => void;
  onMoveWorkstream?: (initiativeId: string, workstreamId: string, placement: 'top' | 'bottom') => void;
  onRemoveFromQueue?: (initiativeId: string, workstreamId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onFocusRunId?: (runId: string) => void;
  onOpenInitiative?: (initiativeId: string) => void;
  onReviewActivity?: (sliceRun: SliceRunProjection) => void;
  onOpenDecisions?: () => void;
  onAcceptSlice?: (sliceRun: SliceRunProjection) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function queueAccentStyle(state: string): React.CSSProperties {
  switch (state) {
    case 'running':
      return { background: `linear-gradient(to right, ${colors.lime}, ${colors.teal})` };
    case 'blocked':
      return { background: `linear-gradient(to right, ${colors.red}, ${colors.amber})` };
    case 'idle':
      return { background: `linear-gradient(to right, ${colors.iris}99, transparent)` };
    default:
      return { background: `linear-gradient(to right, ${colors.lime}B3, ${colors.teal}66)` };
  }
}

function queueStateLabel(state: string): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'blocked':
      return 'Blocked';
    case 'idle':
      return 'Idle';
    case 'queued':
      return 'Queued';
    default:
      return state.replace(/_/g, ' ');
  }
}

function queueStateDotColor(state: string): string {
  switch (state) {
    case 'running':
      return colors.lime;
    case 'blocked':
      return colors.red;
    case 'idle':
      return colors.iris;
    case 'queued':
      return colors.teal;
    default:
      return colors.amber;
  }
}

function workSnapshotHeading(queueState: string): string {
  if (queueState === 'running') return 'Current Work';
  if (queueState === 'blocked') return 'Blocked Work';
  return 'Next Work';
}

function workSnapshotFallback(input: {
  queueState: string;
  blockReason: string | null;
  sliceScope: string | null;
  sliceTaskCount: number | null;
}): string {
  const scopeLabel =
    input.sliceScope === 'task'
      ? 'task'
      : input.sliceScope === 'milestone'
        ? 'milestone slice'
        : 'workstream slice';
  const countLabel =
    typeof input.sliceTaskCount === 'number' && input.sliceTaskCount > 0
      ? `${input.sliceTaskCount} ${input.sliceTaskCount === 1 ? 'task' : 'tasks'}`
      : null;

  if (input.queueState === 'running') {
    return countLabel
      ? `Execution is in progress across ${countLabel} in this ${scopeLabel}.`
      : 'Execution is in progress. Task detail will appear when scheduler state updates.';
  }
  if (input.queueState === 'blocked') {
    return input.blockReason
      ? input.blockReason
      : 'Work is blocked pending a dependency or decision.';
  }
  if (input.queueState === 'queued') {
    return countLabel
      ? `Queued with ${countLabel} ready in this ${scopeLabel}.`
      : 'Queued at workstream scope. Task detail appears after dispatch.';
  }
  if (input.queueState === 'completed') {
    return 'Work is completed. No pending queued tasks.';
  }
  return 'Work is idle and ready to start.';
}

function priorityColor(priority: number | null): string {
  if (priority === 0) return colors.red;
  if (priority === 1) return colors.amber;
  if (priority === 2) return colors.iris;
  return 'rgba(255,255,255,0.5)';
}

function priorityLabel(priority: number | null): string {
  if (priority === 0) return 'P0';
  if (priority === 1) return 'P1';
  if (priority === 2) return 'P2';
  if (priority === 3) return 'P3';
  return '';
}

function confidenceDots(level: 'low' | 'medium' | 'high'): { filled: number; color: string } {
  switch (level) {
    case 'high':
      return { filled: 5, color: colors.lime };
    case 'medium':
      return { filled: 3, color: colors.amber };
    case 'low':
      return { filled: 1, color: colors.red };
    default:
      return { filled: 0, color: colors.iris };
  }
}

async function openRunInTerminal(input: {
  runId?: string | null;
  sliceRunId?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  const payload: Record<string, string> = {};
  if (input.runId) payload.runId = input.runId;
  if (input.sliceRunId) payload.sliceRunId = input.sliceRunId;
  if (input.sessionId) payload.sessionId = input.sessionId;
  if (Object.keys(payload).length === 0) {
    throw new Error('No run identifier available for terminal open.');
  }
  const response = await fetch('/orgx/api/live/terminal/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Terminal open failed (${response.status})`
    );
  }
}

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const heroVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.28,
      delay: i * 0.04,
      ease: [0.16, 1, 0.3, 1],
    },
  }),
  exit: { opacity: 0, transition: { duration: 0.18 } },
};

const sectionVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.22,
      delay: i * 0.04,
      ease: motionTokens.easingStandard as [number, number, number, number],
    },
  }),
  exit: { opacity: 0, transition: { duration: 0.18 } },
};

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

function extractData(target: SliceDetailTarget) {
  if (target.source === 'queue') {
    const { item, linkedSliceRun } = target;
    return {
      initiativeId: item.initiativeId,
      initiativeTitle: sanitizeDisplayText(item.initiativeTitle),
      initiativeStatus: item.initiativeStatus,
      workstreamId: item.workstreamId,
      workstreamTitle: sanitizeDisplayText(item.workstreamTitle),
      workstreamStatus: item.workstreamStatus,
      nextTaskTitle: item.nextTaskTitle ? sanitizeDisplayText(item.nextTaskTitle) : null,
      nextTaskPriority: item.nextTaskPriority,
      nextTaskDueAt: item.nextTaskDueAt,
      agentId: item.runnerAgentId,
      agentName: item.runnerAgentName,
      agentSource: item.runnerSource,
      queueState: item.queueState,
      blockReason: item.blockReason ? sanitizeDisplayText(item.blockReason) : null,
      sliceScope: item.sliceScope ?? null,
      sliceTaskCount:
        typeof item.sliceTaskCount === 'number' && Number.isFinite(item.sliceTaskCount)
          ? Math.max(0, Math.floor(item.sliceTaskCount))
          : item.sliceTaskIds?.length ?? null,
      autoContinue: item.autoContinue,
      sliceRun: linkedSliceRun,
      sessionId: null as string | null,
      runId: linkedSliceRun?.runId ?? null,
    };
  }

  if (target.source === 'in_progress') {
    const { row, sliceRun } = target;
    return {
      initiativeId: row.initiativeId,
      initiativeTitle: row.initiativeTitle ? sanitizeDisplayText(row.initiativeTitle) : null,
      initiativeStatus: null as string | null,
      workstreamId: row.workstreamId,
      workstreamTitle: row.workstreamTitle ? sanitizeDisplayText(row.workstreamTitle) : row.title,
      workstreamStatus: row.status,
      nextTaskTitle: null as string | null,
      nextTaskPriority: null as number | null,
      nextTaskDueAt: null as string | null,
      agentId: row.session?.agentId ?? null,
      agentName: row.session?.agentName ?? 'OrgX',
      agentSource: null as string | null,
      queueState: row.status === 'running' ? 'running' : 'queued',
      blockReason: null as string | null,
      sliceScope: sliceRun?.scope ?? null,
      sliceTaskCount:
        typeof sliceRun?.scopeProgress?.totalTasks === 'number'
          ? Math.max(
              0,
              Math.floor(sliceRun.scopeProgress.totalTasks - sliceRun.scopeProgress.completedTasks)
            )
          : sliceRun?.taskIds?.length ?? null,
      autoContinue: null as NextUpQueueItem['autoContinue'] | null,
      sliceRun: sliceRun,
      sessionId: row.session?.id ?? null,
      runId: row.runId,
    };
  }

  // needs_input
  const { sliceRun } = target;
  return {
    initiativeId: sliceRun.initiativeId,
    initiativeTitle: null as string | null,
    initiativeStatus: null as string | null,
    workstreamId: sliceRun.workstreamId,
    workstreamTitle: sliceRun.workstreamTitle ? sanitizeDisplayText(sliceRun.workstreamTitle) : 'Work slice',
    workstreamStatus: sliceRun.status,
    nextTaskTitle: null as string | null,
    nextTaskPriority: null as number | null,
    nextTaskDueAt: null as string | null,
    agentId: null as string | null,
    agentName: 'OrgX',
    agentSource: null as string | null,
    queueState: 'blocked' as string,
    blockReason: sliceRun.statusExplainer || null,
    sliceScope: sliceRun.scope ?? null,
    sliceTaskCount:
      typeof sliceRun.scopeProgress?.totalTasks === 'number'
        ? Math.max(
            0,
            Math.floor(sliceRun.scopeProgress.totalTasks - sliceRun.scopeProgress.completedTasks)
          )
        : sliceRun.taskIds?.length ?? null,
    autoContinue: null as NextUpQueueItem['autoContinue'] | null,
    sliceRun: sliceRun,
    sessionId: null as string | null,
    runId: sliceRun.runId,
  };
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

function SectionDivider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SliceDetailModal({
  target,
  onClose,
  onPlayWorkstream,
  onStartAutoContinue,
  onMoveWorkstream,
  onRemoveFromQueue,
  onOpenSession,
  onFocusRunId,
  onOpenInitiative,
  onReviewActivity,
  onOpenDecisions,
  onAcceptSlice,
}: SliceDetailModalProps) {
  const open = target !== null;
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Keyboard shortcut: Cmd+Enter → Start
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!target) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const d = extractData(target);
        if (d.initiativeId && d.workstreamId) {
          onPlayWorkstream?.(d.initiativeId, d.workstreamId, d.agentId ?? undefined);
        }
      }
    },
    [target, onPlayWorkstream]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  useEffect(() => {
    if (open) return;
    setTerminalError(null);
    setIsOpeningTerminal(false);
  }, [open]);

  if (!target) return null;

  const d = extractData(target);
  const sr = d.sliceRun;
  const canonicalProjection = projectRunStatus({
    sessionStatus: d.queueState,
    sessionPhase: d.workstreamStatus,
    sliceStatus: sr?.status ?? d.workstreamStatus,
    activityStatus: sr?.runtimeState ?? d.workstreamStatus ?? d.queueState,
    stopReason: d.queueState === 'blocked' ? 'blocked' : null,
    decisionRequired: (sr?.blockingDecisionCount ?? 0) > 0,
    blockingDecisionCount: sr?.blockingDecisionCount ?? 0,
    nonBlockingDecisionCount: Math.max(
      0,
      (sr?.decisionCount ?? 0) - (sr?.blockingDecisionCount ?? 0)
    ),
    blockerCount: d.blockReason ? 1 : 0,
    blockerReason: d.blockReason,
  });
  const canonicalStatusClass =
    canonicalProjection.status === 'completed'
      ? 'text-lime border-lime/30 bg-lime/[0.12]'
      : canonicalProjection.status === 'failed'
        ? 'text-red-200 border-red-400/30 bg-red-500/[0.12]'
        : canonicalProjection.status === 'needs_attention'
          ? 'text-amber-200 border-amber-400/30 bg-amber-500/[0.12]'
          : canonicalProjection.status === 'in_progress'
            ? 'text-teal-200 border-teal-400/30 bg-teal-500/[0.12]'
            : 'text-secondary border-white/[0.14] bg-white/[0.04]';
  const canonicalNarrativeClass =
    canonicalProjection.tone === 'critical'
      ? 'border-red-400/24 bg-red-500/[0.08]'
      : canonicalProjection.tone === 'warning'
        ? 'border-amber-400/24 bg-amber-500/[0.08]'
        : canonicalProjection.tone === 'positive'
          ? 'border-lime/24 bg-lime/[0.08]'
          : 'border-subtle bg-white/[0.02]';
  // Single canonical badge — no duplicate raw status badges

  const breadcrumbs = [
    ...(d.initiativeTitle
      ? [{
          label: d.initiativeTitle,
          onClick: d.initiativeId ? () => onOpenInitiative?.(d.initiativeId!) : undefined,
        }]
      : []),
    { label: d.workstreamTitle },
  ];

  const isRunning = canonicalProjection.status === 'in_progress';
  const canStart = Boolean(d.initiativeId && d.workstreamId && !isRunning);
  const nextActionLabel =
    canonicalProjection.nextAction ??
    (target.source === 'needs_input' && sr
      ? sr.primaryAction === 'resolve_decision'
        ? 'Resolve decision'
        : sr.primaryAction === 'open_artifact'
          ? 'Open result'
          : 'Review activity'
      : null);

  const handleOpenTerminal = useCallback(
    async (input: { runId?: string | null; sliceRunId?: string | null; sessionId?: string | null }) => {
      try {
        setTerminalError(null);
        setIsOpeningTerminal(true);
        await openRunInTerminal(input);
      } catch (error) {
        setTerminalError(error instanceof Error ? error.message : 'Unable to open terminal');
      } finally {
        setIsOpeningTerminal(false);
      }
    },
    []
  );

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------

  const footer = (
    <div className="flex items-center gap-2">
      {target.source === 'queue' && (
        <>
          <button
            type="button"
            onClick={() => {
              if (d.initiativeId && d.workstreamId) {
                onRemoveFromQueue?.(d.initiativeId, d.workstreamId);
                onClose();
              }
            }}
            className="control-pill h-8 px-3 text-caption font-semibold text-red-100 hover:bg-red-500/[0.12]"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => {
              if (d.initiativeId && d.workstreamId) {
                onMoveWorkstream?.(d.initiativeId, d.workstreamId, 'top');
              }
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
          >
            Move top
          </button>
          <button
            type="button"
            onClick={() => {
              if (d.initiativeId && d.workstreamId) {
                onMoveWorkstream?.(d.initiativeId, d.workstreamId, 'bottom');
              }
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
          >
            Move bottom
          </button>
        </>
      )}
      {target.source === 'in_progress' && d.sessionId && (
        <>
          <button
            type="button"
            onClick={() => {
              onOpenSession?.(d.sessionId!);
              onClose();
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
          >
            Open session
          </button>
          <button
            type="button"
            onClick={() => {
              void handleOpenTerminal({
                sessionId: d.sessionId,
                runId: d.runId,
                sliceRunId: sr?.sliceRunId ?? null,
              });
            }}
            disabled={isOpeningTerminal}
            className="control-pill h-8 px-3 text-caption font-semibold inline-flex items-center gap-1.5"
            title="Open session log in terminal"
          >
            <span className="relative inline-block h-3 w-2">
              <span className="absolute inset-0 border-l border-b border-white/40 rounded-sm" />
              <motion.span
                className="absolute bottom-0 left-0.5 h-2 w-px bg-white/70"
                animate={{ opacity: [1, 0, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              />
            </span>
            {isOpeningTerminal ? 'Opening…' : 'Terminal'}
          </button>
        </>
      )}
      {target.source === 'needs_input' && sr && (
        <>
          {sr.primaryAction === 'resolve_decision' ? (
            <button
              type="button"
              onClick={() => {
                onOpenDecisions?.();
                onClose();
              }}
              className="control-pill h-8 px-3 text-caption font-semibold"
              data-tone="teal"
            >
              Resolve decision
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onReviewActivity?.(sr);
              onClose();
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
            data-tone={sr.status === 'failed' ? 'teal' : undefined}
          >
            Review activity
          </button>
          {(sr.runId || sr.sliceRunId) && (
            <button
              type="button"
              onClick={() => {
                void handleOpenTerminal({
                  runId: sr.runId ?? null,
                  sliceRunId: sr.sliceRunId ?? null,
                });
              }}
              disabled={isOpeningTerminal}
              className="control-pill h-8 px-3 text-caption font-semibold inline-flex items-center gap-1.5"
              title="Open run log in terminal"
            >
              <span className="relative inline-block h-3 w-2">
                <span className="absolute inset-0 border-l border-b border-white/40 rounded-sm" />
                <motion.span
                  className="absolute bottom-0 left-0.5 h-2 w-px bg-white/70"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 1, repeat: Infinity }}
                />
              </span>
              {isOpeningTerminal ? 'Opening…' : 'Terminal'}
            </button>
          )}
          {/* Accept / Intervene actions for needs_review items */}
          {sr.status === 'needs_review' && onAcceptSlice && (
            <button
              type="button"
              onClick={() => {
                onAcceptSlice(sr);
                onClose();
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#BFFF00]/25 bg-[#BFFF00]/10 px-4 text-caption font-semibold text-[#E1FFB2] transition-colors hover:bg-[#BFFF00]/20"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Accept
            </button>
          )}
        </>
      )}
      {d.runId && (
        <>
          <button
            type="button"
            onClick={() => {
              onFocusRunId?.(d.runId!);
              onClose();
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
          >
            View in timeline
          </button>
          {!d.sessionId && (
            <button
              type="button"
              onClick={() => {
                void handleOpenTerminal({
                  runId: d.runId,
                  sliceRunId: sr?.sliceRunId ?? null,
                });
              }}
              disabled={isOpeningTerminal}
              className="control-pill h-8 px-3 text-caption font-semibold inline-flex items-center gap-1.5"
              title="Open run log in terminal"
            >
              <span className="relative inline-block h-3 w-2">
                <span className="absolute inset-0 border-l border-b border-white/40 rounded-sm" />
                <motion.span
                  className="absolute bottom-0 left-0.5 h-2 w-px bg-white/70"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 1, repeat: Infinity }}
                />
              </span>
              {isOpeningTerminal ? 'Opening…' : 'Terminal'}
            </button>
          )}
        </>
      )}
      <div className="flex-1" />
      {canStart && (
        <button
          type="button"
          data-modal-autofocus="true"
          onClick={() => {
            onPlayWorkstream?.(d.initiativeId!, d.workstreamId!, d.agentId ?? undefined);
            onClose();
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#BFFF00]/25 bg-[#BFFF00]/10 px-4 text-caption font-semibold text-[#E1FFB2] transition-colors hover:bg-[#BFFF00]/20"
          title="Start (⌘ Enter)"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden className="h-3.5 w-3.5">
            <path d="M7 5.4v9.2c0 .7.75 1.15 1.38.83l7.6-4.6a.95.95 0 0 0 0-1.62l-7.6-4.64A.95.95 0 0 0 7 5.4Z" fill="currentColor" />
          </svg>
          {canonicalProjection.status === 'completed'
            ? 'Restart'
            : canonicalProjection.status === 'needs_attention'
              ? 'Retry'
              : 'Start'}
        </button>
      )}
    </div>
  );

  // -------------------------------------------------------------------------
  // Section index for stagger
  // -------------------------------------------------------------------------

  let sectionIndex = 0;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-xl">
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Status accent bar */}
        <div
          className="h-[2px] flex-shrink-0 rounded-t-2xl"
          style={queueAccentStyle(d.queueState)}
          aria-hidden
        />

        <ModalShell breadcrumbs={breadcrumbs} onClose={onClose} footer={footer}>
          <div className="px-6 py-5 space-y-5">

            {/* ───── 1. Hero ───── */}
            <motion.div
              variants={heroVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              custom={sectionIndex++}
              className="flex items-start gap-3"
            >
              <AgentAvatar
                name={d.agentName ?? 'OrgX'}
                hint={d.agentId}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[20px] font-semibold leading-snug text-white">
                  {d.workstreamTitle}
                </p>
                {d.initiativeTitle && (
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-muted">
                    {d.initiativeTitle}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-[1px] text-micro font-semibold uppercase tracking-[0.06em] ${canonicalStatusClass}`}
                  >
                    <span className="relative mr-1.5 inline-block h-1.5 w-1.5">
                      <span
                        className="absolute inset-0 rounded-full"
                        style={{ backgroundColor: queueStateDotColor(d.queueState) }}
                      />
                      {isRunning && (
                        <motion.span
                          className="absolute inset-0 rounded-full"
                          style={{ backgroundColor: queueStateDotColor(d.queueState) }}
                          animate={{ opacity: [1, 0.3, 1], scale: [1, 1.6, 1] }}
                          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                        />
                      )}
                    </span>
                    {canonicalProjection.label}
                  </span>
                </div>
              </div>
            </motion.div>

            <SectionDivider />

            {target.source === 'needs_input' && sr ? (
              <>
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className={`rounded-xl border px-4 py-3 ${canonicalNarrativeClass}`}
                >
                  <p className="section-kicker">What to do now</p>
                  <p className="mt-1 text-body text-primary">
                    {canonicalProjection.sentence}
                  </p>
                  {sr.artifactCount > 0 ? (
                    <p className="mt-1 text-caption text-secondary">
                      {sr.artifactCount} artifact{sr.artifactCount === 1 ? '' : 's'} ready for review.
                    </p>
                  ) : null}
                  {sr.blockingDecisionCount > 0 ? (
                    <p className="mt-1 text-caption text-secondary">
                      {sr.blockingDecisionCount} blocking decision
                      {sr.blockingDecisionCount === 1 ? '' : 's'} waiting.
                    </p>
                  ) : null}
                  {nextActionLabel ? (
                    <p className="mt-1 text-caption text-secondary">Recommended action: {nextActionLabel}</p>
                  ) : null}
                </motion.div>
                <SectionDivider />
              </>
            ) : null}

            {/* ───── 2. Context & Details card ───── */}
            {(d.blockReason || d.autoContinue || (d.agentSource && d.agentSource !== 'assigned')) && (
              <motion.div
                variants={sectionVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                custom={sectionIndex++}
                className="space-y-2"
              >
                {d.blockReason && (
                  <div className="rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1.5 text-caption text-red-100/85">
                    <p className="mb-0.5 text-micro font-semibold uppercase tracking-[0.08em] text-red-200/70">Why blocked</p>
                    {d.blockReason}
                  </div>
                )}

                {d.autoContinue && (
                  <div className="flex items-center gap-2 text-caption text-secondary">
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-[#0AD4C4]">
                      <path
                        d="M6.1 13.25C4.25 13.25 2.8 11.8 2.8 10s1.45-3.25 3.3-3.25c3.15 0 4.35 6.5 8.05 6.5 1.85 0 3.3-1.45 3.3-3.25s-1.45-3.25-3.3-3.25c-3.7 0-4.9 6.5-8.05 6.5Z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>
                      Auto-continue: <span className="text-primary capitalize">{d.autoContinue.status}</span>
                      {d.autoContinue.laneState && (
                        <span className="text-muted"> · {humanizeLaneState(d.autoContinue.laneState)}</span>
                      )}
                    </span>
                  </div>
                )}

                {d.autoContinue?.laneBlockedReason && (
                  <p className="text-micro text-red-100/75">
                    {d.autoContinue.laneBlockedReason}
                  </p>
                )}

                {d.autoContinue?.stopReason && (
                  <p className="text-micro text-amber-100/75">
                    {humanizeStopReason(d.autoContinue.stopReason)}
                  </p>
                )}
              </motion.div>
            )}

            {/* ───── 3. Work Snapshot card ───── */}
            {(d.nextTaskTitle || d.sliceTaskCount !== null || d.sliceScope || d.queueState) && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className="space-y-2"
                >
                  <p className="section-kicker">Work Snapshot</p>
                  {d.nextTaskTitle ? (
                    <div className="flex items-start gap-2">
                      <EntityIcon type="task" size={14} className="mt-[2px] flex-shrink-0 opacity-80" />
                      <div className="min-w-0">
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">
                          {workSnapshotHeading(d.queueState)}
                        </p>
                        <p className="text-body font-semibold leading-snug text-white">{d.nextTaskTitle}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-body text-secondary">
                      {workSnapshotFallback({
                        queueState: d.queueState,
                        blockReason: d.blockReason,
                        sliceScope: d.sliceScope,
                        sliceTaskCount: d.sliceTaskCount,
                      })}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    {d.sliceScope ? (
                      <span className="inline-flex rounded-full border border-strong bg-white/[0.03] px-2 py-[1px] text-micro uppercase tracking-[0.08em] text-secondary">
                        {d.sliceScope} slice
                      </span>
                    ) : null}
                    {typeof d.sliceTaskCount === 'number' ? (
                      <span className="inline-flex rounded-full border border-strong bg-white/[0.03] px-2 py-[1px] text-micro text-secondary">
                        {d.sliceTaskCount} {d.sliceTaskCount === 1 ? 'task' : 'tasks'} in scope
                      </span>
                    ) : null}
                    {d.nextTaskPriority !== null && priorityLabel(d.nextTaskPriority) && (
                      <span
                        className="inline-flex rounded-full border px-2 py-[1px] text-micro font-semibold"
                        style={{
                          color: priorityColor(d.nextTaskPriority),
                          borderColor: `${priorityColor(d.nextTaskPriority)}33`,
                          backgroundColor: `${priorityColor(d.nextTaskPriority)}14`,
                        }}
                      >
                        {priorityLabel(d.nextTaskPriority)}
                      </span>
                    )}
                    {d.nextTaskDueAt && (
                      <span className="text-micro text-secondary">
                        Due {formatRelativeTime(d.nextTaskDueAt)}
                      </span>
                    )}
                  </div>
                </motion.div>
              </>
            )}

            {/* ───── 4. Timeline section ───── */}
            {sr && (sr.startedAt || sr.updatedAt || sr.completedAt || sr.failedAt) && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className="space-y-3"
                >
                  <div className="flex items-center gap-2">
                    <p className="section-kicker">Timeline</p>
                    {sr.scope && sr.scope !== 'task' && (
                      <Pill tone={sr.scope === 'milestone' ? 'cyan' : 'lime'}>
                        {sr.scope}
                      </Pill>
                    )}
                    {sr.confidence && (
                      <div className="flex items-center gap-1 ml-auto" title={`Confidence: ${sr.confidence}`}>
                        {Array.from({ length: 5 }, (_, i) => {
                          const { filled, color } = confidenceDots(sr.confidence);
                          return (
                            <span
                              key={i}
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{
                                backgroundColor: i < filled ? color : 'rgba(255,255,255,0.1)',
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Timestamp grid — deduplicate Updated/Completed if identical */}
                  <div className="grid grid-cols-3 gap-3">
                    {sr.startedAt && (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Started</p>
                        <p className="mt-0.5 text-caption text-primary">{formatRelativeTime(sr.startedAt)}</p>
                      </div>
                    )}
                    {sr.completedAt ? (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Completed</p>
                        <p className="mt-0.5 text-caption text-primary">{formatRelativeTime(sr.completedAt)}</p>
                      </div>
                    ) : sr.failedAt ? (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Failed</p>
                        <p className="mt-0.5 text-caption text-red-100">{formatRelativeTime(sr.failedAt)}</p>
                      </div>
                    ) : sr.updatedAt && sr.updatedAt !== sr.startedAt ? (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Updated</p>
                        <p className="mt-0.5 text-caption text-primary">{formatRelativeTime(sr.updatedAt)}</p>
                      </div>
                    ) : null}
                  </div>
                </motion.div>
              </>
            )}

            {/* ───── 4b. Scope hierarchy tree (milestone/workstream scopes) ───── */}
            {sr && sr.scope && sr.scope !== 'task' && sr.scopeProgress?.milestones && sr.scopeProgress.milestones.length > 0 && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className="space-y-2"
                >
                  <p className="section-kicker">
                    {sr.scope === 'workstream' ? 'Workstream' : 'Milestone'} Scope{' '}
                    <span className="text-muted tabular-nums">
                      {sr.scopeProgress.completedTasks}/{sr.scopeProgress.totalTasks} tasks
                    </span>
                  </p>
                  <div className="space-y-1">
                    {sr.scopeProgress.milestones.map((ms, msIdx) => (
                      <motion.div
                        key={ms.id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: msIdx * 0.04, duration: 0.22 }}
                        className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-caption font-medium text-primary">{ms.title}</span>
                          <span className="text-micro tabular-nums text-secondary">
                            {ms.done}/{ms.total}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${ms.total > 0 ? Math.max(2, Math.round((ms.done / ms.total) * 100)) : 0}%`,
                              background: 'linear-gradient(90deg, #22c55e88, #14b8a688)',
                            }}
                          />
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              </>
            )}

            {/* ───── 5. Artifacts section ───── */}
            {sr && sr.artifactCount > 0 && sr.artifacts.length > 0 && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className="space-y-2"
                >
                  <p className="section-kicker">
                    Artifacts <span className="text-muted tabular-nums">{sr.artifactCount}</span>
                  </p>
                  <div className="space-y-1">
                    {sr.artifacts.map((artifact, idx) => (
                      <div
                        key={artifact.id ?? idx}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
                      >
                        <EntityIcon
                          type={artifact.type === 'pull_request' ? 'session' : 'workstream'}
                          size={13}
                          className="flex-shrink-0 opacity-75"
                        />
                        <span className="min-w-0 flex-1 truncate text-caption text-primary">
                          {artifact.title}
                        </span>
                        {artifact.url && (
                          <a
                            href={artifact.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-shrink-0 text-micro text-secondary transition-colors hover:text-white"
                            title="Open artifact"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              </>
            )}

            {/* ───── 6. Decisions section ───── */}
            {sr && sr.decisionCount > 0 && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <p className="section-kicker">
                      Decisions <span className="text-muted tabular-nums">{sr.decisionCount}</span>
                    </p>
                    {sr.blockingDecisionCount > 0 && (
                      <span
                        className="inline-flex rounded-full border px-1.5 py-[0.5px] text-micro font-semibold tabular-nums"
                        style={{
                          color: colors.red,
                          borderColor: `${colors.red}33`,
                          backgroundColor: `${colors.red}14`,
                        }}
                      >
                        {sr.blockingDecisionCount} blocking
                      </span>
                    )}
                  </div>
                  {sr.decisionOptions.length > 0 && (
                    <div className="space-y-1.5">
                      {sr.decisionOptions.slice(0, 4).map((opt) => (
                        <div
                          key={opt.id}
                          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                        >
                          <p className="text-caption font-semibold text-primary">{opt.label}</p>
                          {opt.description && (
                            <p className="mt-0.5 text-micro leading-snug text-secondary">
                              {opt.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              </>
            )}

            {/* ───── 7. Technical details (collapsed by default) ───── */}
            {sr && (sr.sourceClient || sr.runtimeState || sr.correlationId || sr.runId) && (
              <>
                <SectionDivider />
                <details className="group">
                  <summary className="flex cursor-pointer select-none items-center gap-1.5 py-1 text-micro uppercase tracking-[0.08em] text-muted transition-colors hover:text-secondary">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="transition-transform group-open:rotate-90"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    Technical details
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                    {sr.sourceClient && (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Source</p>
                        <p className="mt-0.5 font-mono text-caption text-primary">{sr.sourceClient}</p>
                      </div>
                    )}
                    {sr.runtimeState && (
                      <div>
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Runtime State</p>
                        <p className="mt-0.5 font-mono text-caption text-primary">{sr.runtimeState}</p>
                      </div>
                    )}
                    {/* Show Run ID; skip Correlation ID if identical */}
                    {sr.runId && (
                      <div className="col-span-2">
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Run ID</p>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(sr.runId!);
                          }}
                          className="mt-0.5 font-mono text-caption text-primary transition-colors hover:text-white"
                          title="Click to copy"
                        >
                          {sr.runId}
                        </button>
                      </div>
                    )}
                    {sr.correlationId && sr.correlationId !== sr.runId && (
                      <div className="col-span-2">
                        <p className="text-micro uppercase tracking-[0.08em] text-muted">Correlation ID</p>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(sr.correlationId!);
                          }}
                          className="mt-0.5 font-mono text-caption text-primary transition-colors hover:text-white"
                          title="Click to copy"
                        >
                          {sr.correlationId}
                        </button>
                      </div>
                    )}
                  </div>
                </details>
              </>
            )}
            {terminalError ? (
              <>
                <SectionDivider />
                <p className="text-caption text-red-200/80">{terminalError}</p>
              </>
            ) : null}

          </div>
        </ModalShell>
      </div>
    </Modal>
  );
}
