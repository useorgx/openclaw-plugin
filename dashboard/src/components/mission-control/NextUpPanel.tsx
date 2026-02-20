import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Skeleton } from '@/components/shared/Skeleton';
import { InlineToast } from '@/components/shared/InlineToast';
import { openBillingPortal, openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { sanitizeDisplayText } from '@/lib/humanize';
import { useNextUpQueue, type NextUpQueueItem } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import type { NextUpQueueBulkAction } from '@/types';

interface NextUpPanelProps {
  initiativeId?: string | null;
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
  selectionEnabled?: boolean;
  panelStyle?: 'card' | 'flat';
  showQueueSettings?: boolean;
}

interface ActionGlyphProps {
  className?: string;
}

type QueuePlacement = 'top' | 'bottom';
const NEXT_UP_DISMISSED_KEY = 'orgx.dashboard.nextup.dismissed.v1';

function readDismissedQueueKeys(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(NEXT_UP_DISMISSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 400);
  } catch {
    return [];
  }
}

function writeDismissedQueueKeys(keys: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (keys.length === 0) {
      window.localStorage.removeItem(NEXT_UP_DISMISSED_KEY);
      return;
    }
    window.localStorage.setItem(NEXT_UP_DISMISSED_KEY, JSON.stringify(keys.slice(0, 400)));
  } catch {
    // ignore persistence issues
  }
}

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

