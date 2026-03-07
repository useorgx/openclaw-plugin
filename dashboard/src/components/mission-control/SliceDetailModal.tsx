import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Modal } from '@/components/shared/Modal';
import { ModalShell } from '@/components/shared/ModalShell';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Pill } from '@/components/shared/Pill';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { ScopeProgressCard, buildScopeFromSliceRun, buildScopeFromMilestoneBreakdown, ScopeGroupedView } from '@/components/shared/ScopeProgressCard';
import { ArtifactGallery } from './ArtifactGallery';
import { MetricRow } from '@/components/shared/MetricRow';
import { formatRelativeTime } from '@/lib/time';
import { sanitizeDisplayText, humanizeStopReason, humanizeLaneState } from '@/lib/humanize';
import { dedupeSliceSections, synthesizeOutcome } from '@/lib/suppress-unknown-fields';
import { colors, motion as motionTokens } from '@/lib/tokens';
import { queueAccentStyle, queueStateDotColor, workSnapshotHeading } from '@/lib/queueStateMap';
import { projectRunStatus } from '@/lib/runStatusModel';
import type { Initiative, NextUpQueueItem, SliceRunProjection } from '@/types';
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
  onAcceptSlice?: (sliceRun: SliceRunProjection, note?: string) => void;
  onRejectSlice?: (sliceRun: SliceRunProjection, note: string) => void;
  initiatives?: Initiative[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Queue state UI mappings imported from @/lib/queueStateMap

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
      milestoneBreakdown: item.milestoneBreakdown ?? null,
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
      milestoneBreakdown: null as NextUpQueueItem['milestoneBreakdown'] | null,
      sliceRun: sliceRun,
      sessionId: row.session?.id ?? null,
      runId: row.runId,
    };
  }

  // needs_input
  const { sliceRun } = target;
  const agentName = sliceRun.sourceClient
    ? sliceRun.sourceClient.charAt(0).toUpperCase() + sliceRun.sourceClient.slice(1)
    : 'OrgX';
  return {
    initiativeId: sliceRun.initiativeId,
    // SliceRunProjection doesn't carry initiativeTitle; rely on scope/breadcrumb
    // context from the parent. The ScopeProgressCard will fall back to shortId.
    initiativeTitle: null as string | null,
    initiativeStatus: null as string | null,
    workstreamId: sliceRun.workstreamId,
    workstreamTitle: sliceRun.workstreamTitle ? sanitizeDisplayText(sliceRun.workstreamTitle) : 'Work slice',
    workstreamStatus: sliceRun.status,
    nextTaskTitle: null as string | null,
    nextTaskPriority: null as number | null,
    nextTaskDueAt: null as string | null,
    agentId: null as string | null,
    agentName,
    agentSource: sliceRun.sourceClient,
    queueState: sliceRun.status === 'needs_review' ? 'completed' : 'blocked' as string,
    blockReason: sliceRun.status === 'failed' ? (sliceRun.statusExplainer || null) : null,
    sliceScope: sliceRun.scope ?? null,
    sliceTaskCount:
      typeof sliceRun.scopeProgress?.totalTasks === 'number'
        ? Math.max(
            0,
            Math.floor(sliceRun.scopeProgress.totalTasks - sliceRun.scopeProgress.completedTasks)
          )
        : sliceRun.taskIds?.length ?? null,
    autoContinue: null as NextUpQueueItem['autoContinue'] | null,
    milestoneBreakdown: null as NextUpQueueItem['milestoneBreakdown'] | null,
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
  onRejectSlice,
  initiatives = [],
}: SliceDetailModalProps) {
  const open = target !== null;
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<'accept' | 'reject' | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

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
    if (!open) {
      setTerminalError(null);
      setIsOpeningTerminal(false);
      setActionMode(null);
      setActionNote('');
      setActionFeedback(null);
    }
  }, [open]);

  // Auto-focus note textarea when action mode is set — use rAF to beat Modal's focus trap
  useEffect(() => {
    if (actionMode) {
      requestAnimationFrame(() => {
        noteRef.current?.focus();
      });
    }
  }, [actionMode]);


  const initiativeTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const init of initiatives) {
      if (init.id) map.set(init.id, init.name ?? init.id);
    }
    return map;
  }, [initiatives]);

  if (!target) return null;

  const d = extractData(target);
  // Resolve initiative title from initiatives prop when extractData couldn't find one
  if (!d.initiativeTitle && d.initiativeId) {
    d.initiativeTitle = initiativeTitleById.get(d.initiativeId) ?? null;
  }
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

  const highlightedButton: 'resolve_decision' | 'review' | 'start' | null = (() => {
    const action = sr?.primaryAction ?? null;
    if (!action || action === 'none') return null;
    if (action === 'resolve_decision') return 'resolve_decision';
    if (action === 'open_artifact' || action === 'review_output') return 'review';
    if (action === 'retry_slice') return 'start';
    return null;
  })();
  const highlightRing = 'ring-1 ring-lime/40 shadow-[0_0_8px_rgba(191,255,0,0.15)]';

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

  // Compute terminal target once — avoids duplicate buttons
  const terminalTarget = useMemo(() => {
    if (d.sessionId) return { sessionId: d.sessionId, runId: d.runId, sliceRunId: sr?.sliceRunId ?? null };
    if (sr?.runId || sr?.sliceRunId) return { runId: sr.runId ?? null, sliceRunId: sr.sliceRunId ?? null };
    if (d.runId) return { runId: d.runId, sliceRunId: sr?.sliceRunId ?? null };
    return null;
  }, [d.sessionId, d.runId, sr]);

  const hasTerminal = terminalTarget !== null;

  const scopeNodes = useMemo(() => {
    if (sr?.scopeProgress) {
      return buildScopeFromSliceRun({
        initiativeId: d.initiativeId,
        initiativeTitle: d.initiativeTitle,
        workstreamId: d.workstreamId,
        workstreamTitle: d.workstreamTitle,
        taskIds: sr?.taskIds,
        milestoneIds: sr?.milestoneIds,
        scopeProgress: sr.scopeProgress,
        status: sr?.status ?? d.queueState,
        agentName: d.agentName,
        agentId: d.agentId,
      });
    }
    if (d.milestoneBreakdown && d.milestoneBreakdown.length > 0) {
      return buildScopeFromMilestoneBreakdown(d.milestoneBreakdown);
    }
    return buildScopeFromSliceRun({
      initiativeId: d.initiativeId,
      initiativeTitle: d.initiativeTitle,
      workstreamId: d.workstreamId,
      workstreamTitle: d.workstreamTitle,
      taskIds: sr?.taskIds,
      milestoneIds: sr?.milestoneIds,
      scopeProgress: null,
      status: sr?.status ?? d.queueState,
      agentName: d.agentName,
      agentId: d.agentId,
    });
  }, [d.initiativeId, d.initiativeTitle, d.workstreamId, d.workstreamTitle, sr, d.queueState, d.agentName, d.agentId, d.milestoneBreakdown]);

  const isNeedsReview = target.source === 'needs_input' && sr?.status === 'needs_review';

  const handleConfirmAction = useCallback(async () => {
    if (!sr || !actionMode) return;
    const note = actionNote.trim();
    const runId = sr.runId ?? sr.sliceRunId;

    if (actionMode === 'accept') {
      try {
        setActionFeedback('Accepting…');
        const reason = note ? `Accepted: ${note}` : 'Accepted from dashboard';
        const response = await fetch(
          `/orgx/api/runs/${encodeURIComponent(runId)}/actions/complete`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
          setActionFeedback(`Error: ${body?.error ?? body?.message ?? response.status}`);
          return;
        }
        setActionFeedback('Accepted!');
        try { onAcceptSlice?.(sr, note || undefined); } catch { /* ignore */ }
        setTimeout(() => onClose(), 600);
      } catch (err) {
        setActionFeedback(`Failed: ${err instanceof Error ? err.message : 'network error'}`);
      }
    } else if (actionMode === 'reject' && note) {
      try {
        setActionFeedback('Sending feedback…');
        const response = await fetch(
          `/orgx/api/entities/run/${encodeURIComponent(runId)}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: note, commentType: 'review_feedback', severity: 'warn', tags: ['changes_requested'] }),
          }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
          setActionFeedback(`Error: ${body?.error ?? body?.message ?? response.status}`);
          return;
        }
        setActionFeedback('Feedback sent!');
        try { onRejectSlice?.(sr, note); } catch { /* ignore */ }
        setActionMode(null);
        setActionNote('');
      } catch (err) {
        setActionFeedback(`Failed: ${err instanceof Error ? err.message : 'network error'}`);
      }
    }
  }, [sr, actionMode, actionNote, onAcceptSlice, onRejectSlice, onClose]);

  const footer = (
    <div className="space-y-2">
      {/* Action feedback inline indicator */}
      {actionFeedback && (
        <div className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium ${
          actionFeedback.startsWith('Error') || actionFeedback.startsWith('Failed')
            ? 'bg-[#FF6B88]/10 text-[#FF6B88]'
            : actionFeedback.includes('…')
              ? 'bg-white/[0.04] text-white/60 animate-pulse'
              : 'bg-lime/10 text-lime'
        }`}>
          {actionFeedback}
        </div>
      )}
      {/* Note textarea — expands when accept/reject mode is active */}
      <AnimatePresence>
        {actionMode && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pb-2">
              <textarea
                ref={noteRef}
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleConfirmAction();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setActionMode(null);
                    setActionNote('');
                  }
                }}
                placeholder={actionMode === 'accept' ? 'Optional note...' : 'What needs to change?'}
                className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[13px] text-white/80 outline-none placeholder:text-white/25 focus:border-white/15 transition-colors"
                rows={2}
              />
              <div className="mt-1.5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => { setActionMode(null); setActionNote(''); }}
                  className="text-[11px] text-white/30 transition-colors hover:text-white/50"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-micro text-white/20">
                    {actionMode === 'reject' && !actionNote.trim() ? 'Note required' : '\u2318Enter to confirm'}
                  </span>
                  <button
                    type="button"
                    onClick={handleConfirmAction}
                    disabled={actionMode === 'reject' && !actionNote.trim()}
                    className={`inline-flex h-7 items-center gap-1 rounded-md px-3 text-[11px] font-semibold transition-colors disabled:opacity-30 ${
                      actionMode === 'accept'
                        ? 'bg-lime/12 text-lime hover:bg-lime/20'
                        : 'bg-[#FF6B88]/12 text-[#FF6B88] hover:bg-[#FF6B88]/20'
                    }`}
                  >
                    {actionMode === 'accept' ? 'Confirm accept' : 'Request changes'}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Action buttons row */}
      <div className="flex items-center gap-3">
        {/* ── Left: secondary actions ── */}
        <div className="flex items-center gap-1">
          {target.source === 'queue' && d.initiativeId && d.workstreamId && (
            <>
              <button
                type="button"
                onClick={() => { onRemoveFromQueue?.(d.initiativeId!, d.workstreamId!); onClose(); }}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[#FF6B88]/70 transition-colors hover:bg-[#FF6B88]/[0.08] hover:text-[#FF6B88]"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={() => onMoveWorkstream?.(d.initiativeId!, d.workstreamId!, 'top')}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/60"
              >
                Move top
              </button>
            </>
          )}

          {target.source === 'in_progress' && d.sessionId && (
            <button
              type="button"
              onClick={() => { onOpenSession?.(d.sessionId!); onClose(); }}
              className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/60"
            >
              Open session
            </button>
          )}

          {target.source === 'needs_input' && sr && sr.primaryAction === 'resolve_decision' && (
            <button
              type="button"
              onClick={() => { onOpenDecisions?.(); onClose(); }}
              className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[#0AD4C4]/70 transition-colors hover:bg-[#0AD4C4]/[0.08] hover:text-[#0AD4C4] ${highlightedButton === 'resolve_decision' ? highlightRing : ''}`}
            >
              Resolve decision
            </button>
          )}

          {target.source === 'needs_input' && sr && (
            <button
              type="button"
              onClick={() => { onReviewActivity?.(sr); onClose(); }}
              className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/60 ${highlightedButton === 'review' ? highlightRing : ''}`}
            >
              Review
            </button>
          )}

          {d.runId && (
            <button
              type="button"
              onClick={() => { onFocusRunId?.(d.runId!); onClose(); }}
              className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/60"
            >
              Timeline
            </button>
          )}

        </div>

        <div className="flex-1" />

        {/* ── Right: primary CTAs ── */}
        <div className="flex items-center gap-1.5">
          {isNeedsReview && onRejectSlice && (
            <button
              type="button"
              onClick={() => setActionMode(actionMode === 'reject' ? null : 'reject')}
              className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                actionMode === 'reject'
                  ? 'bg-[#FF6B88]/12 text-[#FF6B88]'
                  : 'text-white/35 hover:bg-white/[0.04] hover:text-white/60'
              }`}
            >
              Request changes
            </button>
          )}
          {isNeedsReview && onAcceptSlice && (
            <button
              type="button"
              onClick={() => {
                if (actionMode === 'accept') {
                  handleConfirmAction();
                } else {
                  setActionMode('accept');
                }
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-lime/12 px-4 text-[12px] font-semibold text-lime transition-colors hover:bg-lime/20"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Accept
            </button>
          )}
          {canStart && (
            <button
              type="button"
              data-modal-autofocus="true"
              onClick={() => {
                onPlayWorkstream?.(d.initiativeId!, d.workstreamId!, d.agentId ?? undefined);
                onClose();
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-lime/25 bg-lime/10 px-4 text-[12px] font-semibold text-lime transition-colors hover:bg-lime/20 ${highlightedButton === 'start' ? 'ring-1 ring-lime/50 shadow-[0_0_10px_rgba(191,255,0,0.2)]' : ''}`}
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
          {hasTerminal && (
            <button
              type="button"
              onClick={() => void handleOpenTerminal(terminalTarget!)}
              disabled={isOpeningTerminal}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/50 disabled:opacity-40"
              title="Open in terminal"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          )}
        </div>
      </div>
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
                hint={d.agentSource ?? d.agentId}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-display font-medium leading-none text-white truncate">
                  {d.workstreamTitle}
                </h3>
                {d.initiativeTitle && (
                  <p className="mt-1 text-micro uppercase tracking-[0.08em] text-muted">
                    {d.initiativeTitle}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-[0.08em] ${canonicalStatusClass}`}
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
                  {sr?.confidence && (
                    <span className={`chip text-[9px] font-semibold ${
                      sr.confidence === 'high' ? 'border-lime/30 bg-lime/[0.12] text-lime'
                      : sr.confidence === 'medium' ? 'border-[#F5B700]/30 bg-[#F5B700]/[0.12] text-[#FFE7A8]'
                      : 'border-white/[0.12] bg-white/[0.05] text-white/60'
                    }`}>
                      {sr.confidence}
                    </span>
                  )}
                </div>
                {sr?.statusExplainer && target.source !== 'needs_input' && (
                  <p className="mt-2 text-body text-secondary">{sr.statusExplainer}</p>
                )}
              </div>
            </motion.div>

            {/* Metrics — suppress zero counts */}
            {sr && (
              <MetricRow
                metrics={[
                  ...(sr.startedAt ? [{
                    label: 'Duration',
                    value: (() => {
                      const end = sr.completedAt ?? sr.failedAt ?? sr.updatedAt ?? new Date().toISOString();
                      const ms = Date.parse(end) - Date.parse(sr.startedAt!);
                      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
                      if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
                      return `${(ms / 3_600_000).toFixed(1)}h`;
                    })(),
                  }] : []),
                  ...(sr.artifactCount > 0 ? [{ label: 'Artifacts', value: sr.artifactCount, color: colors.teal }] : []),
                  ...(sr.decisionCount > 0 ? [{ label: 'Decisions', value: sr.decisionCount, color: colors.amber }] : []),
                ]}
                className="pb-4 border-b border-white/[0.04]"
              />
            )}

            {/* Artifact gallery */}
            {sr && sr.artifacts.length > 0 && (
              <ArtifactGallery artifacts={sr.artifacts} />
            )}

            <SectionDivider />

            {target.source === 'needs_input' && sr ? (() => {
              // B1: Deduplicate sections — suppress repeated content
              const deduped = dedupeSliceSections({
                statusExplainer: sr.statusExplainer,
                summary: d.blockReason,
                lastEventSummary: sr.lastEventSummary,
              });
              // B2: Outcome synthesis — richer explanation from structured data
              const synthesized = synthesizeOutcome({
                lifecycleState: sr.status,
                artifactCount: sr.artifactCount,
                artifacts: sr.artifacts.map(a => ({ title: a.title, type: a.type ?? 'unknown' })),
                statusExplainer: sr.statusExplainer,
                confidence: sr.confidence,
              });
              const outcomeText = synthesized ?? deduped.outcome;
              return (
                <>
                  {/* Action card */}
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
                      <p className="mt-1 text-caption text-lime/70 flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="9 18 15 12 9 6" /></svg>
                        Recommended action: {nextActionLabel}
                      </p>
                    ) : null}
                  </motion.div>

                  {/* Outcome — synthesized or deduplicated */}
                  {outcomeText && (
                    <motion.div
                      variants={sectionVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      custom={sectionIndex++}
                    >
                      <p className="section-kicker">Outcome</p>
                      <p className="mt-1 text-body text-secondary leading-relaxed">
                        {sanitizeDisplayText(outcomeText)}
                      </p>
                    </motion.div>
                  )}

                  {/* Last activity — only if it adds NEW information */}
                  {deduped.lastActivity && (
                    <motion.div
                      variants={sectionVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      custom={sectionIndex++}
                    >
                      <p className="section-kicker">Last activity</p>
                      <p className="mt-1 text-caption text-white/50 leading-relaxed">
                        {sanitizeDisplayText(deduped.lastActivity)}
                      </p>
                    </motion.div>
                  )}

                  <SectionDivider />
                </>
              );
            })() : null}

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

            {/* ───── 3. Scope & Progress ───── */}
            {scopeNodes.length > 0 && (
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
                  <p className="section-kicker">{workSnapshotHeading(d.queueState, isNeedsReview)}</p>
                  <ScopeGroupedView nodes={scopeNodes} />
                  <div className="flex items-center gap-2">
                    {d.nextTaskPriority !== null && priorityLabel(d.nextTaskPriority) && (
                      <span
                        className="inline-flex rounded-full border px-2 py-0.5 text-micro font-semibold"
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
            {/* Fallback: inline metadata when no scope tree */}
            {scopeNodes.length === 0 && (d.nextTaskTitle || d.sliceTaskCount !== null || d.sliceScope) && (
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
                  <p className="section-kicker">{workSnapshotHeading(d.queueState, isNeedsReview)}</p>
                  {d.nextTaskTitle && (
                    <div className="flex items-start gap-2">
                      <EntityIcon type="task" size={14} className="mt-[2px] flex-shrink-0 opacity-80" />
                      <p className="text-body font-semibold leading-snug text-white">{d.nextTaskTitle}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {d.sliceScope ? (
                      <span className="inline-flex rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                        {d.sliceScope} slice
                      </span>
                    ) : null}
                    {typeof d.sliceTaskCount === 'number' ? (
                      <span className="inline-flex rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                        {d.sliceTaskCount} {d.sliceTaskCount === 1 ? 'task' : 'tasks'} in scope
                      </span>
                    ) : null}
                    {d.nextTaskPriority !== null && priorityLabel(d.nextTaskPriority) && (
                      <span
                        className="inline-flex rounded-full border px-2 py-0.5 text-micro font-semibold"
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

            {/* Section 4b removed — scope hierarchy now rendered by ScopeProgressCard above */}

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

            {/* ───── 7. Notes & Discussion ───── */}
            {sr && (sr.sliceRunId || sr.runId) && (
              <>
                <SectionDivider />
                <motion.div
                  variants={sectionVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  custom={sectionIndex++}
                >
                  <p className="section-kicker mb-2">Notes</p>
                  <EntityCommentsPanel
                    entityType="run"
                    entityId={sr.runId ?? sr.sliceRunId}
                    variant="inline"
                  />
                </motion.div>
              </>
            )}

            {/* ───── 8. Technical details (collapsed by default) ───── */}
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

          </div>
        </ModalShell>
      </div>
    </Modal>
  );
}
