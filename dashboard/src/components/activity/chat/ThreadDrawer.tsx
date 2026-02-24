import { useCallback, useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { useChatDockState, useChatDockDispatch } from './ChatDockContext';
import {
  inferThreadStatusFromLaunch,
  roleBadge,
  statusClasses,
  statusLabel,
} from './chatTypes';

interface ThreadDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function ThreadDrawer({ open, onClose }: ThreadDrawerProps) {
  const prefersReducedMotion = useReducedMotion();
  const {
    displayedThreads,
    activeThreadId,
    activeThread,
    activeThreadSummary,
    panelLoading,
    panelError,
    scopeSaving,
    initiativeOptions,
  } = useChatDockState();

  const {
    openThreadPanel,
    closeThreadPanel,
    loadThreadDetail,
    applyScopeLink,
    panelHeadingRef,
  } = useChatDockDispatch();

  const activePanelThreadId = activeThread?.id ?? activeThreadSummary?.id ?? null;

  const handleThreadClick = useCallback(
    (threadId: string, el: HTMLElement | null) => {
      void openThreadPanel(threadId, el);
    },
    [openThreadPanel]
  );

  const handleClose = useCallback(() => {
    closeThreadPanel();
    onClose();
  }, [closeThreadPanel, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={handleClose}
            className="fixed inset-0 z-[24] bg-black/30"
          />

          {/* Drawer */}
          <motion.section
            initial={prefersReducedMotion ? false : { y: '100%' }}
            animate={prefersReducedMotion ? {} : { y: 0 }}
            exit={prefersReducedMotion ? {} : { y: '100%' }}
            transition={
              prefersReducedMotion
                ? undefined
                : {
                    duration: motionTokens.durationEntrance / 1000,
                    ease: motionTokens.easingEntrance as unknown as number[],
                  }
            }
            aria-label="Thread history"
            data-testid="thread-drawer"
            className="fixed bottom-0 left-0 right-0 z-25 flex max-h-[min(60vh,480px)] flex-col rounded-t-[22px] border-t border-white/[0.14] bg-[#0A0E16]/95 shadow-[0_-12px_40px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="h-1 w-10 rounded-full bg-white/[0.16]" />
            </div>

            {/* Header */}
            <header className="flex items-center justify-between gap-2 px-4 pb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-body font-semibold text-primary">Threads</h3>
                <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
                  {displayedThreads.length}
                </span>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.03] text-secondary hover:bg-white/[0.08] hover:text-primary"
                aria-label="Close thread drawer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            <div
              className={cn(
                'grid min-h-0 flex-1 overflow-hidden',
                activeThreadId && 'lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]'
              )}
            >
              {/* Thread list */}
              <div className="min-h-0 overflow-y-auto px-3 pb-3">
                {displayedThreads.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-caption text-secondary">
                    No threads yet. Send a message to start one.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {displayedThreads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={(e) => handleThreadClick(thread.id, e.currentTarget)}
                        className={cn(
                          'w-full rounded-xl border px-3 py-2 text-left transition-colors duration-150',
                          activeThreadId === thread.id
                            ? 'border-lime/35 bg-lime/[0.08]'
                            : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.05]'
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate text-caption font-semibold text-primary">
                            {thread.lastSnippet
                              ? `"${thread.lastSnippet.length > 40 ? thread.lastSnippet.slice(0, 40) + '...' : thread.lastSnippet}"`
                              : thread.title}
                          </p>
                          <time className="flex-shrink-0 text-micro text-muted" dateTime={thread.lastActivityAt}>
                            {formatRelativeTime(thread.lastActivityAt)}
                          </time>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-muted">
                          {thread.assigneeName && (
                            <span className="inline-flex items-center gap-1">
                              <span className="text-secondary">@</span> {thread.assigneeName}
                            </span>
                          )}
                          <span>{thread.initiativeTitle ?? 'Unscoped'}</span>
                          <span aria-hidden>·</span>
                          <span
                            className={cn(
                              'rounded-full border px-1.5 py-0 text-[10px] font-semibold',
                              statusClasses(thread.status)
                            )}
                          >
                            {statusLabel(thread.status)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Thread detail panel (lg only) */}
              <AnimatePresence initial={false}>
                {activeThreadId && (
                  <motion.div
                    initial={prefersReducedMotion ? false : { opacity: 0, x: 12 }}
                    animate={prefersReducedMotion ? {} : { opacity: 1, x: 0 }}
                    exit={prefersReducedMotion ? {} : { opacity: 0, x: 12 }}
                    transition={
                      prefersReducedMotion
                        ? undefined
                        : {
                            duration: motionTokens.durationStandard / 1000,
                            ease: motionTokens.easingStandard as unknown as number[],
                          }
                    }
                    className="hidden min-h-0 flex-col overflow-hidden border-l border-white/[0.08] lg:flex"
                  >
                    {/* Detail header */}
                    <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2">
                      <h4
                        ref={panelHeadingRef}
                        tabIndex={-1}
                        className="truncate text-caption font-semibold text-primary outline-none"
                      >
                        {activeThread?.title ?? activeThreadSummary?.title ?? 'Thread'}
                      </h4>
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-micro font-semibold',
                          statusClasses(activeThreadSummary?.status ?? 'message_only')
                        )}
                      >
                        {statusLabel(activeThreadSummary?.status ?? 'message_only')}
                      </span>
                    </div>

                    {/* Conversation */}
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                      {panelLoading ? (
                        <div className="space-y-2" aria-label="Loading thread">
                          <div className="h-10 w-[78%] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]" />
                          <div className="ml-auto h-10 w-[68%] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]" />
                        </div>
                      ) : panelError ? (
                        <div className="rounded-md border border-rose-400/30 bg-rose-400/[0.12] px-2.5 py-2 text-caption text-rose-100">
                          <p>{panelError}</p>
                          {activePanelThreadId && (
                            <button
                              type="button"
                              onClick={() => void loadThreadDetail(activePanelThreadId)}
                              className="mt-1.5 inline-flex min-h-[28px] items-center rounded-full border border-rose-200/30 bg-rose-400/[0.12] px-2 text-micro text-rose-100 hover:bg-rose-400/[0.2]"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      ) : activeThread && activeThread.messages.length > 0 ? (
                        <div className="space-y-2">
                          {activeThread.messages.map((message) => (
                            <article
                              key={message.id}
                              className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                            >
                              <div
                                className={cn(
                                  'max-w-[90%] rounded-xl border px-2.5 py-1.5',
                                  message.role === 'system'
                                    ? 'border-white/[0.12] bg-white/[0.03] text-secondary'
                                    : message.role === 'agent'
                                      ? 'border-teal/25 bg-teal/[0.1] text-primary'
                                      : 'border-lime/25 bg-lime/[0.1] text-primary'
                                )}
                              >
                                <div className="mb-0.5 flex items-center justify-between gap-2 text-micro text-muted">
                                  <span>{message.senderName ?? roleBadge(message.role)}</span>
                                  <time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt)}</time>
                                </div>
                                <p className="whitespace-pre-wrap text-caption">{message.body}</p>
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="text-caption text-secondary">No messages yet.</p>
                      )}
                    </div>

                    {/* Launch timeline summary */}
                    {activeThread && activeThread.launches.length > 0 && (
                      <div className="border-t border-white/[0.06] px-4 py-2">
                        <p className="text-micro font-semibold text-muted">
                          {activeThread.launches.length} launch{activeThread.launches.length === 1 ? '' : 'es'}
                        </p>
                        {activeThread.launches.slice(0, 2).map((launch) => (
                          <div key={launch.id} className="mt-1 flex items-center gap-2 text-micro text-secondary">
                            <span
                              className={cn(
                                'rounded-full border px-1.5 py-0 text-[10px] font-semibold',
                                statusClasses(inferThreadStatusFromLaunch(launch.status))
                              )}
                            >
                              {launch.status}
                            </span>
                            <span>{launch.assigneeName ?? 'Unset'}</span>
                            <time className="text-muted" dateTime={launch.requestedAt}>
                              {formatRelativeTime(launch.requestedAt)}
                            </time>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
