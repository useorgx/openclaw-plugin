import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { colors, missionControlMotion, stateTones } from '@/lib/tokens';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Skeleton } from '@/components/shared/Skeleton';
import { InlineToast } from '@/components/shared/InlineToast';
import { openBillingPortal, openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { humanizeId, humanizeWarning, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { QueueState, queueTone, queueLabel, queueStateRank, queueHighlight, queueTaskHeading, deriveQueueState } from '@/lib/queueStateMap';
import { useNextUpQueue, type NextUpQueueItem, type UseNextUpQueueResult, type ZoomLevel, type InitiativeGroupItem, type MilestoneGroupItem } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import { EmptyState } from '@/components/shared/EmptyState';
import { SegmentedProgressBar } from '@/components/shared/ScopeProgressCard';
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
  onPlayWorkstream?: (item: NextUpQueueItem) => Promise<unknown>;
  snapshotVersion?: number | null;
  excludeRunning?: boolean;
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

// Queue state UI mappings imported from @/lib/queueStateMap

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

  if (item.queueState === QueueState.RUNNING) {
    return sliceCountLabel
      ? `Executing ${sliceCountLabel} in ${scopeLabel}.`
      : 'Execution in progress. Task detail will appear as the scheduler advances.';
  }
  if (item.queueState === QueueState.BLOCKED) {
    return item.blockReason
      ? 'Blocked while waiting for dependency resolution.'
      : 'Blocked. Waiting for dependency or review.';
  }
  if (item.queueState === QueueState.QUEUED) {
    return sliceCountLabel
      ? `Queued with ${sliceCountLabel} in ${scopeLabel}.`
      : 'Queued at workstream scope. Task detail will populate after dispatch.';
  }
  if (item.queueState === QueueState.COMPLETED) {
    return 'Completed. No queued tasks remain.';
  }
  return 'Idle. Ready to dispatch when started.';
}

function canStartQueueItem(item: NextUpQueueItem): boolean {
  if (typeof item.canStartNow === 'boolean') return item.canStartNow;
  if (item.queueState === QueueState.RUNNING || item.queueState === QueueState.BLOCKED) return false;
  if (item.queueState === QueueState.COMPLETED) return false;
  if (item.autoContinue?.status === 'running' || item.autoContinue?.status === 'stopping') return false;
  return item.queueState === QueueState.QUEUED || item.queueState === QueueState.IDLE;
}

function startButtonTitle(item: NextUpQueueItem, isRunningRow: boolean): string {
  if (isRunningRow) return 'Already running';
  if (canStartQueueItem(item)) {
    return item.startReasonLabel?.trim() || 'Start now';
  }
  return item.startReasonLabel?.trim() || item.blockReason?.trim() || 'This workstream is not ready to start';
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
          ? 'border-lime/35 bg-lime/14 text-lime'
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

function formatQueueDegradedMessage(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  // Suppress non-actionable system messages — users can't fix circular deps or timeline
  // estimation quirks, so showing them as toasts only creates anxiety.
  if (
    normalized.includes('circular') ||
    normalized.includes('timeline estimate') ||
    normalized.includes('adjusted accordingly')
  ) {
    return null;
  }
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
  const message =
    record && typeof record.message === 'string' ? sanitizeDisplayText(record.message) : null;
  if (message) return message;
  const outcome =
    record && typeof record.outcome === 'string' ? record.outcome : null;
  if (outcome === 'slice_completed') {
    return `${workstreamLabel} completed before the queue refreshed.`;
  }
  if (outcome === 'slice_blocked') {
    return item.startReasonLabel?.trim() || `${workstreamLabel} needs your input before it can continue.`;
  }
  if (outcome === 'fallback_started') {
    return `Dispatched ${workstreamLabel} using fallback runner.`;
  }
  if (outcome === 'dispatch_pending') {
    return `Dispatching ${workstreamLabel}; waiting for slice start…`;
  }
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

function autoContinueNotice(item: NextUpQueueItem, payload: unknown): string {
  const initiativeLabel = sanitizeDisplayText(item.initiativeTitle);
  const workstreamLabel = sanitizeDisplayText(item.workstreamTitle);
  const record = asRecord(payload);
  const outcome = record && typeof record.outcome === 'string' ? record.outcome : null;
  if (outcome === 'blocked') {
    return `${workstreamLabel} started under autopilot, but it immediately needs your input.`;
  }
  if (outcome === 'completed') {
    return `${workstreamLabel} completed immediately under autopilot in ${initiativeLabel}.`;
  }
  if (outcome === 'error') {
    return `${workstreamLabel} hit an error before autopilot could continue ${initiativeLabel}.`;
  }
  if (outcome === 'pending') {
    return `Autopilot is preparing the next slice for ${initiativeLabel}.`;
  }
  if (outcome === 'started') {
    return `Autopilot started ${workstreamLabel} in ${initiativeLabel}.`;
  }
  const message =
    record && typeof record.message === 'string' ? sanitizeDisplayText(record.message) : null;
  if (message) return message;
  return `Auto enabled for ${initiativeLabel}.`;
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
        <div className="flex gap-0.5" aria-label="Loading">
          <span className="h-1 w-1 rounded-full bg-lime/70 animate-[pulse_1.4s_ease-in-out_infinite]" />
          <span className="h-1 w-1 rounded-full bg-lime/50 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
          <span className="h-1 w-1 rounded-full bg-lime/30 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
        </div>
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
  onPlayWorkstream,
  snapshotVersion = null,
  excludeRunning = false,
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
  const prefersReducedMotion = useReducedMotion();
  const queueSettingsRef = useRef<HTMLDivElement | null>(null);
  const queueScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const internalQueue = useNextUpQueue({
    initiativeId,
    projectId,
    limit: 40,
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
    isFetchingNextPage,
    hasNextPage,
    error,
    refetch,
    fetchNextPage,
    playWorkstream,
    startWorkstreamAutoContinue,
    initiativeGroups,
    milestoneGroups,
  } = queue;

  const internalNextUpActions = useNextUpQueueActions({ authToken, embedMode, projectId });
  const nextUpActions = queueActions ?? internalNextUpActions;
  const itemKey = (item: NextUpQueueItem) => `${item.initiativeId}:${item.workstreamId}`;
  const isWorkstreamView = zoomLevel === 'workstream';
  const cardEnterTransition = useMemo(
    () =>
      prefersReducedMotion
        ? { duration: 0.01 }
        : missionControlMotion.surfaceSwitch,
    [prefersReducedMotion]
  );

  const queueItems = useMemo(
    () => items.filter((item) => item.queueState !== QueueState.RUNNING),
    [items]
  );
  const queueDisplayMode = useMemo<'queued' | 'blocked' | 'running' | 'empty'>(() => {
    const hasRunningItems = items.some((item) => item.queueState === QueueState.RUNNING);
    if (queueItems.length === 0) {
      return hasRunningItems ? QueueState.RUNNING : 'empty';
    }
    if (queueItems.some((item) => item.queueState !== QueueState.RUNNING && item.queueState !== QueueState.BLOCKED)) {
      return QueueState.QUEUED;
    }
    if (queueItems.some((item) => item.queueState === QueueState.BLOCKED)) return QueueState.BLOCKED;
    return hasRunningItems ? QueueState.RUNNING : QueueState.QUEUED;
  }, [items, queueItems]);

  const filteredInitiativeGroups = useMemo(
    () => {
      if (!excludeRunning) return initiativeGroups;
      const result: typeof initiativeGroups = [];
      for (const group of initiativeGroups) {
        const filtered = group.items.filter((item) => item.queueState !== QueueState.RUNNING);
        if (filtered.length === 0) continue;
        result.push({ ...group, items: filtered, queueState: deriveQueueState(filtered) });
      }
      return result;
    },
    [excludeRunning, initiativeGroups]
  );

  const sortedInitiativeGroups = useMemo(
    () =>
      [...filteredInitiativeGroups].sort((left, right) => {
        const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
        if (queueDelta !== 0) return queueDelta;
        return left.initiativeTitle.localeCompare(right.initiativeTitle);
      }),
    [filteredInitiativeGroups]
  );

  const filteredMilestoneGroups = useMemo(
    () => {
      if (!excludeRunning) return milestoneGroups;
      return milestoneGroups.filter((group) => group.item.queueState !== QueueState.RUNNING);
    },
    [excludeRunning, milestoneGroups]
  );

  const sortedMilestoneGroups = useMemo(
    () =>
      [...filteredMilestoneGroups].sort((left, right) => {
        const queueDelta = queueStateRank(left.queueState) - queueStateRank(right.queueState);
        if (queueDelta !== 0) return queueDelta;
        const initiativeDelta = left.initiativeTitle.localeCompare(right.initiativeTitle);
        if (initiativeDelta !== 0) return initiativeDelta;
        const workstreamDelta = left.workstreamTitle.localeCompare(right.workstreamTitle);
        if (workstreamDelta !== 0) return workstreamDelta;
        return left.milestoneTitle.localeCompare(right.milestoneTitle);
      }),
    [filteredMilestoneGroups]
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

  const zoomOptions: Array<{ value: ZoomLevel; label: string }> = [
    { value: 'initiative', label: 'Initiative' },
    { value: 'workstream', label: 'Workstream' },
    { value: 'milestone', label: 'Milestone' },
  ];

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

  useEffect(() => {
    if (!hasNextPage) return;
    const root = queueScrollContainerRef.current;
    const target = loadMoreSentinelRef.current;
    if (!root || !target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (isLoading || isFetchingNextPage) return;
        void fetchNextPage().catch(() => null);
      },
      {
        root,
        rootMargin: '220px 0px 220px 0px',
        threshold: 0,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isLoading]);

  const removeQueueItem = async (item: NextUpQueueItem) => {
    const key = itemKey(item);
    const label = sanitizeDisplayText(item.workstreamTitle);
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
    successMessage: string | ((result: unknown) => string)
  ) => {
    setNotice(null);
    setUpgradeGate(null);
    onUpgradeGate?.(null);
    setActionKey(key);
    try {
      const result = await action();
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    } catch (err) {
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

  const launchWorkstream = async (item: NextUpQueueItem) => {
    if (onPlayWorkstream) {
      return await onPlayWorkstream(item);
    }
    return await playWorkstream({
      initiativeId: item.initiativeId,
      workstreamId: item.workstreamId,
      agentId: item.runnerAgentId,
    });
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
    degraded.length > 0 && primaryDegradedMessage !== null && !signalToastHidden && menuKey === null && !queueSettingsOpen;
  const selectedCount = visibleSelection.length;
  const hasVisibleCards = useMemo(() => {
    if (zoomLevel === 'initiative') return visibleInitiativeGroups.length > 0;
    if (zoomLevel === 'milestone') return visibleMilestoneGroups.length > 0;
    return visibleItems.length > 0;
  }, [visibleInitiativeGroups.length, visibleItems.length, visibleMilestoneGroups.length, zoomLevel]);
  const showInlineBulkActions =
    selectionEnabled && isWorkstreamView && !isCompact && selectedCount > 0;
  // Count items filtered out as running to distinguish "all running" from "truly empty"
  const runningItemCount = useMemo(
    () => {
      let count = 0;
      for (const item of items) if (item.queueState === QueueState.RUNNING) count++;
      return count;
    },
    [items]
  );
  const emptyStateMessage =
    zoomLevel === 'initiative'
      ? 'No initiatives in the queue right now.'
      : zoomLevel === 'milestone'
        ? 'No milestone slices in the queue right now.'
        : runningItemCount > 0
          ? 'No queued workstreams right now. Active execution has moved to In Progress.'
          : degraded.length > 0 && primaryDegradedMessage
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
                'inline-flex min-w-[92px] justify-end text-micro text-muted transition-opacity',
                isFetching && !isLoading ? 'opacity-100' : 'opacity-0'
              )}
              aria-live="polite"
            >
              refreshing…
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="inline-flex items-center rounded-xl border border-white/[0.1] bg-white/[0.03] p-1"
              role="tablist"
              aria-label="Next Up scope"
            >
              {zoomOptions.map((option) => {
                const selected = zoomLevel === option.value;
                return (
                  <motion.button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setZoomLevel(option.value)}
                    {...missionControlMotion.segmentedTap}
                    className={cn(
                      'relative h-7 rounded-lg px-2.5 text-caption font-semibold transition-colors',
                      selected
                        ? 'text-lime'
                        : 'text-secondary hover:text-white'
                    )}
                    title={`Show ${option.label.toLowerCase()} queue`}
                  >
                    {selected ? (
                      <motion.span
                        layoutId="next-up-scope-indicator"
                        transition={
                          prefersReducedMotion
                            ? { duration: 0.01 }
                            : missionControlMotion.railMorphSpring
                        }
                        className="pointer-events-none absolute inset-0 rounded-lg border border-lime/35 bg-lime/16"
                        aria-hidden
                      />
                    ) : null}
                    <span className="relative z-[1]">{option.label}</span>
                  </motion.button>
                );
              })}
            </div>
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

      {showStatusBanner && (
        <div className="px-3 pt-2">
          <AnimatePresence initial={false} mode="wait">
            {statusTone === 'upgrade' && upgradeGate ? (
              <motion.div
                key="upgrade"
                initial={{ opacity: 0, y: -4, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.99 }}
                transition={cardEnterTransition}
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
                transition={cardEnterTransition}
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
                transition={cardEnterTransition}
                className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-caption text-primary"
              >
                {notice}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      <div
        ref={queueScrollContainerRef}
        className={`flex-1 space-y-2.5 overflow-y-auto overscroll-y-contain scroll-smooth px-3 pb-3 ${
          showHeader ? 'pt-1' : 'pt-2.5'
        }`}
      >
        {!isLoading && displayCount > 0 ? (
          <div className="flex flex-col gap-2.5 px-0.5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
                  <p className="truncate text-micro uppercase tracking-[0.08em] text-muted">
                    {zoomLevel === 'initiative'
                      ? 'Initiatives'
                      : zoomLevel === 'milestone'
                        ? 'Milestone slices'
                        : queueDisplayMode === QueueState.BLOCKED
                          ? 'Needs attention'
                          : queueDisplayMode === QueueState.RUNNING
                            ? 'Running now'
                            : 'Next Up'}
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
          <EmptyState
            icon="queue"
            headline={emptyStateMessage}
            description={
              runningItemCount > 0
                ? 'Check the In Progress tab to see active work.'
                : primaryDegradedMessage ?? 'Create an initiative or add workstreams to populate the queue.'
            }
            primaryAction={degraded.length > 0 && primaryDegradedMessage ? {
              label: 'Retry now',
              onClick: () => {
                setSignalToastHidden(false);
                void refetch();
              },
            } : undefined}
          />
        )}

        {!isLoading && zoomLevel === 'initiative' ? (
          <AnimatePresence initial={false}>
            {visibleInitiativeGroups.map((group, index) => {
              const firstRunnable =
                group.items.find((item) => canStartQueueItem(item)) ?? group.items[0] ?? null;
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
                    duration: prefersReducedMotion
                      ? 0.01
                      : missionControlMotion.surfaceSwitch.duration,
                    delay: prefersReducedMotion
                      ? 0
                      : Math.min(index, missionControlMotion.listStaggerMaxItems) *
                        missionControlMotion.listStaggerStep,
                    ease: missionControlMotion.surfaceSwitch.ease,
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
                          (result) => playDispatchNotice(firstRunnable, result)
                        );
                      }}
                      className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                      title={
                        firstRunnable
                          ? startButtonTitle(firstRunnable, firstRunnable.queueState === QueueState.RUNNING)
                          : 'No dispatchable workstream is available'
                      }
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
                    duration: prefersReducedMotion
                      ? 0.01
                      : missionControlMotion.surfaceSwitch.duration,
                    delay: prefersReducedMotion
                      ? 0
                      : Math.min(index, missionControlMotion.listStaggerMaxItems) *
                        missionControlMotion.listStaggerStep,
                    ease: missionControlMotion.surfaceSwitch.ease,
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
                      disabled={actionKey === busyKey || !canStartQueueItem(item)}
                      onClick={() =>
                        void runAction(
                          busyKey,
                          () => launchWorkstream(item),
                          (result) => playDispatchNotice(item, result)
                        )
                      }
                      className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                      title={startButtonTitle(item, group.queueState === QueueState.RUNNING)}
                    >
                      {group.queueState === QueueState.RUNNING ? 'Running' : canStartQueueItem(item) ? 'Start' : 'Unavailable'}
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
              const isRunningRow = item.queueState === QueueState.RUNNING;
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
              const openQueueDetail = () => onOpenSliceDetail?.(item);

              return (
                <motion.article
                  layout
                  key={key}
                  initial={{ opacity: 0, y: 6, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{
                    duration: prefersReducedMotion
                      ? 0.01
                      : missionControlMotion.surfaceSwitch.duration,
                    delay: prefersReducedMotion
                      ? 0
                      : Math.min(index, missionControlMotion.listStaggerMaxItems) *
                        missionControlMotion.listStaggerStep,
                    ease: missionControlMotion.surfaceSwitch.ease,
                  }}
                  className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-2.5 py-2 cursor-pointer transition-colors hover:border-white/[0.14]"
                  onClick={openQueueDetail}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQueueDetail(); } }}
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
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openQueueDetail();
                          }}
                          className="min-w-0 text-left text-caption font-semibold leading-snug text-white transition-colors hover:text-white/78"
                          title={`Open details for ${workstreamTitle}`}
                          aria-label={`Open details for ${workstreamTitle}`}
                        >
                          <span className="line-clamp-2">{workstreamTitle}</span>
                        </button>
                      </div>
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
                      {/* Milestone progress strip */}
                      {item.milestoneBreakdown && item.milestoneBreakdown.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          <SegmentedProgressBar milestones={item.milestoneBreakdown} />
                          <p className="text-micro text-secondary">
                            {item.milestoneBreakdown.length} milestone{item.milestoneBreakdown.length !== 1 ? 's' : ''}
                            {' · '}
                            {item.milestoneBreakdown.reduce((s, m) => s + m.doneTasks, 0)}/
                            {item.milestoneBreakdown.reduce((s, m) => s + m.totalTasks, 0)} tasks done
                          </p>
                        </div>
                      )}
                      {/* Completed counts strip */}
                      {item.queueState === QueueState.COMPLETED && item.milestoneBreakdown && item.milestoneBreakdown.length > 0 && (
                        <div
                          className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro"
                          style={{ color: stateTones.done.text }}
                        >
                          <span>✓ {item.milestoneBreakdown.length} milestones</span>
                          <span>✓ {item.milestoneBreakdown.reduce((s, m) => s + m.totalTasks, 0)} tasks</span>
                        </div>
                      )}
                      {/* Scoring tier + estimate */}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {(() => {
                          const score = item.objectiveScore ?? item.compositeScore ?? null;
                          if (score == null) return null;
                          const tier = score >= 80 ? 'S' : score >= 60 ? 'A' : 'B';
                          const tierColor = tier === 'S' ? 'border-lime/30 bg-lime/[0.12] text-lime'
                            : tier === 'A' ? 'border-[#14B8A6]/30 bg-[#14B8A6]/[0.12] text-[#87FFE9]'
                            : 'border-white/[0.12] bg-white/[0.05] text-white/60';
                          return (
                            <span className={`chip text-[9px] font-semibold ${tierColor}`}>
                              {tier}-tier
                            </span>
                          );
                        })()}
                        {(() => {
                          const expectedUsd = item.expectedValueUsd;
                          const taskCount = item.sliceTaskCount ?? 0;
                          const parts: string[] = [];
                          if (taskCount > 0) parts.push(`${taskCount} tasks`);
                          if (typeof expectedUsd === 'number' && expectedUsd > 0) parts.push(`$${expectedUsd.toFixed(2)}`);
                          if (dueText) parts.push(dueText);
                          if (parts.length === 0) return null;
                          return <span className="text-micro text-muted">{parts.join(' · ')}</span>;
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Mini progress bar */}
                  {(item.sliceTaskCount ?? 0) > 0 && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-b-2xl overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(item.queueState === QueueState.COMPLETED ? 100 : item.queueState === QueueState.RUNNING ? 50 : 15, 4)}%`,
                          background: item.queueState === QueueState.COMPLETED
                            ? colors.teal
                            : `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
                          opacity: 0.6,
                        }}
                      />
                    </div>
                  )}

                  {blockReason && (
                    <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
                      Blocked: {blockReason}
                    </div>
                  )}

                  {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                  <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={isRowBusy}
                      onClick={() => onOpenSliceDetail?.(item)}
                      className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
                      title={`Open details for ${workstreamTitle}`}
                      aria-label={`Open details for ${workstreamTitle}`}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      disabled={isRowBusy || !canStartQueueItem(item)}
                      onClick={() =>
                        void runAction(
                          key,
                          () => launchWorkstream(item),
                          (result) => playDispatchNotice(item, result)
                        )
                      }
                      className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
                      title={startButtonTitle(item, isRunningRow)}
                    >
                      <span className="inline-flex items-center gap-1">
                        <PlayGlyph className="h-3 w-3 opacity-85" />
                        <span>{isRunningRow ? 'Running' : canStartQueueItem(item) ? 'Start' : 'Unavailable'}</span>
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
                              void runAction(
                                `${key}:top`,
                                () =>
                                  nextUpActions.move({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    placement: 'top',
                                  }),
                                `Moved ${workstreamTitle} to top of queue.`
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
                              void runAction(
                                `${key}:bottom`,
                                () =>
                                  nextUpActions.move({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    placement: 'bottom',
                                  }),
                                `Moved ${workstreamTitle} to bottom of queue.`
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
                              void runAction(
                                `${key}:auto`,
                                () =>
                                  startWorkstreamAutoContinue({
                                    initiativeId: item.initiativeId,
                                    workstreamId: item.workstreamId,
                                    agentId: item.runnerAgentId,
                                    scope: 'initiative',
                                  }),
                                (result) => autoContinueNotice(item, result)
                              );
                            }}
                            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                          >
                            Auto on
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
                  onPlayWorkstream={launchWorkstream}
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
                  onCommitReorder={() => void persistOrder().catch(() => null)}
                  onDismiss={removeQueueItem}
                  runAction={runAction}
                />
              ))}
          </Reorder.Group>
        ) : null}

        {(hasNextPage || isFetchingNextPage) && (
          <div ref={loadMoreSentinelRef} className="flex h-10 items-center justify-center">
            <span className="text-micro text-muted">
              {isFetchingNextPage ? 'Loading more queue items…' : 'Scroll for more'}
            </span>
          </div>
        )}
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
  onPlayWorkstream,
  startWorkstreamAutoContinue,
  triagePlacement,
  onPauseWorkstream,
  onMoveWorkstream,
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
  onPlayWorkstream: (item: NextUpQueueItem) => Promise<unknown>;
  startWorkstreamAutoContinue: (input: {
    initiativeId: string;
    workstreamId: string;
    agentId?: string | null;
    scope?: 'initiative' | 'workstream';
  }) => Promise<unknown>;
  triagePlacement: QueuePlacement;
  onPauseWorkstream: (item: NextUpQueueItem, placement: QueuePlacement) => Promise<unknown>;
  onMoveWorkstream: (item: NextUpQueueItem, placement: QueuePlacement) => Promise<unknown>;
  onCommitReorder: () => void;
  onDismiss: (item: NextUpQueueItem) => void;
  runAction: (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string)
  ) => Promise<void>;
}) {
  const controls = useDragControls();
  const prefersReducedMotion = useReducedMotion();
  const [isDragging, setIsDragging] = useState(false);
  const key = `${item.initiativeId}:${item.workstreamId}`;
  const isRowBusy = actionKey === key;
  const isRunningRow = item.queueState === QueueState.RUNNING;
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
  const openQueueDetail = () => {
    onOpenSliceDetail?.(item);
  };

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
          duration: prefersReducedMotion
            ? 0.01
            : missionControlMotion.surfaceSwitch.duration,
          ease: missionControlMotion.surfaceSwitch.ease,
          delay: prefersReducedMotion
            ? 0
            : Math.min(index, missionControlMotion.listStaggerMaxItems) *
              missionControlMotion.listStaggerStep,
          opacity: {
            duration: prefersReducedMotion
              ? 0.01
              : missionControlMotion.surfaceSwitch.duration,
            ease: missionControlMotion.surfaceSwitch.ease,
          },
        }}
        className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 cursor-pointer transition-colors hover:border-white/[0.14]"
        onClick={openQueueDetail}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQueueDetail(); } }}
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
                      ? 'opacity-100 scale-100 border-lime/40 bg-lime/18 text-lime'
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
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openQueueDetail();
                  }}
                  className="min-w-0 text-left text-body font-semibold leading-snug text-white transition-colors hover:text-white/78"
                  title={`Open details for ${workstreamTitle}`}
                  aria-label={`Open details for ${workstreamTitle}`}
                >
                  <span className="line-clamp-2">{workstreamTitle}</span>
                </button>
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

        {/* Milestone breakdown (expanded card) */}
        {item.milestoneBreakdown && item.milestoneBreakdown.length > 0 && (
          <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2">
            <SegmentedProgressBar milestones={item.milestoneBreakdown} />
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {item.milestoneBreakdown.slice(0, 4).map((ms) => (
                <span key={ms.id} className="text-micro text-secondary">
                  {ms.doneTasks === ms.totalTasks && ms.totalTasks > 0 ? '✓' : '○'} {ms.title}
                  <span className="ml-1 text-muted">{ms.doneTasks}/{ms.totalTasks}</span>
                </span>
              ))}
              {item.milestoneBreakdown.length > 4 && (
                <span className="text-micro text-muted">+{item.milestoneBreakdown.length - 4}</span>
              )}
            </div>
          </div>
        )}

        {blockReason && (
          <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
            Blocked: {blockReason}
          </div>
        )}

        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            disabled={isRowBusy}
            onClick={openQueueDetail}
            className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
            title={`Open details for ${workstreamTitle}`}
            aria-label={`Open details for ${workstreamTitle}`}
          >
            Details
          </button>
          <button
            type="button"
            disabled={isRowBusy || !canStartQueueItem(item)}
            onClick={() =>
              void runAction(
                key,
                () => onPlayWorkstream(item),
                (result) => playDispatchNotice(item, result)
              )
            }
            className="control-pill flex h-7 items-center justify-center px-2.5 text-micro font-semibold disabled:opacity-40"
            title={startButtonTitle(item, isRunningRow)}
          >
            <span className="inline-flex items-center gap-1">
              <PlayGlyph className="h-3 w-3 opacity-85" />
              <span>{isRunningRow ? 'Running' : canStartQueueItem(item) ? 'Start' : 'Unavailable'}</span>
            </span>
          </button>
          <button
            type="button"
            onPointerDown={(event) => controls.start(event)}
            aria-label="Drag to reorder"
            title={isDragging ? 'Reordering' : 'Drag to reorder'}
            className={`control-pill flex h-7 items-center justify-center gap-1 px-2 text-micro font-semibold transition-colors ${
              isDragging
                ? 'border-lime/35 bg-lime/14 text-lime cursor-grabbing'
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
                    void runAction(
                      `${key}:top`,
                      () => onMoveWorkstream(item, 'top'),
                      `Moved ${workstreamTitle} to top of queue.`
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
                    void runAction(
                      `${key}:bottom`,
                      () => onMoveWorkstream(item, 'bottom'),
                      `Moved ${workstreamTitle} to bottom of queue.`
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
                    void runAction(
                      `${key}:auto`,
                      () =>
                        startWorkstreamAutoContinue({
                          initiativeId: item.initiativeId,
                          workstreamId: item.workstreamId,
                          agentId: item.runnerAgentId,
                          scope: 'initiative',
                        }),
                      (result) => autoContinueNotice(item, result)
                    );
                  }}
                  className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-caption text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Auto on
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
