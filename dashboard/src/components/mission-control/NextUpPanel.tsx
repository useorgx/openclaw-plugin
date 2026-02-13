import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { Skeleton } from '@/components/shared/Skeleton';
import { openBillingPortal, openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { useNextUpQueue, type NextUpQueueItem } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';

interface NextUpPanelProps {
  initiativeId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  title?: string;
  compact?: boolean;
  className?: string;
  disableEnterAnimation?: boolean;
  onFollowWorkstream?: (item: NextUpQueueItem) => void;
  onOpenInitiative?: (initiativeId: string, initiativeTitle?: string) => void;
  onOpenSettings?: () => void;
  onUpgradeGate?: (gate: UpgradeRequiredError | null) => void;
}

interface ActionGlyphProps {
  className?: string;
}

function FollowGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={className}
    >
      <path d="M2.5 10s2.6-4.2 7.5-4.2S17.5 10 17.5 10s-2.6 4.2-7.5 4.2S2.5 10 2.5 10Z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
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

function AutoGlyph({ className = '' }: ActionGlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={className}
    >
      {/* Infinity mark for auto-continue (optically tuned for small sizes). */}
      <path
        d="M6.4 13.05C4.5 13.05 3 11.7 3 10s1.5-3.05 3.4-3.05c2.7 0 3.7 3.05 5.6 3.05s2.9-3.05 5.6-3.05C17.5 6.95 19 8.3 19 10s-1.5 3.05-3.4 3.05c-2.7 0-3.7-3.05-5.6-3.05s-2.9 3.05-5.6 3.05Z"
        stroke="currentColor"
        strokeWidth="1.75"
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
  if (queueState === 'blocked') return 'border-red-400/35 bg-red-500/[0.12] text-red-100';
  if (queueState === 'idle') return 'border-white/[0.16] bg-white/[0.05] text-white/65';
  return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
}

function queueLabel(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'Running';
  if (queueState === 'blocked') return 'Blocked';
  if (queueState === 'idle') return 'Idle';
  return 'Queued';
}

function queueHighlight(queueState: NextUpQueueItem['queueState']): string {
  if (queueState === 'running') return 'from-teal-300/0 via-teal-300/60 to-teal-300/0';
  if (queueState === 'blocked') return 'from-red-300/0 via-red-300/55 to-red-300/0';
  if (queueState === 'idle') return 'from-white/0 via-white/35 to-white/0';
  return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
}

function NextUpLoadingSkeleton({ compact }: { compact: boolean }) {
  const cards = compact ? 3 : 6;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 px-1 pt-1 text-[10px] uppercase tracking-[0.12em] text-white/40">
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
  compact = false,
  className,
  disableEnterAnimation = false,
  onFollowWorkstream,
  onOpenInitiative,
  onOpenSettings,
  onUpgradeGate,
}: NextUpPanelProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [upgradeGate, setUpgradeGate] = useState<UpgradeRequiredError | null>(
    null
  );
  const [actionKey, setActionKey] = useState<string | null>(null);
  const {
    items,
    total,
    degraded,
    isLoading,
    isFetching,
    error,
    playWorkstream,
    startWorkstreamAutoContinue,
    stopInitiativeAutoContinue,
  } = useNextUpQueue({
    initiativeId,
    authToken,
    embedMode,
    enabled: true,
  });

  const nextUpActions = useNextUpQueueActions({ authToken, embedMode });

  const visibleItems = useMemo(
    () => (compact ? items.slice(0, 7) : items),
    [compact, items]
  );

  const itemKey = (item: NextUpQueueItem) => `${item.initiativeId}:${item.workstreamId}`;

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
      if (compact) return [];
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
  }, [compact, visibleKeysSignature]);

  useEffect(() => {
    orderedKeysRef.current = orderedKeys;
  }, [orderedKeys]);

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
    successMessage: string
  ) => {
    setNotice(null);
    setUpgradeGate(null);
    onUpgradeGate?.(null);
    setActionKey(key);
    try {
      await action();
      setNotice(successMessage);
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

  return (
    <PremiumCard
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        disableEnterAnimation ? '' : 'card-enter'
      } ${className ?? ''}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[14px] font-semibold text-white">{title}</h2>
          {isLoading ? (
            <Skeleton className="h-5 w-10 rounded-full" />
          ) : (
            <span className="chip text-[10px]">{total}</span>
          )}
          {isFetching && !isLoading && (
            <span className="text-[10px] text-white/38">refreshing…</span>
          )}
        </div>
      </div>

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
                className="rounded-xl border border-amber-200/25 bg-amber-200/10 px-3 py-2 text-[11px] text-amber-100"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-amber-200/25 bg-amber-200/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-100/90">
                        Upgrade required
                      </span>
                      <span className="truncate text-[10px] text-white/55">
                        {formatPlanLabel(upgradeGate.currentPlan)} →{' '}
                        {formatPlanLabel(upgradeGate.requiredPlan)}
                      </span>
                    </div>
                    <div
                      className="mt-1 line-clamp-2 text-[11px] leading-snug text-amber-50/90"
                      title={upgradeGate.message}
                    >
                      {upgradeGate.message}
                    </div>
                    {notice ? (
                      <div className="mt-1 text-[10px] text-rose-50/85">
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
                        className="h-7 rounded-full border border-amber-200/25 bg-amber-200/15 px-3 text-[10px] font-semibold text-amber-50 transition-colors hover:bg-amber-200/20"
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
                        className="h-7 rounded-full border border-white/[0.14] bg-white/[0.04] px-3 text-[10px] font-semibold text-white/75 transition-colors hover:bg-white/[0.08]"
                      >
                        Billing
                      </button>
                      {onOpenSettings && (
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="h-7 rounded-full border border-white/[0.14] bg-white/[0.04] px-2.5 text-[10px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08]"
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
                        className="text-[10px] text-white/55 underline decoration-white/20 hover:text-white/80"
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
                className="rounded-xl border border-red-400/25 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-100"
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
                className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-[11px] text-white/75"
              >
                {notice}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      <div className="flex-1 space-y-2.5 overflow-y-auto overscroll-y-contain px-3 pb-3 pt-1">
        {isLoading ? (
          <NextUpLoadingSkeleton compact={compact} />
        ) : null}

        {!isLoading && visibleItems.length === 0 && !error && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-4 text-center text-[12px] text-white/50">
            No queued workstreams right now.
          </div>
        )}

        {!isLoading && compact ? (
          <AnimatePresence initial={false}>
            {visibleItems.map((item, index) => {
              const key = itemKey(item);
              const isRowBusy = actionKey === key;
              const isAutoRunning =
                item.autoContinue?.status === 'running' || item.autoContinue?.status === 'stopping';
              const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;

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
                  className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
                >
                  <div
                    className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
                    aria-hidden
                  />

                  <div className="flex items-start justify-between gap-2.5">
                    <div className="min-w-0 flex flex-1 items-start gap-2.5">
                      <AgentAvatar
                        name={item.runnerAgentName}
                        hint={`${item.runnerAgentId} ${item.runnerSource}`}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <EntityIcon type="initiative" size={11} className="flex-shrink-0 opacity-85" />
                          <button
                            type="button"
                            onClick={() =>
                              onOpenInitiative?.(item.initiativeId, item.initiativeTitle)
                            }
                            className="block w-full truncate text-left text-[10px] uppercase tracking-[0.08em] text-white/42 transition-colors hover:text-white/72"
                            title={item.initiativeTitle}
                          >
                            {item.initiativeTitle}
                          </button>
                        </div>
                        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 line-clamp-1 text-[13px] font-semibold text-white">
                          <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
                          <span className="truncate">{item.workstreamTitle}</span>
                        </p>
                      </div>
                    </div>
                    <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${queueTone(item.queueState)}`}>
                      {queueLabel(item.queueState)}
                    </span>
                  </div>

                  <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2 text-[11px] text-white/68">
                    {item.nextTaskTitle ? (
                      <div className="space-y-1">
                        <div className="flex min-w-0 items-center gap-1 text-[9px] uppercase tracking-[0.08em] text-white/44">
                          <EntityIcon type="task" size={10} className="flex-shrink-0 opacity-80" />
                          <span>Next</span>
                          {dueText ? (
                            <span className="truncate text-[9px] normal-case tracking-normal text-white/38">
                              · {dueText}
                            </span>
                          ) : null}
                        </div>
                        <p className="line-clamp-2 break-words text-[11px] leading-snug text-white/84">
                          {item.nextTaskTitle}
                        </p>
                      </div>
                    ) : (
                      <span className="text-white/45">No task currently queued.</span>
                    )}
                  </div>

                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-white/48">
                    <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-white/52">
                      Runner
                    </span>
                    <span className="truncate text-white/68">
                      {item.runnerAgentName}
                      {item.runnerSource !== 'assigned' ? ` · ${item.runnerSource}` : ''}
                    </span>
                  </div>

                  {item.blockReason && (
                    <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-[10px] text-red-100/85">
                      Blocked: {item.blockReason}
                    </div>
                  )}

                  <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => onFollowWorkstream?.(item)}
                      className="control-pill flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold"
                      title="Follow this workstream in Activity"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <FollowGlyph className="h-3.5 w-3.5 opacity-85" />
                        <span>Follow</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isRowBusy}
                      onClick={() =>
                        void runAction(
                          key,
                          () =>
                            playWorkstream({
                              initiativeId: item.initiativeId,
                              workstreamId: item.workstreamId,
                              agentId: item.runnerAgentId,
                            }),
                          `Dispatched ${item.workstreamTitle}.`
                        )
                      }
                      className="control-pill flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold disabled:opacity-40"
                      title="Dispatch this workstream now (single run)"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <PlayGlyph className="h-3.5 w-3.5 opacity-85" />
                        <span>Play</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={isRowBusy}
                      onClick={() =>
                        void runAction(
                          key,
                          () =>
                            isAutoRunning
                              ? stopInitiativeAutoContinue({ initiativeId: item.initiativeId })
                              : startWorkstreamAutoContinue({
                                  initiativeId: item.initiativeId,
                                  workstreamId: item.workstreamId,
                                  agentId: item.runnerAgentId,
                                }),
                          isAutoRunning
                            ? `Stopped auto-continue for ${item.initiativeTitle}.`
                            : `Auto-continue started for ${item.workstreamTitle}.`
                        )
                      }
                      className="control-pill col-span-2 flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold disabled:opacity-40 sm:col-span-1"
                      data-state={isAutoRunning ? 'active' : 'idle'}
                      data-tone="teal"
                      title={
                        isAutoRunning
                          ? 'Stop auto-continue for this initiative'
                          : 'Auto-continue this workstream'
                      }
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <AutoGlyph className="h-3.5 w-3.5 opacity-85" />
                        <span>{isAutoRunning ? 'Stop auto' : 'Auto'}</span>
                      </span>
                    </button>
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
                  onFollowWorkstream={onFollowWorkstream}
                  playWorkstream={playWorkstream}
                  startWorkstreamAutoContinue={startWorkstreamAutoContinue}
                  stopInitiativeAutoContinue={stopInitiativeAutoContinue}
                  onCommitReorder={() => void persistOrder().catch(() => null)}
                  onPinToggle={async (desiredPinned) => {
                    if (desiredPinned) {
                      await nextUpActions.pin({
                        initiativeId: item!.initiativeId,
                        workstreamId: item!.workstreamId,
                      });
                      setNotice(`Pinned ${item!.workstreamTitle}. Drag to reorder.`);
                    } else {
                      await nextUpActions.unpin({
                        initiativeId: item!.initiativeId,
                        workstreamId: item!.workstreamId,
                      });
                      setNotice(`Unpinned ${item!.workstreamTitle}.`);
                    }
                  }}
                  runAction={runAction}
                />
              ))}
          </Reorder.Group>
        ) : null}
      </div>

      {degraded.length > 0 && (
        <div className="border-t border-white/[0.06] px-3 py-2 text-[10px] text-white/42">
          Limited signal: {degraded[0]}
        </div>
      )}
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
  onFollowWorkstream,
  onOpenInitiative,
  playWorkstream,
  startWorkstreamAutoContinue,
  stopInitiativeAutoContinue,
  onCommitReorder,
  onPinToggle,
  runAction,
}: {
  item: NextUpQueueItem;
  index: number;
  actionKey: string | null;
  setNotice: (value: string | null) => void;
  setUpgradeGate: (value: UpgradeRequiredError | null) => void;
  onUpgradeGate?: (gate: UpgradeRequiredError | null) => void;
  onFollowWorkstream?: (item: NextUpQueueItem) => void;
  onOpenInitiative?: (initiativeId: string, initiativeTitle?: string) => void;
  playWorkstream: (input: { initiativeId: string; workstreamId: string; agentId?: string | null }) => Promise<unknown>;
  startWorkstreamAutoContinue: (input: { initiativeId: string; workstreamId: string; agentId?: string | null }) => Promise<unknown>;
  stopInitiativeAutoContinue: (input: { initiativeId: string }) => Promise<unknown>;
  onCommitReorder: () => void;
  onPinToggle: (desiredPinned: boolean) => Promise<void>;
  runAction: (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string
  ) => Promise<void>;
}) {
  const controls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);
  const key = `${item.initiativeId}:${item.workstreamId}`;
  const isRowBusy = actionKey === key;
  const isAutoRunning =
    item.autoContinue?.status === 'running' || item.autoContinue?.status === 'stopping';
  const dueText = item.nextTaskDueAt ? formatRelativeTime(item.nextTaskDueAt) : null;
  const isPinned = item.isPinned === true;

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
        scale: 1.01,
        boxShadow: '0 18px 40px rgba(0,0,0,0.42)',
      }}
      className="relative"
    >
      <motion.article
        layout
        initial={{ opacity: 0, y: 6, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.99 }}
        transition={{
          duration: 0.22,
          delay: Math.min(index, 7) * 0.018,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-3"
      >
        <div
          className={`absolute left-1/2 top-1 z-20 -translate-x-1/2 transition-opacity ${
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <button
            type="button"
            onPointerDown={(event) => controls.start(event)}
            aria-label="Drag to reorder"
            title={isDragging ? 'Reordering' : 'Drag to reorder'}
            className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10px] font-semibold transition-colors ${
              isDragging
                ? 'border-[#BFFF00]/35 bg-[#BFFF00]/14 text-[#E1FFB2] cursor-grabbing'
                : 'border-white/[0.12] bg-white/[0.04] text-white/60 cursor-grab hover:bg-white/[0.08] hover:text-white/85'
            }`}
          >
            {isDragging ? (
              <HandGrabGlyph className="h-4 w-4 opacity-90" />
            ) : (
              <HandOpenGlyph className="h-4 w-4 opacity-90" />
            )}
            <span>{isDragging ? 'Grabbed' : 'Grab'}</span>
          </button>
        </div>

        <div
          className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${queueHighlight(item.queueState)}`}
          aria-hidden
        />

        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex flex-1 items-start gap-2.5">
            <AgentAvatar
              name={item.runnerAgentName}
              hint={`${item.runnerAgentId} ${item.runnerSource}`}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <EntityIcon type="initiative" size={11} className="flex-shrink-0 opacity-85" />
                <button
                  type="button"
                  onClick={() => onOpenInitiative?.(item.initiativeId, item.initiativeTitle)}
                  className="block w-full truncate text-left text-[10px] uppercase tracking-[0.08em] text-white/42 transition-colors hover:text-white/72"
                  title={item.initiativeTitle}
                >
                  {item.initiativeTitle}
                </button>
              </div>
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 line-clamp-1 text-[13px] font-semibold text-white">
                <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
                <span className="truncate">{item.workstreamTitle}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setUpgradeGate(null);
                onUpgradeGate?.(null);
                void onPinToggle(!isPinned).catch((err) =>
                  setNotice(err instanceof Error ? err.message : 'Pin action failed')
                );
              }}
              title={isPinned ? 'Unpin from queue ordering' : 'Pin to queue ordering'}
              className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[10px] font-semibold transition-colors ${
                isPinned
                  ? 'border-[#BFFF00]/35 bg-[#BFFF00]/12 text-[#E1FFB2]'
                  : 'border-white/[0.14] bg-white/[0.04] text-white/65 hover:bg-white/[0.08]'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 17v5" />
                <path d="M9 3h6l1 7-4 4v3H12v-3l-4-4 1-7Z" />
              </svg>
              <span>{isPinned ? 'Pinned' : 'Pin'}</span>
            </button>
            <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${queueTone(item.queueState)}`}>
              {queueLabel(item.queueState)}
            </span>
          </div>
        </div>

        <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.18] px-2.5 py-2 text-[11px] text-white/68">
          {item.nextTaskTitle ? (
            <div className="space-y-1">
              <div className="flex min-w-0 items-center gap-1 text-[9px] uppercase tracking-[0.08em] text-white/44">
                <EntityIcon type="task" size={10} className="flex-shrink-0 opacity-80" />
                <span>Next</span>
                {dueText ? (
                  <span className="truncate text-[9px] normal-case tracking-normal text-white/38">
                    · {dueText}
                  </span>
                ) : null}
              </div>
              <p className="line-clamp-2 break-words text-[11px] leading-snug text-white/84">
                {item.nextTaskTitle}
              </p>
            </div>
          ) : (
            <span className="text-white/45">No task currently queued.</span>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-white/48">
          <span className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-white/52">
            Runner
          </span>
          <span className="truncate text-white/68">
            {item.runnerAgentName}
            {item.runnerSource !== 'assigned' ? ` · ${item.runnerSource}` : ''}
          </span>
        </div>

        {item.blockReason && (
          <div className="mt-1.5 rounded-lg border border-red-400/24 bg-red-500/[0.08] px-2.5 py-1 text-[10px] text-red-100/85">
            Blocked: {item.blockReason}
          </div>
        )}

        <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => onFollowWorkstream?.(item)}
            className="control-pill flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold"
            title="Follow this workstream in Activity"
          >
            <span className="inline-flex items-center gap-1.5">
              <FollowGlyph className="h-3.5 w-3.5 opacity-85" />
              <span>Follow</span>
            </span>
          </button>
          <button
            type="button"
            disabled={isRowBusy}
            onClick={() =>
              void runAction(
                key,
                () =>
                  playWorkstream({
                    initiativeId: item.initiativeId,
                    workstreamId: item.workstreamId,
                    agentId: item.runnerAgentId,
                  }),
                `Dispatched ${item.workstreamTitle}.`
              )
            }
            className="control-pill flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold disabled:opacity-40"
            title="Dispatch this workstream now (single run)"
          >
            <span className="inline-flex items-center gap-1.5">
              <PlayGlyph className="h-3.5 w-3.5 opacity-85" />
              <span>Play</span>
            </span>
          </button>
          <button
            type="button"
            disabled={isRowBusy}
            onClick={() =>
              void runAction(
                key,
                () =>
                  isAutoRunning
                    ? stopInitiativeAutoContinue({ initiativeId: item.initiativeId })
                    : startWorkstreamAutoContinue({
                        initiativeId: item.initiativeId,
                        workstreamId: item.workstreamId,
                        agentId: item.runnerAgentId,
                      }),
                isAutoRunning
                  ? `Stopped auto-continue for ${item.initiativeTitle}.`
                  : `Auto-continue started for ${item.workstreamTitle}.`
              )
            }
            className="control-pill col-span-2 flex h-8 w-full items-center justify-center px-2 text-[10px] font-semibold disabled:opacity-40 sm:col-span-1"
            data-state={isAutoRunning ? 'active' : 'idle'}
            data-tone="teal"
            title={
              isAutoRunning
                ? 'Stop auto-continue for this initiative'
                : 'Auto-continue this workstream'
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <AutoGlyph className="h-3.5 w-3.5 opacity-85" />
              <span>{isAutoRunning ? 'Stop auto' : 'Auto'}</span>
            </span>
          </button>
        </div>
      </motion.article>
    </Reorder.Item>
  );
}