function queueHighlight(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'from-teal-300/0 via-teal-300/60 to-teal-300/0';
  if (queueState === 'blocked') return 'from-amber-300/0 via-amber-300/55 to-amber-300/0';
  if (queueState === 'idle') return 'from-white/0 via-white/35 to-white/0';
  return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
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
  selectionEnabled = true,
  panelStyle = 'card',
  showQueueSettings = true,
}: NextUpPanelProps) {
  const [localCompact, setLocalCompact] = useState(compact);
  useEffect(() => setLocalCompact(compact), [compact]);
  const isCompact = allowCompactToggle && !onToggleCompact ? localCompact : compact;
  const setCompact = (next: boolean) => {
    if (onToggleCompact) onToggleCompact(next);
    else setLocalCompact(next);
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [triagePlacement, setTriagePlacement] = useState<QueuePlacement>('bottom');
  const [upgradeGate, setUpgradeGate] = useState<UpgradeRequiredError | null>(
    null
  );
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [dismissedKeys, setDismissedKeys] = useState<string[]>(() => readDismissedQueueKeys());
  const [queueSettingsOpen, setQueueSettingsOpen] = useState(false);
  const [signalToastHidden, setSignalToastHidden] = useState(false);
  const queueSettingsRef = useRef<HTMLDivElement | null>(null);
  const {
    items,
    degraded,
    isLoading,
    isFetching,
    error,
    playWorkstream,
    startWorkstreamAutoContinue,
  } = useNextUpQueue({
    initiativeId,
    authToken,
    embedMode,
    enabled: true,
  });

  const nextUpActions = useNextUpQueueActions({ authToken, embedMode });
  const itemKey = (item: NextUpQueueItem) => `${item.initiativeId}:${item.workstreamId}`;
  const dismissedKeySet = useMemo(() => new Set(dismissedKeys), [dismissedKeys]);
  const activeElsewhereCount = useMemo(
    () => items.filter((item) => item.queueState === 'running' || item.queueState === 'blocked').length,
    [items]
  );
  const queueItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !dismissedKeySet.has(itemKey(item)) &&
          item.queueState !== 'running' &&
          item.queueState !== 'blocked'
      ),
    [dismissedKeySet, items]
  );
  const hiddenCount = Math.max(0, items.length - queueItems.length - activeElsewhereCount);

  const visibleItems = useMemo(
    () => (isCompact ? queueItems.slice(0, 5) : queueItems),
    [isCompact, queueItems]
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
    writeDismissedQueueKeys(dismissedKeys);
  }, [dismissedKeys]);

  useEffect(() => {
    if (dismissedKeys.length === 0) return;
    const liveKeys = new Set(items.map(itemKey));
    const filtered = dismissedKeys.filter((key) => liveKeys.has(key));
    if (filtered.length !== dismissedKeys.length) {
      setDismissedKeys(filtered);
    }
  }, [dismissedKeys, items]);

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
    // Optimistic: hide immediately in the UI
    setDismissedKeys((previous) => {
      if (previous.includes(key)) return previous;
      return [key, ...previous].slice(0, 400);
    });
    try {
      await nextUpActions.remove({
        initiativeId: item.initiativeId,
        workstreamId: item.workstreamId,
      });
      setNotice(`Removed ${label} from queue.`);
    } catch (err) {
      // Revert optimistic dismiss on failure
      setDismissedKeys((previous) => previous.filter((k) => k !== key));
      setNotice(err instanceof Error ? err.message : 'Failed to remove from queue');
    }
  };

  const toggleSelection = (key: string) => {
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedKeys(new Set(visibleItems.map(itemKey)));
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
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

      if (action === 'remove') {
        const removedKeys = new Set(selectedItems.map((entry) => entry.key));
        setDismissedKeys((previous) => {
          const next = new Set(previous);
          for (const key of removedKeys) next.add(key);
          return Array.from(next).slice(0, 400);
        });
      }

      const updated =
        typeof (result as { updated?: unknown })?.updated === 'number'
          ? ((result as { updated: number }).updated ?? 0)
          : 0;
      const failed =
        typeof (result as { failed?: unknown })?.failed === 'number'
          ? ((result as { failed: number }).failed ?? 0)
          : 0;

      const label =
        action === 'remove'
          ? 'removed'
          : action === 'move_top'
            ? 'moved to top'
            : 'moved to bottom';
      setNotice(
        failed > 0
          ? `${updated} item${updated === 1 ? '' : 's'} ${label}; ${failed} failed.`
          : `${updated} item${updated === 1 ? '' : 's'} ${label}.`
      );
      setSelectedKeys(new Set());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Bulk queue action failed');
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
        setNotice(err instanceof Error ? err.message : 'Action failed');
      }
    } finally {
      setActionKey(null);
    }
  };

  const statusTone: 'upgrade' | 'error' | 'notice' | null = upgradeGate
    ? 'upgrade'
    : error
      ? 'error'
      : notice
        ? 'notice'
        : null;

  const showStatusBanner = statusTone !== null;
  const showSignalToast = degraded.length > 0 && !signalToastHidden;
  const selectedCount = visibleSelection.length;

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
            {isLoading ? (
              <Skeleton className="h-5 w-10 rounded-full" />
            ) : (
              <span className="chip text-micro">{queueItems.length}</span>
            )}
            {!isLoading && hiddenCount > 0 && (
              <span className="chip text-micro text-secondary">{hiddenCount} hidden</span>
            )}
            {!isLoading && activeElsewhereCount > 0 && (
              <span className="chip text-micro text-secondary">{activeElsewhereCount} active elsewhere</span>
            )}
            {isFetching && !isLoading && (
              <span className="text-micro text-muted">refreshing…</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {!isLoading && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setDismissedKeys([]);
                  setNotice('Restored hidden queue items.');
                }}
                className="control-pill h-8 flex-shrink-0 whitespace-nowrap px-3 text-caption font-semibold"
                title="Show queue items removed from this view"
              >
                Show hidden
              </button>
            )}
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
                            setNotice(err instanceof Error ? err.message : 'Checkout failed')
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
                            setNotice(err instanceof Error ? err.message : 'Portal failed')
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
            ) : statusTone === 'error' && error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="rounded-xl border border-red-400/25 bg-red-500/[0.08] px-3 py-2 text-caption text-red-100"
              >
                {error}
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
        {!isLoading && queueItems.length > 0 ? (
          <div className="flex items-center justify-between gap-2 px-0.5">
            <div className="min-w-0">
              <p className="truncate text-micro uppercase tracking-[0.08em] text-muted">
                Queue mode · {triagePlacement === 'top' ? 'Play next default' : 'Add to end default'}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                {selectedCount > 0 ? (
                  <span className="chip text-micro">{selectedCount} selected</span>
                ) : null}
                {isFetching && !isLoading ? (
                  <span className="text-micro text-muted">refreshing…</span>
                ) : null}
                {hiddenCount > 0 ? (
                  <span className="text-micro text-muted">{hiddenCount} hidden</span>
                ) : null}
              </div>
            </div>
            <div ref={queueSettingsRef} className="relative flex flex-shrink-0 items-center gap-1.5">
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
              {showQueueSettings ? (
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
              ) : null}
              {queueSettingsOpen ? (
                <div className="surface-tier-2 absolute right-0 top-[calc(100%+8px)] z-[280] w-[320px] max-w-[86vw] rounded-xl p-3 shadow-[0_18px_42px_rgba(0,0,0,0.46)] backdrop-blur-xl">
                  <div className="space-y-2.5">
                    <div>
                      <p className="section-kicker">Queue default</p>
                      <div className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-strong bg-white/[0.03] p-0.5">
                        <button
                          type="button"
                          onClick={() => setTriagePlacement('top')}
                          className={`h-7 rounded px-2.5 text-micro font-semibold transition-colors ${
                            triagePlacement === 'top'
                              ? 'bg-[#BFFF00]/14 text-[#E1FFB2]'
                              : 'text-secondary hover:bg-white/[0.08] hover:text-primary'
                          }`}
                        >
                          Play next
                        </button>
                        <button
                          type="button"
                          onClick={() => setTriagePlacement('bottom')}
                          className={`h-7 rounded px-2.5 text-micro font-semibold transition-colors ${
                            triagePlacement === 'bottom'
                              ? 'bg-[#BFFF00]/14 text-[#E1FFB2]'
                              : 'text-secondary hover:bg-white/[0.08] hover:text-primary'
                          }`}
                        >
                          Add to end
                        </button>
                      </div>
                    </div>

                    {selectionEnabled && !isCompact ? (
                      <div>
                        <p className="section-kicker">Bulk actions</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={selectAllVisible}
                            className="control-pill h-7 px-2.5 text-micro font-semibold"
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            onClick={clearSelection}
                            disabled={selectedKeys.size === 0}
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            disabled={selectedCount === 0 || actionKey === 'bulk:move_top'}
                            onClick={() => void runBulkQueueAction('move_top')}
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                          >
                            Move top
                          </button>
                          <button
                            type="button"
                            disabled={selectedCount === 0 || actionKey === 'bulk:move_bottom'}
                            onClick={() => void runBulkQueueAction('move_bottom')}
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                          >
                            Move bottom
                          </button>
                          <button
                            type="button"
                            disabled={selectedCount === 0 || actionKey === 'bulk:remove'}
                            onClick={() => void runBulkQueueAction('remove')}
                            className="control-pill h-7 px-2.5 text-micro font-semibold disabled:opacity-45"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {hiddenCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDismissedKeys([]);
                          setNotice('Restored hidden queue items.');
                        }}
                        className="control-pill h-7 px-2.5 text-micro font-semibold"
                      >
                        Show hidden ({hiddenCount})
                      </button>
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
          </div>
        ) : null}

        {isLoading ? (
          <NextUpLoadingSkeleton compact={isCompact} />
        ) : null}

        {!isLoading && visibleItems.length === 0 && !error && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-4 text-center text-body text-secondary">
            No queued workstreams right now.
          </div>
        )}

        {!isLoading && isCompact ? (
          <AnimatePresence initial={false}>
            {visibleItems.map((item, index) => {
              const key = itemKey(item);
              const isRowBusy = actionKey === key;
              const isRunningRow = item.queueState === 'running';
              const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;
                const initiativeTitle = sanitizeDisplayText(item.initiativeTitle);
                const workstreamTitle = sanitizeDisplayText(item.workstreamTitle);
                const nextTaskTitle = item.nextTaskTitle
                  ? sanitizeDisplayText(item.nextTaskTitle)
                  : null;
                const blockReason = item.blockReason ? sanitizeDisplayText(item.blockReason) : null;

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
                  className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-2.5 py-2"
                >
                  <div
                    className={`pointer-events-none absolute inset-x-2.5 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
                    aria-hidden
                  />

                  <div className="flex min-w-0 items-center gap-2.5">
                    <AgentAvatar
                      name={item.runnerAgentName}
                      hint={`${item.runnerAgentId} ${item.runnerSource}`}
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
                          className="block w-full truncate text-left text-micro uppercase tracking-[0.08em] text-muted transition-colors hover:text-white/72"
                          title={initiativeTitle}
                        >
                          {initiativeTitle}
                        </button>
                      </div>
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption font-semibold leading-snug text-white" title={workstreamTitle}>
                        <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
                        <span className="line-clamp-2">{workstreamTitle}</span>
                      </p>
                      {nextTaskTitle ? (
                        <p className="mt-0.5 line-clamp-2 text-micro leading-snug text-secondary" title={`Next: ${nextTaskTitle}${dueText ? ` · ${dueText}` : ''}`}>
                          Next: {nextTaskTitle}
                          {dueText ? ` · ${dueText}` : ''}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {blockReason && (
                    <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
                      Blocked: {blockReason}
                    </div>
                  )}

                  <div className="mt-1.5 flex items-center gap-1.5">
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
                        <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[178px] rounded-xl border border-white/[0.1] bg-[#080d14]/95 p-1.5 shadow-[0_16px_36px_rgba(0,0,0,0.42)] backdrop-blur">
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
                                `Start+Auto enabled for ${initiativeTitle}.`
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
        ) : !isLoading ? (
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
          message={degraded[0] ?? null}
          className="pointer-events-auto"
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
  selected: boolean;
  selectionEnabled: boolean;
  onToggleSelection: (key: string) => void;
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
  onCommitReorder: () => void;
  onDismiss: (item: NextUpQueueItem) => void;
  runAction: (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string)
  ) => Promise<void>;
}) {
  const controls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);
  const key = `${item.initiativeId}:${item.workstreamId}`;
  const isRowBusy = actionKey === key;
  const isRunningRow = item.queueState === 'running';
  const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;
  const initiativeTitle = sanitizeDisplayText(item.initiativeTitle);
  const workstreamTitle = sanitizeDisplayText(item.workstreamTitle);
  const nextTaskTitle = item.nextTaskTitle ? sanitizeDisplayText(item.nextTaskTitle) : null;
  const blockReason = item.blockReason ? sanitizeDisplayText(item.blockReason) : null;

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
        className="group relative overflow-visible rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
      >

        <div
          className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
          aria-hidden
        />

        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex flex-1 items-start gap-2.5">
            <div className="relative flex-shrink-0">
              <AgentAvatar
                name={item.runnerAgentName}
                hint={`${item.runnerAgentId} ${item.runnerSource}`}
                size="sm"
              />
              {selectionEnabled ? (
                <motion.label
                  initial={false}
                  animate={{
                    opacity: selected ? 1 : 0,
                    scale: selected ? 1 : 0.8,
                  }}
                  transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                  className={`absolute -left-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 backdrop-blur-sm ${
                    selected
                      ? 'pointer-events-auto'
                      : 'pointer-events-none group-hover:pointer-events-auto group-hover:!opacity-100 group-hover:!scale-100 group-focus-within:pointer-events-auto group-focus-within:!opacity-100'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelection(key)}
                    className="h-3.5 w-3.5 rounded border-white/20 bg-black/50 text-[#BFFF00] focus:ring-[#BFFF00]/35"
                    aria-label="Select queue row"
                  />
                </motion.label>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <EntityIcon type="initiative" size={11} className="flex-shrink-0 opacity-85" />
                <button
                  type="button"
                  onClick={() => onOpenInitiative?.(item.initiativeId, item.initiativeTitle)}
                  className="block w-full truncate text-left text-micro uppercase tracking-[0.08em] text-muted transition-colors hover:text-white/72"
                  title={initiativeTitle}
                >
                  {initiativeTitle}
                </button>
              </div>
              <div className="mt-0.5 flex min-w-0 items-start gap-1.5">
                <EntityIcon type="workstream" size={12} className="mt-[3px] flex-shrink-0 opacity-95" />
                <p className="min-w-0 line-clamp-2 text-body font-semibold leading-snug text-white" title={workstreamTitle}>
                  {workstreamTitle}
                </p>
              </div>
            </div>
          </div>

        </div>

        <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2 text-caption text-white/68">
          {nextTaskTitle ? (
            <div className="space-y-1">
              <div className="flex min-w-0 items-center gap-1 text-micro uppercase tracking-[0.08em] text-white/44">
                <EntityIcon type="task" size={10} className="flex-shrink-0 opacity-80" />
                <span>Next</span>
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
            <span className="text-secondary">No task currently queued.</span>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-micro text-secondary">
          <span className="truncate text-white/68">
            {item.runnerAgentName}
            {item.runnerSource !== 'assigned' ? ` · ${item.runnerSource}` : ''}
          </span>
        </div>

        {blockReason && (
          <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-micro text-red-100/85">
            Blocked: {blockReason}
          </div>
        )}

        <div className="mt-2 flex items-center gap-1.5">
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
              <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[198px] rounded-xl border border-white/[0.1] bg-[#080d14]/95 p-1.5 shadow-[0_16px_36px_rgba(0,0,0,0.42)] backdrop-blur">
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
                      async () => {
                        await onMoveWorkstream(item, 'top');
                        return startWorkstreamAutoContinue({
                          initiativeId: item.initiativeId,
                          workstreamId: item.workstreamId,
                          agentId: item.runnerAgentId,
                          scope: 'initiative',
                        });
                      },
                      `Start+Auto enabled for ${initiativeTitle}.`
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
