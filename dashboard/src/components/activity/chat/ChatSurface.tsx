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

export function ChatSurface() {
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
    setComposerMode,
    panelHeadingRef,
  } = useChatDockDispatch();

  const activePanelThreadId = activeThread?.id ?? activeThreadSummary?.id ?? null;

  return (
    <section
      aria-label="Chat threads"
      data-testid="chat-surface"
      className="relative rounded-xl border border-subtle bg-white/[0.02] p-3 sm:p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-body font-semibold text-primary">Chat Threads</h3>
          <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
            {displayedThreads.length}
          </span>
        </div>
      </header>

      <div
        className={cn(
          'grid gap-2 lg:gap-3',
          activeThreadId && 'lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]'
        )}
      >
        {/* Thread list */}
        <section
          aria-label="Thread list"
          className={cn('space-y-2', activeThreadId && 'lg:max-h-[74vh] lg:overflow-y-auto lg:pr-1')}
        >
          {displayedThreads.length === 0 ? (
            <div className="rounded-xl border border-subtle bg-white/[0.02] px-3 py-3 text-caption text-secondary">
              <p className="text-primary">No chat threads match this view.</p>
              <p className="mt-0.5">Start a message to open the first thread.</p>
              <motion.button
                type="button"
                whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                transition={CONTROL_SPRING}
                onClick={() => {
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
            displayedThreads.map((thread, index) => (
              <motion.button
                key={thread.id}
                type="button"
                layout
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
                transition={{
                  ...(prefersReducedMotion ? {} : CONTROL_SPRING),
                  delay: prefersReducedMotion ? 0 : Math.min(index * 0.015, 0.12),
                }}
                whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                onClick={(event) => void openThreadPanel(thread.id, event.currentTarget)}
                data-state={activeThreadId === thread.id ? 'active' : 'idle'}
                className={cn(
                  'w-full rounded-xl border bg-white/[0.02] px-3 py-2.5 text-left',
                  'hover:border-white/[0.2] hover:bg-white/[0.05]',
                  activeThreadId === thread.id
                    ? 'border-lime/35 bg-lime/[0.08] shadow-[0_0_0_1px_rgba(191,255,0,0.06)]'
                    : 'border-subtle'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-caption font-semibold text-primary">{thread.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-caption text-secondary">
                      {thread.lastSnippet ?? thread.summary ?? 'No message yet.'}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-micro font-semibold',
                      statusClasses(thread.status)
                    )}
                  >
                    {statusLabel(thread.status)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-muted">
                  <span>{thread.assigneeName ? `Assignee: ${thread.assigneeName}` : 'Assignee unset'}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {thread.watcherNames.length > 0
                      ? `${thread.watcherNames.length} watcher${thread.watcherNames.length > 1 ? 's' : ''}`
                      : 'No watchers'}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{thread.initiativeTitle ?? 'Unscoped'}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={thread.lastActivityAt}>{formatRelativeTime(thread.lastActivityAt)}</time>
                </div>
              </motion.button>
            ))
          )}
        </section>

        {/* Thread detail panel */}
        <AnimatePresence initial={false}>
          {activeThreadId && (
            <motion.section
              initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.99 }}
              animate={prefersReducedMotion ? {} : { opacity: 1, y: 0, scale: 1 }}
              exit={prefersReducedMotion ? {} : { opacity: 0, y: 8, scale: 0.995 }}
              transition={
                prefersReducedMotion
                  ? undefined
                  : {
                      duration: motionTokens.durationStandard / 1000,
                      ease: motionTokens.easingStandard as unknown as number[],
                    }
              }
              aria-label="Thread detail"
              data-testid="chat-thread-panel"
              className="flex max-h-[82dvh] min-h-[460px] flex-col overflow-hidden rounded-xl border border-white/[0.14] bg-[#070A12] lg:min-h-[560px]"
            >
              <header className="flex items-start justify-between gap-3 border-b border-subtle px-4 py-3">
                <div className="min-w-0">
                  <h4
                    ref={panelHeadingRef}
                    tabIndex={-1}
                    className="truncate text-body font-semibold text-primary outline-none"
                  >
                    {activeThread?.title ?? activeThreadSummary?.title ?? 'Thread'}
                  </h4>
                  <p className="mt-0.5 text-micro text-secondary">
                    {activeThread?.initiativeTitle ?? activeThreadSummary?.initiativeTitle ?? 'Unscoped'}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-micro font-semibold',
                      statusClasses(activeThreadSummary?.status ?? 'message_only')
                    )}
                  >
                    {statusLabel(activeThreadSummary?.status ?? 'message_only')}
                  </span>
                  <motion.button
                    type="button"
                    whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                    whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                    transition={CONTROL_SPRING}
                    onClick={closeThreadPanel}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.03] text-secondary hover:bg-white/[0.08] hover:text-primary"
                    aria-label="Close thread panel"
                  >
                    ×
                  </motion.button>
                </div>
              </header>

              <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.15fr_0.85fr]">
                {/* Conversation column */}
                <div className="min-h-0 border-b border-subtle lg:border-b-0 lg:border-r lg:border-subtle">
                  <div className="flex items-center justify-between border-b border-subtle px-4 py-2.5">
                    <p className="text-caption font-semibold text-primary">Conversation</p>
                    <p className="text-micro text-muted">
                      {activeThread?.messages.length ?? 0} message
                      {(activeThread?.messages.length ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="h-full max-h-full overflow-y-auto px-4 py-3">
                    {panelLoading ? (
                      <div className="space-y-2" aria-label="Loading thread">
                        <div className="h-12 w-[78%] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]" />
                        <div className="ml-auto h-12 w-[68%] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]" />
                        <div className="h-12 w-[74%] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.04]" />
                      </div>
                    ) : panelError ? (
                      <div className="rounded-md border border-rose-400/30 bg-rose-400/[0.12] px-2.5 py-2 text-caption text-rose-100">
                        <p>{panelError}</p>
                        {activePanelThreadId && (
                          <button
                            type="button"
                            onClick={() => void loadThreadDetail(activePanelThreadId)}
                            className="mt-2 inline-flex min-h-[32px] items-center rounded-full border border-rose-200/30 bg-rose-400/[0.12] px-2 text-micro text-rose-100 hover:bg-rose-400/[0.2]"
                          >
                            Retry load
                          </button>
                        )}
                      </div>
                    ) : activeThread && activeThread.messages.length > 0 ? (
                      <div className="space-y-2.5">
                        {activeThread.messages.map((message) => (
                          <article
                            key={message.id}
                            data-state={message.role}
                            className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                          >
                            <div
                              className={cn(
                                'max-w-[92%] rounded-2xl border px-3 py-2',
                                message.role === 'system'
                                  ? 'border-white/[0.12] bg-white/[0.03] text-secondary'
                                  : message.role === 'agent'
                                    ? 'border-teal/25 bg-teal/[0.1] text-primary'
                                    : 'border-lime/25 bg-lime/[0.1] text-primary'
                              )}
                            >
                              <div className="mb-1 flex items-center justify-between gap-2 text-micro text-muted">
                                <span>{message.senderName ?? roleBadge(message.role)}</span>
                                <time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt)}</time>
                              </div>
                              <p className="whitespace-pre-wrap text-caption">{message.body}</p>
                              {message.attachments.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                  {message.attachments.map((attachment) => (
                                    <span
                                      key={attachment.id}
                                      className={cn(
                                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro',
                                        attachment.status === 'ready'
                                          ? 'border-teal/25 bg-teal/[0.12] text-teal-100'
                                          : attachment.status === 'failed'
                                            ? 'border-rose-400/30 bg-rose-400/[0.12] text-rose-100'
                                            : 'border-white/[0.14] bg-white/[0.05] text-secondary'
                                      )}
                                    >
                                      <span>{attachment.name}</span>
                                      <span className="uppercase tracking-[0.08em]">{attachment.status}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-2.5 text-caption text-secondary">
                        No messages yet. Send from the composer to establish this thread.
                      </div>
                    )}
                  </div>
                </div>

                {/* Launch timeline column */}
                <aside className="min-h-0">
                  <div className="flex items-center justify-between border-b border-subtle px-4 py-2.5">
                    <p className="text-caption font-semibold text-primary">Launch Timeline</p>
                    <p className="text-micro text-muted">
                      {activeThread?.launches.length ?? 0} launch
                      {(activeThread?.launches.length ?? 0) === 1 ? '' : 'es'}
                    </p>
                  </div>
                  <div className="space-y-3 overflow-y-auto px-4 py-3">
                    <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-2.5 py-2">
                      <p className="text-micro uppercase tracking-[0.08em] text-muted">Scope</p>
                      <div className="mt-1 flex items-center gap-2">
                        <select
                          disabled={scopeSaving}
                          value={activeThread?.initiativeId ?? ''}
                          onChange={(event) =>
                            void applyScopeLink(activePanelThreadId ?? '', event.target.value || null)
                          }
                          className="h-8 min-w-0 flex-1 rounded-md border border-white/[0.14] bg-black/35 px-2 text-caption text-primary outline-none focus:border-lime/35"
                        >
                          <option value="">Unscoped</option>
                          {initiativeOptions.map((initiative) => (
                            <option key={initiative.id} value={initiative.id}>
                              {initiative.name}
                            </option>
                          ))}
                        </select>
                        {scopeSaving && <span className="text-micro text-muted">Saving…</span>}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-2.5 py-2">
                      <p className="text-micro uppercase tracking-[0.08em] text-muted">Assignee</p>
                      <p className="mt-1 text-caption text-primary">
                        {activeThread?.assigneeName ?? activeThreadSummary?.assigneeName ?? 'Unset'}
                      </p>
                      <p className="mt-0.5 text-micro text-secondary">
                        Watchers:{' '}
                        {activeThread?.watcherNames.length
                          ? activeThread.watcherNames.join(', ')
                          : activeThreadSummary?.watcherNames.length
                            ? activeThreadSummary.watcherNames.join(', ')
                            : 'none'}
                      </p>
                    </div>

                    {activeThread && activeThread.launches.length > 0 ? (
                      <div className="space-y-2">
                        {activeThread.launches.map((launch) => (
                          <article
                            key={launch.id}
                            className="rounded-xl border border-white/[0.1] bg-white/[0.03] px-2.5 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={cn(
                                  'rounded-full border px-2 py-0.5 text-micro font-semibold',
                                  statusClasses(inferThreadStatusFromLaunch(launch.status))
                                )}
                              >
                                {launch.status}
                              </span>
                              <time className="text-micro text-muted" dateTime={launch.requestedAt}>
                                {formatRelativeTime(launch.requestedAt)}
                              </time>
                            </div>
                            <p className="mt-1 text-caption text-primary">
                              {launch.assigneeName ? `Executes as ${launch.assigneeName}` : 'Assignee missing'}
                            </p>
                            <p className="mt-0.5 text-micro text-secondary">
                              Mode: {launch.executionMode.replace('_', ' ')}
                              {launch.provider ? ` · ${launch.provider}` : ''}
                            </p>
                            {launch.runId && (
                              <p className="mt-0.5 truncate text-micro text-muted">Run {launch.runId}</p>
                            )}
                            {launch.blockedReason && (
                              <p className="mt-1 rounded-md border border-rose-400/30 bg-rose-400/[0.12] px-2 py-1 text-micro text-rose-100">
                                {launch.blockedReason}
                              </p>
                            )}
                            {launch.warnings.length > 0 && (
                              <p className="mt-1 rounded-md border border-amber-300/30 bg-amber-300/[0.12] px-2 py-1 text-micro text-amber-100">
                                {launch.warnings.join(' ')}
                              </p>
                            )}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-2.5 py-2 text-caption text-secondary">
                        Launches appear here after explicit launch requests.
                      </p>
                    )}
                  </div>
                </aside>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
