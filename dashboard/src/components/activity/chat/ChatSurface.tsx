import { useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { useChatDockState, useChatDockDispatch } from './ChatDockContext';
import {
  CONTROL_SPRING,
  CONTROL_TAP,
  inferThreadStatusFromLaunch,
  roleBadge,
  statusClasses,
  statusLabel,
} from './chatTypes';

/**
 * ThreadSidebar — fixed left-side overlay panel for browsing threads.
 * Desktop: slides in from left. Mobile: falls back to ThreadDrawer (unchanged).
 */
export function ThreadSidebar() {
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
    threadSidebarOpen,
  } = useChatDockState();

  const {
    openThreadPanel,
    closeThreadPanel,
    loadThreadDetail,
    applyScopeLink,
    setComposerMode,
    toggleThreadSidebar,
    panelHeadingRef,
  } = useChatDockDispatch();

  const activePanelThreadId = activeThread?.id ?? activeThreadSummary?.id ?? null;

  const handleClose = useCallback(() => {
    toggleThreadSidebar();
  }, [toggleThreadSidebar]);

  if (!threadSidebarOpen) return null;

  return (
    <AnimatePresence>
      {threadSidebarOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="sidebar-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={handleClose}
            className="fixed inset-0 z-[24] bg-black/30"
          />

          {/* Sidebar panel */}
          <motion.section
            key="sidebar-panel"
            initial={prefersReducedMotion ? false : { x: '-100%' }}
            animate={prefersReducedMotion ? {} : { x: 0 }}
            exit={prefersReducedMotion ? {} : { x: '-100%' }}
            transition={
              prefersReducedMotion
                ? undefined
                : {
                    duration: motionTokens.durationEntrance / 1000,
                    ease: motionTokens.easingEntrance as unknown as number[],
                  }
            }
            aria-label="Thread sidebar"
            data-testid="thread-sidebar"
            className="fixed inset-y-0 left-0 z-25 flex w-[380px] max-w-[85vw] flex-col border-r border-white/[0.14] bg-[#0A0E16]/95 shadow-[12px_0_40px_rgba(0,0,0,0.4)] backdrop-blur-xl"
          >
            {/* Header */}
            <header className="flex items-center justify-between gap-2 border-b border-white/[0.08] px-4 py-3">
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
                aria-label="Close thread sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>

            {/* Thread list */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {displayedThreads.length === 0 ? (
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-caption text-secondary">
                  <p className="text-primary">No threads yet.</p>
                  <p className="mt-0.5">Send a message to start one.</p>
                  <motion.button
                    type="button"
                    whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                    whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                    transition={CONTROL_SPRING}
                    onClick={() => {
                      handleClose();
                      setComposerMode('focused');
                      requestAnimationFrame(() => {
                        const composer = document.getElementById('chat-dock-input');
                        if (composer instanceof HTMLTextAreaElement) composer.focus();
                      });
                    }}
                    className="mt-2 inline-flex min-h-[34px] items-center rounded-full border border-lime/30 bg-lime/[0.12] px-2.5 text-micro font-semibold text-[#E1FFB2] hover:bg-lime/[0.18]"
                  >
                    Start thread
                  </motion.button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {displayedThreads.map((thread, index) => (
                    <motion.button
                      key={thread.id}
                      type="button"
                      initial={prefersReducedMotion ? false : { opacity: 0, x: -8 }}
                      animate={prefersReducedMotion ? {} : { opacity: 1, x: 0 }}
                      transition={{
                        ...(prefersReducedMotion ? {} : CONTROL_SPRING),
                        delay: prefersReducedMotion ? 0 : Math.min(index * 0.02, 0.16),
                      }}
                      whileHover={prefersReducedMotion ? undefined : { x: 2 }}
                      whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                      onClick={(e) => void openThreadPanel(thread.id, e.currentTarget)}
                      className={cn(
                        'w-full rounded-xl border px-3 py-2 text-left transition-colors duration-150',
                        activeThreadId === thread.id
                          ? 'border-lime/35 bg-lime/[0.08]'
                          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.05]'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-caption font-semibold text-primary">
                          {thread.title}
                        </p>
                        <time className="flex-shrink-0 text-micro text-muted" dateTime={thread.lastActivityAt}>
                          {formatRelativeTime(thread.lastActivityAt)}
                        </time>
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-micro text-secondary">
                        {thread.lastSnippet ?? thread.summary ?? 'No message yet.'}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-muted">
                        {thread.assigneeName && (
                          <span className="inline-flex items-center gap-1">
                            <AgentAvatar name={thread.assigneeName} hint={thread.assigneeName} size="xs" />
                            <span>{thread.assigneeName}</span>
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
                    </motion.button>
                  ))}
                </div>
              )}
            </div>

            {/* Thread detail panel (below thread list in sidebar) */}
            <AnimatePresence initial={false}>
              {activeThreadId && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? {} : { opacity: 0, y: 12 }}
                  transition={
                    prefersReducedMotion
                      ? undefined
                      : {
                          duration: motionTokens.durationStandard / 1000,
                          ease: motionTokens.easingStandard as unknown as number[],
                        }
                  }
                  className="flex min-h-0 max-h-[50%] flex-col border-t border-white/[0.08]"
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
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-micro font-semibold',
                          statusClasses(activeThreadSummary?.status ?? 'message_only')
                        )}
                      >
                        {statusLabel(activeThreadSummary?.status ?? 'message_only')}
                      </span>
                      <button
                        type="button"
                        onClick={closeThreadPanel}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.03] text-micro text-secondary hover:bg-white/[0.08] hover:text-primary"
                        aria-label="Close thread detail"
                      >
                        ×
                      </button>
                    </div>
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

                  {/* Launch summary */}
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
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}

// Re-export for backwards compatibility with any existing imports
export { ThreadSidebar as ChatSurface };
