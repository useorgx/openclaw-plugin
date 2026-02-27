import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Skeleton } from '@/components/shared/Skeleton';
import { InlineToast } from '@/components/shared/InlineToast';
import { openBillingPortal, openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { humanizeId, humanizeWarning, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { useNextUpQueue, type NextUpQueueItem, type UseNextUpQueueResult, type ZoomLevel, type InitiativeGroupItem, type MilestoneGroupItem } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import { useAutoContinue } from '@/hooks/useAutoContinue';
import type { NextUpQueueBulkAction } from '@/types';

type UseNextUpQueueActionsResult = ReturnType<typeof useNextUpQueueActions>;

interface NextUpPanelProps {
  initiativeId?: string | null;
  projectId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  title?: string;
  showHeader?: boolean;
  compact?: boolean;
  className?: string;
  disableEnterAnimation?: boolean;
  allowCompactToggle?: boolean;
  onToggleCompact?: (compact: boolean) => void;
  onOpenInitiative?: (initiativeId: string, initiativeTitle?: string) => void;
  onOpenSettings?: () => void;
  onUpgradeGate?: (gate: UpgradeRequiredError | null) => void;
  onOpenSliceDetail?: (item: NextUpQueueItem) => void;
  selectionEnabled?: boolean;
  panelStyle?: 'card' | 'flat';
  showQueueSettings?: boolean;
  queueModel?: UseNextUpQueueResult;
  queueActions?: UseNextUpQueueActionsResult;
  snapshotVersion?: number | null;
}

interface ActionGlyphProps {
  className?: string;
}

type QueuePlacement = 'top' | 'bottom';

function PlayGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={className}
    >
      <path d="M7 5.4v9.2c0 .7.75 1.15 1.38.83l7.6-4.6a.95.95 0 0 0 0-1.62l-7.6-4.64A.95.95 0 0 0 7 5.4Z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <rect x="5.5" y="5" width="3.2" height="10" rx="1" fill="currentColor" />
      <rect x="11.3" y="5" width="3.2" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function AutoGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M6.1 13.25C4.25 13.25 2.8 11.8 2.8 10s1.45-3.25 3.3-3.25c3.15 0 4.35 6.5 8.05 6.5 1.85 0 3.3-1.45 3.3-3.25s-1.45-3.25-3.3-3.25c-3.7 0-4.9 6.5-8.05 6.5Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandOpenGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M6.2 9.4V6.7c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v2.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M8.4 8.9V5.8c0-.7.5-1.3 1.1-1.3s1.1.6 1.1 1.3v3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10.6 8.9V6.2c0-.7.5-1.3 1.1-1.3s1.1.6 1.1 1.3v3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M12.8 9.6V7.2c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v4.2c0 2.7-1.9 4.6-4.6 4.6H9.2c-2.1 0-3.7-1-4.6-2.8l-.9-1.7c-.3-.6 0-1.4.6-1.7.6-.3 1.3 0 1.6.6l.7 1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandGrabGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M6.4 9.2V7.4c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v1.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M8.6 8.9V7c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10.8 9.2V7.3c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M13 9.8V8.2c0-.7.5-1.2 1.1-1.2s1.1.5 1.1 1.2v3.6c0 2.4-1.7 4-4.1 4H9.7c-2 0-3.4-.9-4.2-2.5l-.8-1.4c-.3-.6 0-1.3.5-1.6.6-.3 1.2-.1 1.6.5l.6 1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ZOOM_LEVELS: Array<{ value: ZoomLevel; label: string }> = [
  { value: 'initiative', label: 'Initiative' },
  { value: 'workstream', label: 'Workstream' },
  { value: 'milestone', label: 'Milestone' },
];

function ZoomLevelToggle({
  value,
  onChange,
}: {
  value: ZoomLevel;
  onChange: (level: ZoomLevel) => void;
}) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-white/5 border border-white/[0.08]">
      {ZOOM_LEVELS.map((level) => (
        <button
          key={level.value}
          type="button"
          onClick={() => onChange(level.value)}
          className={cn(
            'px-3 py-1 text-[11px] font-medium rounded-md transition-all duration-150',
            value === level.value
              ? 'bg-white/10 text-white shadow-[inset_0_0_8px_rgba(191,255,0,0.08)]'
              : 'text-white/50 hover:text-white/70'
          )}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}

function queueTone(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'border-teal-300/35 bg-teal-400/[0.12] text-teal-100';
  if (queueState === 'blocked') return 'border-amber-300/35 bg-amber-400/[0.12] text-amber-100';
  if (queueState === 'idle') return 'border-strong bg-white/[0.05] text-secondary';
  return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
}

function queueLabel(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'Running';
  if (queueState === 'blocked') return 'Needs input';
  if (queueState === 'idle') return 'Idle';
  return 'Queued';
}

function queueStateRank(queueState: NextUpQueueItem['queueState']): number {
  if (queueState === 'queued' || queueState === 'idle') return 0;
  if (queueState === 'blocked') return 1;
  if (queueState === 'running') return 2;
  if (queueState === 'completed') return 3;
  return 4;
}

function queueHighlight(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'from-teal-300/0 via-teal-300/60 to-teal-300/0';
  if (queueState === 'blocked') return 'from-amber-300/0 via-amber-300/55 to-amber-300/0';
  if (queueState === 'idle') return 'from-white/0 via-white/35 to-white/0';
  return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
}

function queueTaskHeading(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'Current';
  if (queueState === 'blocked') return 'Blocked on';
  return 'Next';
}

function queueTaskFallback(item: NextUpQueueItem): string {
  const sliceCount =
    typeof item.sliceTaskCount === 'number' && Number.isFinite(item.sliceTaskCount)
      ? Math.max(0, Math.floor(item.sliceTaskCount))
      : null;
  const scopeLabel =
    item.sliceScope === 'task'
      ? 'task'
      : item.sliceScope === 'milestone'
        ? 'milestone slice'
        : 'workstream slice';
  const sliceCountLabel =
    sliceCount && sliceCount > 0
      ? `${sliceCount} ${sliceCount === 1 ? 'task' : 'tasks'}`
      : null;

  if (item.queueState === 'running') {
    return sliceCountLabel
      ? `Executing ${sliceCountLabel} in ${scopeLabel}.`
      : 'Execution in progress. Task detail will appear as the scheduler advances.';
  }
  if (item.queueState === 'blocked') {
    return item.blockReason
      ? 'Blocked while waiting for dependency resolution.'
      : 'Blocked. Waiting for dependency or review.';
  }
  if (item.queueState === 'queued') {
    return sliceCountLabel
      ? `Queued with ${sliceCountLabel} in ${scopeLabel}.`
      : 'Queued at workstream scope. Task detail will populate after dispatch.';
  }
  if (item.queueState === 'completed') {
    return 'Completed. No queued tasks remain.';
  }
  return 'Idle. Ready to dispatch when started.';
}

function toInitiativePriorityLabel(item: NextUpQueueItem): {
  shortLabel: string;
  longLabel: string;
  toneClass: string;
} | null {
  const rawLabel = typeof item.initiativePriority === 'string'
    ? item.initiativePriority.trim().toLowerCase()
    : '';
  const rawNum =
    typeof item.initiativePriorityNum === 'number' && Number.isFinite(item.initiativePriorityNum)
      ? Math.max(1, Math.min(100, Math.round(item.initiativePriorityNum)))
      : null;

  const normalized =
    rawLabel === 'urgent' || rawLabel === 'high' || rawLabel === 'medium' || rawLabel === 'low'
      ? rawLabel
      : rawNum !== null
        ? rawNum <= 12
          ? 'urgent'
          : rawNum <= 30
            ? 'high'
            : rawNum <= 60
              ? 'medium'
              : 'low'
        : null;

  if (!normalized) return null;

  const pLevel =
    normalized === 'urgent' ? 'P1' : normalized === 'high' ? 'P2' : normalized === 'medium' ? 'P3' : 'P4';
  const titleCase =
    normalized === 'urgent' ? 'Urgent' : normalized === 'high' ? 'High' : normalized === 'medium' ? 'Medium' : 'Low';

  const toneClass =
    normalized === 'urgent'
      ? 'border-red-300/35 bg-red-500/[0.14] text-red-100'
      : normalized === 'high'
        ? 'border-amber-300/35 bg-amber-500/[0.14] text-amber-100'
        : normalized === 'medium'
          ? 'border-[#BFFF00]/35 bg-[#BFFF00]/14 text-[#E1FFB2]'
          : 'border-white/[0.2] bg-white/[0.08] text-white/70';

  return {
    shortLabel: `${pLevel} ${titleCase}`,
    longLabel: `Initiative priority ${titleCase} (${pLevel})`,
    toneClass,
  };
}

function formatQueueErrorMessage(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('signal is aborted')
  ) {
    return 'Next Up is still syncing. Keep this panel open and it will repopulate automatically.';
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('api key') ||
    normalized.includes('auth')
  ) {
    return 'Next Up is unavailable until OrgX authentication is reconnected in Settings.';
  }
  if (
    normalized.includes('unknown api endpoint') ||
    normalized.includes('route is unavailable')
  ) {
    return 'This runtime is missing queue routes. Restart and update the plugin build.';
  }
  const compact = raw
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^[^:]+:\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return humanizeWarning(compact || raw) || 'Next Up is temporarily unavailable.';
}

function formatQueueDegradedMessage(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('signal is aborted')
  ) {
    return 'Signal is delayed right now. Queue data will appear as soon as sync catches up.';
  }
  if (normalized.includes('fallback')) {
    return 'Showing fallback queue data while full signal refreshes.';
  }
  if (
    normalized.includes('unknown api endpoint') ||
    normalized.includes('route is unavailable')
  ) {
    return 'Some queue controls are unavailable in this plugin build. Update and restart to restore full controls.';
  }
  return humanizeWarning(raw.trim());
}

function resolveEntityLabel(
  title: string | null | undefined,
  fallbackId: string | null | undefined,
  prefix: string
): string {
  const preferred = typeof title === 'string' ? title.trim() : '';
  if (preferred && !isOpaqueId(preferred)) {
    return sanitizeDisplayText(preferred);
  }

  const fallback = typeof fallbackId === 'string' ? fallbackId.trim() : '';
  if (fallback) {
    if (isOpaqueId(fallback)) return `${prefix} ${humanizeId(fallback)}`;
    return sanitizeDisplayText(fallback);
  }
  return prefix;
}

function resolveRunnerName(item: NextUpQueueItem): string {
  const raw = typeof item.runnerAgentName === 'string' ? item.runnerAgentName.trim() : '';
  if (!raw) return 'Unassigned';
  const normalized = raw.toLowerCase();
  if (normalized === 'undefined' || normalized === 'null') return 'Unassigned';
  if (
    normalized === 'main' &&
    (item.runnerAgentId === 'unassigned' || item.runnerSource === 'fallback')
  ) {
    return 'Unassigned';
  }
  return raw;
}

function resolveRunnerSourceBadge(item: NextUpQueueItem): string | null {
  if (item.runnerSource === 'inferred') return 'inferred';
  return null;
}

function resolveRunnerHint(item: NextUpQueueItem, runnerName: string): string {
  const source =
    item.runnerSource === 'assigned'
      ? 'assigned'
      : item.runnerSource === 'inferred'
        ? 'inferred'
        : 'fallback';
  if (runnerName === 'Unassigned') {
    return `Runner ${source}`;
  }
  return `${runnerName} · ${source}`;
}

function formatQueueActionError(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const message = humanizeWarning(raw.trim());
  return message || fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function playDispatchNotice(item: NextUpQueueItem, payload: unknown): string {
  const workstreamLabel = sanitizeDisplayText(item.workstreamTitle);
  const record = asRecord(payload);
  const dispatchMode =
    record && typeof record.dispatchMode === 'string' ? record.dispatchMode : null;
  const run = asRecord(record?.run);
  const stopReason =
    run && typeof run.stopReason === 'string'
      ? run.stopReason
      : run && typeof run.stop_reason === 'string'
        ? run.stop_reason
        : null;

  if (stopReason === 'budget_exhausted') {
    return `Dispatch acknowledged for ${workstreamLabel}, but autopilot stopped: budget exhausted.`;
  }
  if (dispatchMode === 'pending') {
    return `Dispatching ${workstreamLabel}; waiting for slice start…`;
  }
  if (dispatchMode === 'fallback') {
    return `Dispatched ${workstreamLabel} using fallback runner.`;
  }
  return `Dispatched ${workstreamLabel}.`;
}

function nextUpClearNotice(payload: unknown, defaultCount: number): string {
  const record = asRecord(payload);
  const queueItemsCleared =
    record && typeof record.queueItemsCleared === 'number'
      ? record.queueItemsCleared
      : defaultCount;
  const tasksReset =
    record && typeof record.tasksReset === 'number' ? record.tasksReset : null;
  if (typeof tasksReset === 'number') {
    return `Cleared ${queueItemsCleared} queue item${queueItemsCleared === 1 ? '' : 's'} and reset ${tasksReset} task${tasksReset === 1 ? '' : 's'} to todo.`;
  }
  return `Cleared ${queueItemsCleared} queue item${queueItemsCleared === 1 ? '' : 's'}.`;
}

function MoreGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <circle cx="4.5" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15.5" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}

function NextUpLoadingSkeleton({ compact }: { compact: boolean }) {
  const cards = compact ? 3 : 6;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 px-1 pt-1 text-micro uppercase tracking-[0.12em] text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-[#BFFF00]/70 status-breathe" />
        <span>Calibrating queue</span>
      </div>
      {Array.from({ length: cards }).map((_, index) => (
        <div
          key={`nextup-skeleton-${index}`}
          className="nextup-skeleton-card rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
        >
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3 w-40 rounded-md" />
                <Skeleton className="mt-2 h-4 w-56 rounded-md" />
              </div>
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>

          <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2">
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className="mt-2 h-3 w-full rounded" />
            <Skeleton className="mt-2 h-3 w-3/5 rounded" />
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-20 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function NextUpPanel({
  initiativeId = null,
  projectId = null,
  authToken = null,
  embedMode = false,
  title = 'Next Up',
  showHeader = true,
  compact = false,
  className,
  disableEnterAnimation = false,
  allowCompactToggle = false,
  onToggleCompact,
  onOpenInitiative,
  onOpenSettings,
  onUpgradeGate,
  onOpenSliceDetail,
  selectionEnabled = true,
  panelStyle = 'card',
  showQueueSettings = true,
  queueModel,
  queueActions,
  snapshotVersion = null,
}: NextUpPanelProps) {
  const [localCompact, setLocalCompact] = useState(compact);
  useEffect(() => setLocalCompact(compact), [compact]);
  const isCompact = allowCompactToggle && !onToggleCompact ? localCompact : compact;
  const setCompact = (next: boolean) => {
    if (onToggleCompact) onToggleCompact(next);
    else setLocalCompact(next);
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('workstream');
  const [launchFeedback, setLaunchFeedback] = useState<string | null>(null);
  const triagePlacement: QueuePlacement = 'bottom';
  const [upgradeGate, setUpgradeGate] = useState<UpgradeRequiredError | null>(
    null
  );
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
  const [queueSettingsOpen, setQueueSettingsOpen] = useState(false);
  const [signalToastHidden, setSignalToastHidden] = useState(false);
  const queueSettingsRef = useRef<HTMLDivElement | null>(null);
  const internalQueue = useNextUpQueue({
    initiativeId,
    projectId,
    authToken,
    embedMode,
    enabled: queueModel ? false : true,
    snapshotVersion,
    zoomLevel,
  });
  const queue = queueModel ?? internalQueue;
  const {
    items,
    degraded,
    isLoading,
    isFetching,
    error,
    refetch,
    playWorkstream,
    startWorkstreamAutoContinue,
    initiativeGroups,
    milestoneGroups,
  } = queue;

  const autoContinue = useAutoContinue({
    initiativeId,
    authToken,
    embedMode,
    enabled: Boolean(initiativeId),
  });

  const internalNextUpActions = useNextUpQueueActions({ authToken, embedMode });
  const nextUpActions = queueActions ?? internalNextUpActions;
  const itemKey = (item: NextUpQueueItem) => `${item.initiativeId}:${item.workstreamId}`;
  const isWorkstreamView = zoomLevel === 'workstream';
  const activeElsewhereCount = useMemo(
    () => items.filter((item) => item.queueState === 'running').length,
    [items]
  );
  // Show all items except those actively running a session. Blocked items
  // stay visible because they need user attention. If nothing remains,
  // fall back to showing running items so the panel isn't empty.
  const queueItems = useMemo(
    () => {
      const actionable = items.filter((item) => item.queueState !== 'running');
      if (actionable.length > 0) return actionable;
      return items;
    },
    [items]
  );
  const queueDisplayMode = useMemo<'queued' | 'blocked' | 'running' | 'empty'>(() => {
    if (queueItems.length === 0) return 'empty';
    if (queueItems.some((item) => item.queueState !== 'running' && item.queueState !== 'blocked')) {
      return 'queued';
    }
    if (queueItems.some((item) => item.queueState === 'blocked')) return 'blocked';
    if (queueItems.some((item) => item.queueState === 'running')) return 'running';
    return 'queued';
  }, [queueItems]);

  const sortedInitiativeGroups = useMemo(
    () =>
      [...initiativeGroups].sort((left, right) => {
        const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
        if (queueDelta !== 0) return queueDelta;
        return left.initiativeTitle.localeCompare(right.initiativeTitle);
      }),
    [initiativeGroups]
  );

  const sortedMilestoneGroups = useMemo(
    () =>
      [...milestoneGroups].sort((left, right) => {
        const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
        if (queueDelta !== 0) return queueDelta;
        const initiativeDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
        if (initiativeDelta !== 0) return initiativeDelta;
        const workstreamDelta = left.workstreamTitle.localeCompare(right.workstreamTitle);
        if (workstreamDelta !== 0) return workstreamDelta;
        return left.milestoneTitle.localeCompare(right.milestoneTitle);
      }),
    [milestoneGroups]
  );

  const visibleInitiativeGroups = useMemo(
    () => (isCompact ? sortedInitiativeGroups.slice(0, 5) : sortedInitiativeGroups),
    [isCompact, sortedInitiativeGroups]
  );

  const visibleMilestoneGroups = useMemo(
    () => (isCompact ? sortedMilestoneGroups.slice(0, 5) : sortedMilestoneGroups),
    [isCompact, sortedMilestoneGroups]
  );

  const displayCount = useMemo(() => {
    if (zoomLevel === 'initiative') return sortedInitiativeGroups.length;
    if (zoomLevel === 'milestone') return sortedMilestoneGroups.length;
    return queueItems.length;
  }, [queueItems.length, sortedInitiativeGroups.length, sortedMilestoneGroups.length, zoomLevel]);

  const visibleItems = useMemo(
    () => (isWorkstreamView ? (isCompact ? queueItems.slice(0, 5) : queueItems) : []),
    [isCompact, isWorkstreamView, queueItems]
  );
  const visibleSelection = useMemo(
    () => visibleItems.filter((item) => selectedKeys.has(itemKey(item))),
    [selectedKeys, visibleItems]
  );
  const [orderedKeys, setOrderedKeys] = useState<string[]>([]);
  const orderedKeysRef = useRef<string[]>([]);
  const itemByKey = useMemo(() => {
    const map = new Map<string, NextUpQueueItem>();
    for (const item of visibleItems) map.set(itemKey(item), item);
    return map;
  }, [visibleItems]);

  const visibleKeys = useMemo(() => visibleItems.map(itemKey), [visibleItems]);
  const visibleKeysSignature = useMemo(() => visibleKeys.join('|'), [visibleKeys]);

  useEffect(() => {
    setOrderedKeys((previous) => {
      if (isCompact) return [];
      const next: string[] = [];
      const incoming = new Set(visibleKeys);
      for (const key of previous) {
        if (incoming.has(key)) next.push(key);
      }
      for (const key of visibleKeys) {
        if (!next.includes(key)) next.push(key);
      }
      return next;
    });
  }, [isCompact, visibleKeysSignature]);

  useEffect(() => {
    orderedKeysRef.current = orderedKeys;
  }, [orderedKeys]);

  useEffect(() => {
    if (!selectionAnchorKey) return;
    if (!visibleKeys.includes(selectionAnchorKey)) {
      setSelectionAnchorKey(null);
    }
  }, [selectionAnchorKey, visibleKeys]);

  useEffect(() => {
    setSelectedKeys((previous) => {
      if (previous.size === 0) return previous;
      const visibleSet = new Set(visibleItems.map(itemKey));
      const next = new Set<string>();
      for (const key of previous) {
        if (visibleSet.has(key)) next.add(key);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [visibleItems]);

  useEffect(() => {
    if (!menuKey) return;
    const exists = visibleItems.some((item) => itemKey(item) === menuKey);
    if (!exists) setMenuKey(null);
  }, [menuKey, visibleItems]);

  useEffect(() => {
    if (!launchFeedback) return;
    const timeout = window.setTimeout(() => setLaunchFeedback(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [launchFeedback]);

  useEffect(() => {
    if (degraded.length === 0) {
      setSignalToastHidden(false);
      return;
    }
    setSignalToastHidden(false);
  }, [degraded]);

  useEffect(() => {
    if (selectionEnabled && !isCompact && selectedKeys.size > 0) {
      setQueueSettingsOpen(false);
    }
  }, [isCompact, selectedKeys.size, selectionEnabled]);

  useEffect(() => {
    if (!queueSettingsOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (queueSettingsRef.current?.contains(target)) return;
      setQueueSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueSettingsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [queueSettingsOpen]);

  const removeQueueItem = async (item: NextUpQueueItem) => {
    const key = itemKey(item);
    const label = sanitizeDisplayText(item.workstreamTitle);
    const previousOrder = orderedKeysRef.current.slice();
    applyLocalRemoval(new Set([key]));
    try {
      await nextUpActions.remove({
        initiativeId: item.initiativeId,
        workstreamId: item.workstreamId,
      });
      setSelectedKeys((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      setSelectionAnchorKey((previous) => (previous === key ? null : previous));
      setNotice(`Removed ${label} from queue.`);
    } catch (err) {
      if (!isCompact) {
        setOrderedKeys(previousOrder);
      }
      const raw = err instanceof Error ? err.message : '';
      setNotice(formatQueueActionError(raw, 'Failed to remove from queue'));
    }
  };

  const toggleSelection = (key: string, checked: boolean, shiftKey: boolean) => {
    const selectionOrder = isCompact ? visibleKeys : orderedKeys.length > 0 ? orderedKeys : visibleKeys;
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      const anchorKey = selectionAnchorKey;
      const canRangeSelect = shiftKey && anchorKey && selectionOrder.includes(anchorKey);

      if (canRangeSelect) {
        const targetIndex = selectionOrder.indexOf(key);
        const anchorIndex = selectionOrder.indexOf(anchorKey);
        if (targetIndex >= 0 && anchorIndex >= 0) {
          const [start, end] =
            targetIndex < anchorIndex ? [targetIndex, anchorIndex] : [anchorIndex, targetIndex];
          for (const rangeKey of selectionOrder.slice(start, end + 1)) {
            if (checked) next.add(rangeKey);
            else next.delete(rangeKey);
          }
        } else if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      } else if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }

      return next;
    });
    setSelectionAnchorKey(key);
  };

  const selectAllVisible = () => {
    setSelectedKeys(new Set(visibleKeys));
    setSelectionAnchorKey(visibleKeys.length > 0 ? visibleKeys[visibleKeys.length - 1] : null);
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
  };

  const applyLocalPlacement = (keys: Set<string>, placement: QueuePlacement) => {
    if (keys.size === 0) return;
    setOrderedKeys((previous) => {
      const base = previous.length > 0 ? previous : visibleKeys;
      const selected: string[] = [];
      const remaining: string[] = [];
      for (const entry of base) {
        if (keys.has(entry)) selected.push(entry);
        else remaining.push(entry);
      }
      if (selected.length === 0) return previous;
      return placement === 'top' ? [...selected, ...remaining] : [...remaining, ...selected];
    });
  };

  const applyLocalRemoval = (keys: Set<string>) => {
    if (keys.size === 0) return;
    setOrderedKeys((previous) => previous.filter((entry) => !keys.has(entry)));
  };

  const runBulkQueueAction = async (action: NextUpQueueBulkAction) => {
    if (selectedKeys.size === 0) {
      setNotice('Select one or more queue items first.');
      return;
    }
    const selectedItems = visibleItems
      .map((item) => ({ key: itemKey(item), item }))
      .filter((entry) => selectedKeys.has(entry.key));

    if (selectedItems.length === 0) {
      setNotice('Selected queue items are no longer visible.');
      return;
    }

    const selectedKeySet = new Set(selectedItems.map(({ key }) => key));
    const previousOrder = orderedKeysRef.current.slice();
    if (action === 'move_top') {
      applyLocalPlacement(selectedKeySet, 'top');
    } else if (action === 'move_bottom') {
      applyLocalPlacement(selectedKeySet, 'bottom');
    } else if (action === 'remove') {
      applyLocalRemoval(selectedKeySet);
    }

    setActionKey(`bulk:${action}`);
    setNotice(null);
    try {
      const payloadItems = selectedItems.map(({ item }) => ({
        initiativeId: item.initiativeId,
        workstreamId: item.workstreamId,
      }));
      const result = await nextUpActions.bulk({
        action,
        items: payloadItems,
      });

      const updated =
        typeof (result as { updated?: unknown })?.updated === 'number'
          ? ((result as { updated: number }).updated ?? 0)
          : 0;
      const failed =
        typeof (result as { failed?: unknown })?.failed === 'number'
          ? ((result as { failed: number }).failed ?? 0)
          : 0;
      const fallbackErrors = Array.isArray((result as { errors?: unknown })?.errors)
        ? ((result as { errors: unknown[] }).errors
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean))
        : [];

      const label =
        action === 'remove'
          ? 'removed'
          : action === 'move_top'
            ? 'moved to top'
            : 'moved to bottom';
      if (updated === 0 && failed > 0 && fallbackErrors.length > 0) {
        setNotice(
          formatQueueActionError(
            fallbackErrors[0],
            `${failed} queue action${failed === 1 ? '' : 's'} failed.`
          )
        );
      } else {
        setNotice(
          failed > 0
            ? `${updated} item${updated === 1 ? '' : 's'} ${label}; ${failed} failed.`
            : `${updated} item${updated === 1 ? '' : 's'} ${label}.`
        );
      }
      setSelectedKeys(new Set());
      setSelectionAnchorKey(null);
    } catch (err) {
      if (!isCompact) {
        setOrderedKeys(previousOrder);
      }
      const raw = err instanceof Error ? err.message : '';
      setNotice(formatQueueActionError(raw, 'Bulk queue action failed'));
    } finally {
      setActionKey(null);
    }
  };

  const persistOrder = async () => {
    const order = orderedKeysRef.current
      .map((key) => itemByKey.get(key))
      .filter(Boolean)
      .map((item) => ({ initiativeId: item!.initiativeId, workstreamId: item!.workstreamId }));

    if (order.length === 0) return;
    await nextUpActions.reorder({ order });
  };

  const runAction = async (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string),
    options?: {
      optimistic?: () => void;
      rollback?: () => void;
    }
  ) => {
    setNotice(null);
    setUpgradeGate(null);
    onUpgradeGate?.(null);
    options?.optimistic?.();
    setActionKey(key);
    try {
      const result = await action();
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    } catch (err) {
      options?.rollback?.();
      if (err instanceof UpgradeRequiredError) {
        setUpgradeGate(err);
        onUpgradeGate?.(err);
      } else {
        const raw = err instanceof Error ? err.message : '';
        setNotice(formatQueueActionError(raw, 'Action failed'));
      }
    } finally {
      setActionKey(null);
    }
  };

  const handleLaunch = async () => {
    if (!initiativeId) return;
    setLaunchFeedback('Dispatching...');
    try {
      const workstreamIds = items
        .filter((item) => item.queueState !== 'running' && item.queueState !== 'completed')
        .map((item) => item.workstreamId);
      const result = await autoContinue.launchSingle({
        initiativeId,
        workstreamIds: workstreamIds.length > 0 ? workstreamIds : undefined,
      });
      const count = result?.dispatched ?? workstreamIds.length;
      setLaunchFeedback(`${count} workstream${count === 1 ? '' : 's'} dispatched`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setLaunchFeedback(formatQueueActionError(raw, 'Launch failed'));
    }
  };

  const launchWorkstream = async (item: NextUpQueueItem) => {
    return await playWorkstream({
      initiativeId: item.initiativeId,
      workstreamId: item.workstreamId,
      agentId: item.runnerAgentId,
    });
  };

  const handleAutopilot = async () => {
    if (!initiativeId) return;
    const confirmed = window.confirm(
      'Enable Autopilot for this initiative? OrgX will continue dispatching queued work and only pause for blockers or required decisions.'
    );
    if (!confirmed) return;
    setLaunchFeedback('Enabling autopilot...');
    try {
      await autoContinue.start({});
      setLaunchFeedback('Autopilot enabled');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setLaunchFeedback(formatQueueActionError(raw, 'Autopilot failed'));
    }
  };

  const statusTone: 'upgrade' | 'error' | 'notice' | null = upgradeGate
    ? 'upgrade'
    : error
      ? 'error'
      : notice
        ? 'notice'
        : null;
  const queueErrorMessage = error ? formatQueueErrorMessage(error) : null;
  const primaryDegradedMessage = degraded.length > 0 ? formatQueueDegradedMessage(degraded[0]) : null;

  const showStatusBanner = statusTone !== null;
  const showSignalToast =
    degraded.length > 0 && !signalToastHidden && menuKey === null && !queueSettingsOpen;
  const selectedCount = visibleSelection.length;
  const hasVisibleCards = useMemo(() => {
    if (zoomLevel === 'initiative') return visibleInitiativeGroups.length > 0;
    if (zoomLevel === 'milestone') return visibleMilestoneGroups.length > 0;
    return visibleItems.length > 0;
  }, [visibleInitiativeGroups.length, visibleItems.length, visibleMilestoneGroups.length, zoomLevel]);
  const showInlineBulkActions =
    selectionEnabled && isWorkstreamView && !isCompact && selectedCount > 0;
  const emptyStateMessage =
    zoomLevel === 'initiative'
      ? 'No initiatives in the queue right now.'
      : zoomLevel === 'milestone'
        ? 'No milestone slices in the queue right now.'
        : activeElsewhereCount > 0
          ? `No queued workstreams yet. ${activeElsewhereCount} running item${activeElsewhereCount === 1 ? '' : 's'} still in-flight.`
          : degraded.length > 0
            ? 'Queue signal is delayed right now.'
            : 'No queued workstreams right now.';

  const bulkActionControls = (
    <>
      <button
        type="button"
        onClick={selectAllVisible}
        className="control-pill h-8 px-2.5 text-caption font-semibold"
      >
        Select all
      </button>
      <button
        type="button"
        onClick={clearSelection}
        disabled={selectedKeys.size === 0}
        className="control-pill h-8 px-2.5 text-caption font-semibold disabled:opacity-45"
      >
        Clear
      </button>
      <button
        type="button"
        disabled={selectedCount === 0 || actionKey === 'bulk:move_top'}
        onClick={() => void runBulkQueueAction('move_top')}
        className="control-pill h-8 px-2.5 text-caption font-semibold disabled:opacity-45"
      >
        Move top
      </button>
      <button
        type="button"
        disabled={selectedCount === 0 || actionKey === 'bulk:move_bottom'}
        onClick={() => void runBulkQueueAction('move_bottom')}
        className="control-pill h-8 px-2.5 text-caption font-semibold disabled:opacity-45"
      >
        Move bottom
      </button>
      <button
        type="button"
        disabled={selectedCount === 0 || actionKey === 'bulk:remove'}
        onClick={() => void runBulkQueueAction('remove')}
        className="control-pill h-8 px-2.5 text-caption font-semibold disabled:opacity-45"
      >
        Remove
      </button>
    </>
  );

  return (
    <PremiumCard
      surface={panelStyle === 'card'}
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        disableEnterAnimation ? '' : 'card-enter'
      } ${panelStyle === 'flat' ? '!rounded-none !border-none !bg-transparent !shadow-none' : ''} ${
        className ?? ''
      }`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip inline-flex min-w-[52px] justify-center text-micro tabular-nums">
              {isLoading ? (
                <span aria-hidden className="h-2.5 w-5 rounded bg-white/15 animate-pulse" />
              ) : (
                displayCount
              )}
            </span>
            <span
              className={cn(
                'chip inline-flex min-w-[148px] justify-center text-micro tabular-nums transition-opacity',
                !isLoading && activeElsewhereCount > 0 && isWorkstreamView
                  ? 'text-secondary opacity-100'
                  : 'pointer-events-none opacity-0'
              )}
            >
              {`${activeElsewhereCount} active elsewhere`}
            </span>
            <span
              className={cn(
                'inline-flex min-w-[92px] justify-end text-micro text-muted transition-opacity',
                isFetching && !isLoading ? 'opacity-100' : 'opacity-0'
              )}
              aria-live="polite"
            >
              refreshing…
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {allowCompactToggle ? (
              <button
                type="button"
                onClick={() => setCompact(!isCompact)}
                className="control-pill h-8 flex-shrink-0 whitespace-nowrap px-3 text-caption font-semibold"
                title={isCompact ? 'Switch to expanded cards' : 'Switch to compact list'}
                aria-label={isCompact ? 'Expand Next Up queue' : 'Compact Next Up queue'}
              >
                {isCompact ? 'Expand' : 'Compact'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Zoom-level toggle + Launch / Autopilot controls */}
      <div className="flex items-center justify-between gap-2 border-b border-subtle px-3 py-2">
        <ZoomLevelToggle value={zoomLevel} onChange={setZoomLevel} />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={autoContinue.isLaunching || !initiativeId}
            onClick={() => void handleLaunch()}
            className="border border-[#BFFF00]/30 text-[#BFFF00] hover:bg-[#BFFF00]/10 px-3 py-1.5 rounded-lg text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-40 transition-colors"
            title="Launch queued workstreams"
          >
            <PlayGlyph className="h-3 w-3" />
            <span>Launch</span>
          </button>
          <button
            type="button"
            disabled={autoContinue.isStarting || !initiativeId}
            onClick={() => void handleAutopilot()}
            className="border border-[#14B8A6]/30 text-[#14B8A6] hover:bg-[#14B8A6]/10 px-3 py-1.5 rounded-lg text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-40 transition-colors"
            title="Enable autopilot for this initiative"
          >
            <AutoGlyph className="h-3 w-3" />
            <span>Autopilot</span>
          </button>
        </div>
      </div>

      {/* Launch feedback toast */}
      {launchFeedback && (
        <div className="px-3 pt-1.5">
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="rounded-lg border border-[#BFFF00]/20 bg-[#BFFF00]/[0.06] px-2.5 py-1.5 text-[11px] text-[#E1FFB2]"
          >
            {launchFeedback}
          </motion.div>
        </div>
      )}

      {showStatusBanner && (
        <div className="px-3 pt-2">
          <AnimatePresence initial={false} mode="wait">
            {statusTone === 'upgrade' && upgradeGate ? (
              <motion.div
                key="upgrade"
                initial={{ opacity: 0, y: -4, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.99 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="rounded-xl border border-amber-200/25 bg-amber-200/10 px-3 py-2 text-caption text-amber-100"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-amber-200/25 bg-amber-200/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-[0.08em] text-amber-100/90">
                        Upgrade required
                      </span>
                      <span className="truncate text-micro text-secondary">
                        {formatPlanLabel(upgradeGate.currentPlan)} →{' '}
                        {formatPlanLabel(upgradeGate.requiredPlan)}
                      </span>
                    </div>
                    <div
                      className="mt-1 line-clamp-2 text-caption leading-snug text-amber-50/90"
                      title={upgradeGate.message}
                    >
                      {upgradeGate.message}
                    </div>
                    {notice ? (
                      <div className="mt-1 text-micro text-rose-50/85">
                        {notice}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          void openUpgradeCheckout({
                            actions: upgradeGate.actions,
                            requiredPlan: upgradeGate.requiredPlan,
                          }).catch((err) =>
                            setNotice(
                              formatQueueActionError(
                                err instanceof Error ? err.message : '',
                                'Checkout failed'
                              )
                            )
                          )
                        }
                        className="h-7 rounded-full border border-amber-200/25 bg-amber-200/15 px-3 text-micro font-semibold text-amber-50 transition-colors hover:bg-amber-200/20"
                      >
                        Upgrade
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void openBillingPortal({ actions: upgradeGate.actions }).catch((err) =>
                            setNotice(
                              formatQueueActionError(
                                err instanceof Error ? err.message : '',
                                'Portal failed'
                              )
                            )
                          )
                        }
                        className="h-7 rounded-full border border-strong bg-white/[0.04] px-3 text-micro font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                      >
                        Billing
                      </button>
                      {onOpenSettings && (
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="h-7 rounded-full border border-strong bg-white/[0.04] px-2.5 text-micro font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                        >
                          Settings
                        </button>
                      )}
                    </div>
                    {upgradeGate.actions?.pricing ? (
                      <a
                        href={upgradeGate.actions.pricing}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-micro text-secondary underline decoration-white/20 hover:text-primary"
                      >
                        View pricing
                      </a>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            ) : statusTone === 'error' && queueErrorMessage ? (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="rounded-xl border border-red-400/25 bg-red-500/[0.08] px-3 py-2 text-caption text-red-100"
              >
                {queueErrorMessage}
              </motion.div>
            ) : statusTone === 'notice' && notice ? (
              <motion.div
                key="notice"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-caption text-primary"
              >
                {notice}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      <div className={`flex-1 space-y-2.5 overflow-y-auto overscroll-y-contain px-3 pb-3 ${showHeader ? 'pt-1' : 'pt-2.5'}`}>
        {!isLoading && displayCount > 0 ? (
          <div className="flex flex-col gap-2.5 px-0.5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
                  <p className="truncate text-micro uppercase tracking-[0.08em] text-muted">
                    {zoomLevel === 'initiative'
                      ? 'Initiatives'
                      : zoomLevel === 'milestone'
                        ? 'Milestone slices'
                        : queueDisplayMode === 'blocked'
                          ? 'Needs attention'
                          : queueDisplayMode === 'running'
                            ? 'Running now'
                            : 'Queue'}
                  </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {selectedCount > 0 ? (
                  <span className="chip text-micro">{selectedCount} selected</span>
                ) : null}
                <span
                  className={cn(
                    'inline-flex min-w-[92px] text-micro text-muted transition-opacity',
                    isFetching && !isLoading ? 'opacity-100' : 'opacity-0'
                  )}
                  aria-live="polite"
                >
                  refreshing…
                </span>
                {selectionEnabled && isWorkstreamView && !isCompact && selectedCount === 0 ? (
                  <span className="text-micro text-muted">Shift+select to pick ranges.</span>
                ) : null}
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end">
              {allowCompactToggle ? (
                <button
                  type="button"
                  onClick={() => setCompact(!isCompact)}
                  className="control-pill h-8 px-2.5 text-caption font-semibold"
                  title={isCompact ? 'Switch to expanded cards' : 'Switch to compact list'}
                  aria-label={isCompact ? 'Expand Next Up queue' : 'Compact Next Up queue'}
                >
                  {isCompact ? 'Expand' : 'Compact'}
                </button>
              ) : null}
              {showInlineBulkActions ? (
                <div className="flex flex-wrap justify-end gap-1.5">{bulkActionControls}</div>
              ) : null}
              {!showInlineBulkActions && showQueueSettings && isWorkstreamView ? (
                <div ref={queueSettingsRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setQueueSettingsOpen((previous) => !previous)}
                    className="control-pill h-8 px-2.5 text-caption font-semibold"
                    aria-haspopup="menu"
                    aria-expanded={queueSettingsOpen}
                    title="Queue settings"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="opacity-85"
                      aria-hidden
                    >
                      <path d="M4 6h16" />
                      <path d="M7 12h10" />
                      <path d="M10 18h4" />
                    </svg>
                    <span>Queue</span>
                  </button>
                  {queueSettingsOpen ? (
                    <div className="surface-tier-2 absolute right-0 top-[calc(100%+8px)] z-[280] w-[320px] max-w-[86vw] rounded-xl p-3 shadow-[0_18px_42px_rgba(0,0,0,0.46)] backdrop-blur-xl">
                      <div className="space-y-2.5">
                        {selectionEnabled && !isCompact ? (
                          <div>
                            <p className="section-kicker">Bulk actions</p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {bulkActionControls}
                            </div>
                          </div>
                        ) : null}
                        {onOpenSettings ? (
                          <button
                            type="button"
                            onClick={() => {
                              setQueueSettingsOpen(false);
                              onOpenSettings();
                            }}
                            className="control-pill h-7 px-2.5 text-micro font-semibold"
                          >
                            Open settings
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <NextUpLoadingSkeleton compact={isCompact} />
        ) : null}

        {!isLoading && !hasVisibleCards && !error && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-4 text-center">
            <p className="text-body text-secondary">{emptyStateMessage}</p>
            {primaryDegradedMessage ? (
              <p className="mt-1 text-micro text-muted">{primaryDegradedMessage}</p>
            ) : null}
            {degraded.length > 0 ? (
              <div className="mt-2.5 flex items-center justify-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSignalToastHidden(false);
                    void refetch();
                  }}
                  className="control-pill h-7 px-2.5 text-micro font-semibold"
                >
                  Retry now
                </button>
              </div>
            ) : null}
          </div>
        )}

        {!isLoading && zoomLevel === 'initiative' ? (
          <AnimatePresence initial={false}>
            {visibleInitiativeGroups.map((group, index) => {
              const firstRunnable =
                group.items.find(
                  (item) =>
                    item.queueState !== 'running' &&
                    item.queueState !== 'completed'
                ) ?? group.items[0] ?? null;
              const label = resolveEntityLabel(
                group.initiativeTitle,
                group.initiativeId,
                'Initiative'
              );
              const queueBadge = queueLabel(group.queueState);
              const queueToneClass = queueTone(group.queueState);
              const taskCount = group.items.reduce(
                (count, item) => count + (item.sliceTaskCount ?? 0),
                0
              );

              return (
                <motion.article
                  layout
                  key={`initiative-group:${group.initiativeId}`}
                  initial={{ opacity: 0, y: 8, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{
                    duration: 0.2,
                    delay: Math.min(index, 7) * 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-micro uppercase tracking-[0.08em] text-muted">Initiative</p>
                      <p className="mt-0.5 truncate text-body font-semibold text-white" title={label}>
                        {label}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
                        queueToneClass
                      )}
                    >
                      {queueBadge}
                    </span>
                  </div>
                  <p className="mt-1 text-micro text-secondary">
                    {group.workstreamCount} workstreams · {taskCount} tasks
                  </p>
                  <div className="mt-2 space-y-1">
                    {group.items.slice(0, 3).map((item, subIndex) => (
                      <div
                        key={`${item.workstreamId}:${subIndex}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-black/[0.18] px-2.5 py-1.5 text-caption"
                      >
                        <span className="truncate text-white/84">{sanitizeDisplayText(item.workstreamTitle)}</span>
                        <span className="text-micro text-secondary">
                          {item.sliceTaskCount ?? 0} tasks
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenInitiative?.(group.initiativeId, group.initiativeTitle)
                      }
                      className="control-pill h-7 px-2.5 text-micro font-semibold"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      disabled={!firstRunnable || actionKey === `initiative:${group.initiativeId}`}
                      onClick={() => {
                        if (!firstRunnable) return;
                        void runAction(
                          `initiative:${group.initiativeId}`,
                          () => launchWorkstream(firstRunnable),
                          `Dispatched ${sanitizeDisplayText(firstRunnable.workstreamTitle)}.`
                        );
                      }}
                      className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                    >
                      Dispatch
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        ) : null}

        {!isLoading && zoomLevel === 'milestone' ? (
          <AnimatePresence initial={false}>
            {visibleMilestoneGroups.map((group, index) => {
              const item = group.item;
              const busyKey = `milestone:${group.workstreamId}:${group.milestoneId ?? 'none'}`;
              return (
                <motion.article
                  layout
                  key={`${group.initiativeId}:${group.workstreamId}:${group.milestoneId ?? 'none'}`}
                  initial={{ opacity: 0, y: 8, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{
                    duration: 0.2,
                    delay: Math.min(index, 7) * 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-micro uppercase tracking-[0.08em] text-muted">
                        {sanitizeDisplayText(group.initiativeTitle)} · {sanitizeDisplayText(group.workstreamTitle)}
                      </p>
                      <p className="mt-0.5 truncate text-body font-semibold text-white" title={group.milestoneTitle}>
                        {sanitizeDisplayText(group.milestoneTitle)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
                        queueTone(group.queueState)
                      )}
                    >
                      {queueLabel(group.queueState)}
                    </span>
                  </div>
                  <p className="mt-1 text-micro text-secondary">
                    {group.taskCount} tasks in slice
                  </p>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenInitiative?.(group.initiativeId, group.initiativeTitle)}
                      className="control-pill h-7 px-2.5 text-micro font-semibold"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      disabled={actionKey === busyKey || group.queueState === 'running'}
                      onClick={() => void runAction(busyKey, () => launchWorkstream(item), (result) => playDispatchNotice(item, result))}
                      className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                    >
                      {group.queueState === 'running' ? 'Running' : 'Start'}
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        ) : null}

        {!isLoading && isWorkstreamView && isCompact ? (
          <AnimatePresence initial={false}>
            {visibleItems.map((item, index) => {
              const key = itemKey(item);
              const isRowBusy = actionKey === key;
              const isRunningRow = item.queueState === 'running';
              const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;
                const initiativeTitle = resolveEntityLabel(
                  item.initiativeTitle,
                  item.initiativeId,
                  'Initiative'
                );
                const workstreamTitle = resolveEntityLabel(
                  item.workstreamTitle,
                  item.workstreamId,
                  'Workstream'
                );
              const initiativePriority = toInitiativePriorityLabel(item);
              const nextTaskTitle = item.nextTaskTitle
                  ? sanitizeDisplayText(item.nextTaskTitle)
                  : null;
                const blockReason = item.blockReason ? sanitizeDisplayText(item.blockReason) : null;
              const runnerName = resolveRunnerName(item);
              const runnerSourceBadge = resolveRunnerSourceBadge(item);

              return (
                <motion.article
                  layout
                  key={key}
                  initial={{ opacity: 0, y: 6, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{
                    duration: 0.22,
                    delay: Math.min(index, 7) * 0.018,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-2.5 py-2 cursor-pointer transition-colors hover:border-white/[0.14]"
                  onClick={() => onOpenSliceDetail?.(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSliceDetail?.(item); } }}
                >
                  <div
                    className={`pointer-events-none absolute inset-x-2.5 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
                    aria-hidden
                  />

                  <div className="flex min-w-0 items-center gap-2.5">
                    <AgentAvatar
                      name={runnerName}
                      hint={resolveRunnerHint(item, runnerName)}
                      size="xs"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <EntityIcon type="initiative" size={11} className="flex-shrink-0 opacity-85" />
                        <button
                          type="button"
                          onClick={() =>
                            onOpenInitiative?.(item.initiativeId, item.initiativeTitle)
                          }
                          className="block min-w-0 flex-1 truncate text-left text-micro uppercase tracking-[0.08em] text-muted transition-colors hover:text-white/72"
                          title={initiativeTitle}
                        >
                          {initiativeTitle}
                        </button>
                        {initiativePriority ? (
                          <span
                            className={cn(
                              'inline-flex flex-shrink-0 items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]',
                              initiativePriority.toneClass
                            )}
                            title={initiativePriority.longLabel}
                          >
                            {initiativePriority.shortLabel}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption font-semibold leading-snug text-white" title={workstreamTitle}>
                        <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
                        <span className="line-clamp-2">{workstreamTitle}</span>
                      </p>
                      {nextTaskTitle ? (
                        <p
                          className="mt-0.5 line-clamp-2 text-micro leading-snug text-secondary"
                          title={`${queueTaskHeading(item.queueState)}: ${nextTaskTitle}${dueText ? ` · ${dueText}` : ''}`}
                        >
                          {queueTaskHeading(item.queueState)}: {nextTaskTitle}
                          {dueText ? ` · ${dueText}` : ''}
                        </p>
                      ) : (
                        <p className="mt-0.5 line-clamp-2 text-micro leading-snug text-secondary" title={queueTaskFallback(item)}>
                          {queueTaskFallback(item)}
                        </p>
                      )}
                      {runnerSourceBadge ? (
                        <p className="mt-0.5 text-micro text-muted">Runner {runnerSourceBadge}</p>
                      ) : null}
                    </div>
                  </div>

                  {blockReason && (
                    <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
                      Blocked: {blockReason}
                    </div>
                  )}

                  {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                  <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={isRowBusy || isRunningRow}
                      onClick={() =>
                        void runAction(
                          key,
                          () =>
                            playWorkstream({
                              initiativeId: item.initiativeId,
                              workstreamId: item.workstreamId,
                              agentId: item.runnerAgentId,
                            }),
                          (result) => playDispatchNotice(item, result)
                        )
                      }
                      className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
                      title={isRunningRow ? 'Already running' : 'Start now'}
                    >
                      <span className="inline-flex items-center gap-1">
                        <PlayGlyph className="h-3 w-3 opacity-85" />
                        <span>{isRunningRow ? 'Running' : 'Start'}</span>
                      </span>
                    </button>
                    <div className="relative ml-auto">
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() => setMenuKey((previous) => (previous === key ? null : key))}
                        className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
                        title="Queue actions"
                      >
                        <span className="inline-flex items-center gap-1">
                          <MoreGlyph className="h-3 w-3 opacity-85" />
                          <span>More</span>
                        </span>
                      </button>
                      {menuKey === key && (
                        <div className="absolute right-0 top-[calc(100%+6px)] z-[320] min-w-[178px] rounded-xl border border-white/[0.1] bg-[#080d14]/95 p-1.5 shadow-[0_16px_36px_rgba(0,0,0,0.42)] backdrop-blur">
                          <button
                            type="button"
                            onClick={() => {
                              setMenuKey(null);
                              const previousOrder = orderedKeysRef.current.slice();
                              void runAction(
                                `${key}:top`,
                                () =>
                                  nextUpActions.move({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    placement: 'top',
                                  }),
                                `Moved ${workstreamTitle} to top of queue.`,
                                {
                                  optimistic: () => applyLocalPlacement(new Set([key]), 'top'),
                                  rollback: () => setOrderedKeys(previousOrder),
                                }
                              );
                            }}
                            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                          >
                            Move to top
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuKey(null);
                              const previousOrder = orderedKeysRef.current.slice();
                              void runAction(
                                `${key}:bottom`,
                                () =>
                                  nextUpActions.move({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    placement: 'bottom',
                                  }),
                                `Moved ${workstreamTitle} to bottom of queue.`,
                                {
                                  optimistic: () => applyLocalPlacement(new Set([key]), 'bottom'),
                                  rollback: () => setOrderedKeys(previousOrder),
                                }
                              );
                            }}
                            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                          >
                            Move to bottom
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuKey(null);
                              const previousOrder = orderedKeysRef.current.slice();
                              void runAction(
                                `${key}:auto`,
                                async () => {
                                  await nextUpActions.move({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    placement: 'top',
                                  });
                                  return startWorkstreamAutoContinue({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    agentId: item.runnerAgentId,
                                    scope: 'initiative',
                                  });
                                },
                                `Start+Auto enabled for ${initiativeTitle}.`,
                                {
                                  optimistic: () => applyLocalPlacement(new Set([key]), 'top'),
                                  rollback: () => setOrderedKeys(previousOrder),
                                }
                              );
                            }}
                            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                          >
                            Start with auto
                          </button>
                          <button
                            type="button"
                            disabled={nextUpActions.isRemoving}
                            onClick={() => {
                              setMenuKey(null);
                              void removeQueueItem(item);
                            }}
                            className="mt-1 flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-red-100 transition-colors hover:bg-red-500/[0.12] disabled:opacity-45"
                          >
                            Remove from queue
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        ) : !isLoading && isWorkstreamView ? (
          <Reorder.Group
            axis="y"
            values={orderedKeys}
            onReorder={(keys) => {
              orderedKeysRef.current = keys;
              setOrderedKeys(keys);
            }}
            className="space-y-2.5"
          >
            {orderedKeys
              .map((key) => itemByKey.get(key))
              .filter(Boolean)
              .map((item, index) => (
                <NextUpReorderRow
                  key={itemKey(item!)}
                  item={item!}
                  index={index}
                  actionKey={actionKey}
                  setNotice={setNotice}
                  setUpgradeGate={setUpgradeGate}
                  onUpgradeGate={onUpgradeGate}
                  onOpenInitiative={onOpenInitiative}
                  onOpenSliceDetail={onOpenSliceDetail}
                  selected={selectedKeys.has(itemKey(item!))}
                  selectionEnabled={selectionEnabled}
                  onToggleSelection={toggleSelection}
                  menuKey={menuKey}
                  setMenuKey={setMenuKey}
                  playWorkstream={playWorkstream}
                  startWorkstreamAutoContinue={startWorkstreamAutoContinue}
                  triagePlacement={triagePlacement}
                  onPauseWorkstream={(nextItem, placement) =>
                    nextUpActions.stopTriage({
                      initiativeId: nextItem.initiativeId,
                      workstreamId: nextItem.workstreamId,
                      placement,
                      resetToTodo: false,
                    })
                  }
                  onMoveWorkstream={(nextItem, placement) =>
                    nextUpActions.move({
                      initiativeId: nextItem.initiativeId,
                      workstreamId: nextItem.workstreamId,
                      placement,
                    })
                  }
                  onApplyLocalPlacement={applyLocalPlacement}
                  onRestoreOrder={(keys) => setOrderedKeys(keys)}
                  captureOrder={() => orderedKeysRef.current.slice()}
                  onCommitReorder={() => void persistOrder().catch(() => null)}
                  onDismiss={removeQueueItem}
                  runAction={runAction}
                />
              ))}
          </Reorder.Group>
        ) : null}
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 z-[250]">
        <InlineToast
          open={showSignalToast}
          tone="warning"
          title="Limited signal"
          message={primaryDegradedMessage}
          autoDismissMs={6000}
          onDismiss={() => setSignalToastHidden(true)}
        />
      </div>
    </PremiumCard>
  );
}

function NextUpReorderRow({
  item,
  index,
  actionKey,
  setNotice,
  setUpgradeGate,
  onUpgradeGate,
  onOpenInitiative,
  onOpenSliceDetail,
  selected,
  selectionEnabled,
  onToggleSelection,
  menuKey,
  setMenuKey,
  playWorkstream,
  startWorkstreamAutoContinue,
  triagePlacement,
  onPauseWorkstream,
  onMoveWorkstream,
  onApplyLocalPlacement,
  onRestoreOrder,
  captureOrder,
  onCommitReorder,
  onDismiss,
  runAction,
}: {
  item: NextUpQueueItem;
  index: number;
  actionKey: string | null;
  setNotice: (value: string | null) => void;
  setUpgradeGate: (value: UpgradeRequiredError | null) => void;
  onUpgradeGate?: (gate: UpgradeRequiredError | null) => void;
  onOpenInitiative?: (initiativeId: string, initiativeTitle?: string) => void;
  onOpenSliceDetail?: (item: NextUpQueueItem) => void;
  selected: boolean;
  selectionEnabled: boolean;
  onToggleSelection: (key: string, checked: boolean, shiftKey: boolean) => void;
  menuKey: string | null;
  setMenuKey: (value: string | null | ((previous: string | null) => string | null)) => void;
  playWorkstream: (input: { initiativeId: string; workstreamId: string; agentId?: string | null }) => Promise<unknown>;
  startWorkstreamAutoContinue: (input: {
    initiativeId: string;
    workstreamId: string;
    agentId?: string | null;
    scope?: 'initiative' | 'workstream';
  }) => Promise<unknown>;
  triagePlacement: QueuePlacement;
  onPauseWorkstream: (item: NextUpQueueItem, placement: QueuePlacement) => Promise<unknown>;
  onMoveWorkstream: (item: NextUpQueueItem, placement: QueuePlacement) => Promise<unknown>;
  onApplyLocalPlacement: (keys: Set<string>, placement: QueuePlacement) => void;
  onRestoreOrder: (keys: string[]) => void;
  captureOrder: () => string[];
  onCommitReorder: () => void;
  onDismiss: (item: NextUpQueueItem) => void;
  runAction: (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string),
    options?: {
      optimistic?: () => void;
      rollback?: () => void;
    }
  ) => Promise<void>;
}) {
  const controls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);
  const key = `${item.initiativeId}:${item.workstreamId}`;
  const isRowBusy = actionKey === key;
  const isRunningRow = item.queueState === 'running';
  const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;
  const initiativeTitle = resolveEntityLabel(
    item.initiativeTitle,
    item.initiativeId,
    'Initiative'
  );
  const workstreamTitle = resolveEntityLabel(
    item.workstreamTitle,
    item.workstreamId,
    'Workstream'
  );
  const initiativePriority = toInitiativePriorityLabel(item);
  const nextTaskTitle = item.nextTaskTitle ? sanitizeDisplayText(item.nextTaskTitle) : null;
  const blockReason = item.blockReason ? sanitizeDisplayText(item.blockReason) : null;
  const runnerName = resolveRunnerName(item);
  const runnerSourceBadge = resolveRunnerSourceBadge(item);

  return (
    <Reorder.Item
      value={key}
      id={key}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={() => {
        setIsDragging(false);
        onCommitReorder();
      }}
      whileDrag={{
        scale: 1.02,
        boxShadow: '0 20px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(191,255,0,0.15)',
        zIndex: 50,
        cursor: 'grabbing',
      }}
      className="relative"
    >
      <motion.article
        layout
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{
          duration: 0.4,
          ease: [0.25, 0.1, 0.25, 1],
          delay: Math.min(index, 7) * 0.05,
          opacity: { duration: 0.32, ease: [0.25, 0.1, 0.25, 1] },
        }}
        className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 cursor-pointer transition-colors hover:border-white/[0.14]"
        onClick={() => onOpenSliceDetail?.(item)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSliceDetail?.(item); } }}
      >

        <div
          className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
          aria-hidden
        />

        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex flex-1 items-start gap-2.5">
            <div className="relative h-8 w-8 flex-shrink-0">
              <div
                className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out ${
                  selectionEnabled
                    ? selected
                      ? 'opacity-0 scale-90'
                      : 'opacity-100 scale-100 group-hover:opacity-0 group-hover:scale-90 group-focus-within:opacity-0 group-focus-within:scale-90'
                    : 'opacity-100 scale-100'
                }`}
              >
                <AgentAvatar
                  name={runnerName}
                  hint={resolveRunnerHint(item, runnerName)}
                  size="sm"
                />
              </div>
              {selectionEnabled ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label="Select queue row"
                  title={selected ? 'Selected (Shift+click for range)' : 'Select (Shift+click for range)'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleSelection(key, !selected, event.shiftKey);
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className={`absolute inset-0 flex items-center justify-center rounded-full border transition-[opacity,transform,background-color,border-color,color] duration-200 ease-out ${
                    selected
                      ? 'opacity-100 scale-100 border-[#BFFF00]/40 bg-[#BFFF00]/18 text-[#E1FFB2]'
                      : 'opacity-0 scale-90 border-white/[0.24] bg-black/55 text-white/78 group-hover:opacity-100 group-hover:scale-100 group-focus-within:opacity-100 group-focus-within:scale-100 hover:bg-black/62'
                  }`}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current/45 bg-black/30">
                    {selected ? (
                      <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" aria-hidden>
                        <path
                          d="M3.2 8.3 6.2 11l6.6-6.1"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </span>
                </button>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <EntityIcon type="initiative" size={11} className="flex-shrink-0 opacity-85" />
                <button
                  type="button"
                  onClick={() => onOpenInitiative?.(item.initiativeId, item.initiativeTitle)}
                  className="block min-w-0 flex-1 truncate text-left text-micro uppercase tracking-[0.08em] text-muted transition-colors hover:text-white/72"
                  title={initiativeTitle}
                >
                  {initiativeTitle}
                </button>
                {initiativePriority ? (
                  <span
                    className={cn(
                      'inline-flex flex-shrink-0 items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]',
                      initiativePriority.toneClass
                    )}
                    title={initiativePriority.longLabel}
                  >
                    {initiativePriority.shortLabel}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex min-w-0 items-start gap-1.5">
                <EntityIcon type="workstream" size={12} className="mt-[3px] flex-shrink-0 opacity-95" />
                <p className="min-w-0 line-clamp-2 text-body font-semibold leading-snug text-white" title={workstreamTitle}>
                  {workstreamTitle}
                </p>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-micro text-secondary">
                <span className="rounded-full border border-strong bg-white/[0.03] px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                  Runner
                </span>
                <span className="truncate text-white/68">
                  {runnerName}
                  {runnerSourceBadge ? ` · ${runnerSourceBadge}` : ''}
                </span>
              </div>
            </div>
          </div>

        </div>

        <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2 text-caption text-white/68">
          {nextTaskTitle ? (
            <div className="space-y-1">
              <div className="flex min-w-0 items-center gap-1 text-micro uppercase tracking-[0.08em] text-white/44">
                <EntityIcon type="task" size={10} className="flex-shrink-0 opacity-80" />
                <span>{queueTaskHeading(item.queueState)}</span>
                {dueText ? (
                  <span className="truncate text-micro normal-case tracking-normal text-muted">
                    · {dueText}
                  </span>
                ) : null}
              </div>
              <p className="line-clamp-2 break-words text-caption leading-snug text-white/84" title={nextTaskTitle}>
                {nextTaskTitle}
              </p>
            </div>
          ) : (
            <span className="text-secondary">{queueTaskFallback(item)}</span>
          )}
        </div>

        {blockReason && (
          <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
            Blocked: {blockReason}
          </div>
        )}

        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled={isRowBusy || isRunningRow}
            onClick={() =>
              void runAction(
                key,
                () =>
                  playWorkstream({
                    initiativeId: item.initiativeId,
                    workstreamId: item.workstreamId,
                    agentId: item.runnerAgentId,
                  }),
                (result) => playDispatchNotice(item, result)
              )
            }
            className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
            title={isRunningRow ? 'Already running' : 'Start this workstream now'}
          >
            <span className="inline-flex items-center gap-1">
              <PlayGlyph className="h-3 w-3 opacity-85" />
              <span>{isRunningRow ? 'Running' : 'Start'}</span>
            </span>
          </button>
          <button
            type="button"
            onPointerDown={(event) => controls.start(event)}
            aria-label="Drag to reorder"
            title={isDragging ? 'Reordering' : 'Drag to reorder'}
            className={`control-pill flex h-7 items-center justify-center gap-1 px-2 text-micro font-semibold transition-colors ${
              isDragging
                ? 'border-[#BFFF00]/35 bg-[#BFFF00]/14 text-[#E1FFB2] cursor-grabbing'
                : 'cursor-grab hover:bg-white/[0.08] hover:text-bright'
            }`}
          >
            {isDragging ? (
              <HandGrabGlyph className="h-3.5 w-3.5 opacity-90" />
            ) : (
              <HandOpenGlyph className="h-3.5 w-3.5 opacity-90" />
            )}
            <span>{isDragging ? 'Reordering' : 'Drag'}</span>
          </button>
          <div className="relative ml-auto">
            <button
              type="button"
              disabled={isRowBusy}
              onClick={() => setMenuKey((previous) => (previous === key ? null : key))}
              className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
              title="Queue actions"
            >
              <span className="inline-flex items-center gap-1">
                <MoreGlyph className="h-3 w-3 opacity-85" />
                <span>More</span>
              </span>
            </button>
            {menuKey === key && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-[320] min-w-[198px] rounded-xl border border-white/[0.1] bg-[#080d14]/95 p-1.5 shadow-[0_16px_36px_rgba(0,0,0,0.42)] backdrop-blur">
                <button
                  type="button"
                  onClick={() => {
                    setMenuKey(null);
                    const previousOrder = captureOrder();
                    void runAction(
                      `${key}:top`,
                      () => onMoveWorkstream(item, 'top'),
                      `Moved ${workstreamTitle} to top of queue.`,
                      {
                        optimistic: () => onApplyLocalPlacement(new Set([key]), 'top'),
                        rollback: () => onRestoreOrder(previousOrder),
                      }
                    );
                  }}
                  className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Move to top
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuKey(null);
                    const previousOrder = captureOrder();
                    void runAction(
                      `${key}:bottom`,
                      () => onMoveWorkstream(item, 'bottom'),
                      `Moved ${workstreamTitle} to bottom of queue.`,
                      {
                        optimistic: () => onApplyLocalPlacement(new Set([key]), 'bottom'),
                        rollback: () => onRestoreOrder(previousOrder),
                      }
                    );
                  }}
                  className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Move to bottom
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuKey(null);
                    const previousOrder = captureOrder();
                    void runAction(
                      `${key}:auto`,
                      async () => {
                        await onMoveWorkstream(item, 'top');
                        return startWorkstreamAutoContinue({
                          initiativeId: item.initiativeId,
                          workstreamId: item.workstreamId,
                          agentId: item.runnerAgentId,
                          scope: 'initiative',
                        });
                      },
                      `Start+Auto enabled for ${initiativeTitle}.`,
                      {
                        optimistic: () => onApplyLocalPlacement(new Set([key]), 'top'),
                        rollback: () => onRestoreOrder(previousOrder),
                      }
                    );
                  }}
                  className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Start with auto
                </button>
                {isRunningRow ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuKey(null);
                      void runAction(
                        `${key}:pause`,
                        () => onPauseWorkstream(item, triagePlacement),
                        `Paused ${workstreamTitle}.`
                      );
                    }}
                    className="mt-1 flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    Pause run
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={isRowBusy || isRunningRow}
                  onClick={() => {
                    setMenuKey(null);
                    void onDismiss(item);
                  }}
                  className="mt-1 flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-red-100 transition-colors hover:bg-red-500/[0.12] disabled:opacity-45"
                >
                  Remove from queue
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.article>
    </Reorder.Item>
  );
}
