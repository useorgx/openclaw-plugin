import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { useNextUpQueue, type NextUpQueueItem } from '@/hooks/useNextUpQueue';

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
      <path d="M2.5 11.2c0-2.1 1.3-3.7 3.3-3.7 2.5 0 4.2 5 6.7 5 1.9 0 3-1.4 3-3.1 0-1.7-1.1-3.1-3-3.1-1.1 0-2.2.6-3.4 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.3 8.2l.8 1.8-2 .1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
}: NextUpPanelProps) {
  const [notice, setNotice] = useState<string | null>(null);
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

  const visibleItems = useMemo(
    () => (compact ? items.slice(0, 7) : items),
    [compact, items]
  );

  const runAction = async (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string
  ) => {
    setNotice(null);
    setActionKey(key);
    try {
      await action();
      setNotice(successMessage);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionKey(null);
    }
  };

  return (
    <PremiumCard
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        disableEnterAnimation ? '' : 'card-enter'
      } ${className ?? ''}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[14px] font-semibold text-white">{title}</h2>
          <span className="chip text-[10px]">{total}</span>
          {isFetching && !isLoading && (
            <span className="text-[10px] text-white/38">refreshing…</span>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mx-3 mt-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-[11px] text-white/75"
          >
            {notice}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mx-3 mt-2 rounded-lg border border-red-400/25 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-100"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {!isLoading && visibleItems.length === 0 && !error && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-4 text-center text-[12px] text-white/50">
            No queued workstreams right now.
          </div>
        )}

        <AnimatePresence initial={false}>
          {visibleItems.map((item, index) => {
            const key = `${item.initiativeId}:${item.workstreamId}`;
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
      </div>

      {degraded.length > 0 && (
        <div className="border-t border-white/[0.06] px-3 py-2 text-[10px] text-white/42">
          Limited signal: {degraded[0]}
        </div>
      )}
    </PremiumCard>
  );
}
