import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { useChatDockState, useChatDockDispatch } from './ChatDockContext';
import { QUICK_START_PROMPTS, attachmentReadableSize } from './chatTypes';
import { InlineResponse } from './InlineResponse';
import { ContextRibbon } from './ContextRibbon';
import { ThreadDrawer } from './ThreadDrawer';
import { AgentPickerPopover } from './AgentPickerPopover';
import { ScopePopover } from './ScopePopover';

export function ActivityChatDock() {
  const state = useChatDockState();
  const dispatch = useChatDockDispatch();
  const prefersReducedMotion = useReducedMotion();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentChipRef = useRef<HTMLButtonElement>(null);
  const scopeChipRef = useRef<HTMLButtonElement>(null);

  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [inlineCollapsed, setInlineCollapsed] = useState(false);
  const inlineIdleTimerRef = useRef<number | null>(null);

  const {
    composerMode,
    draft,
    draftAttachments,
    sending,
    launching,
    selectedAssigneeId,
    selectedAssignee,
    selectedWatcherIds,
    selectedInitiative,
    quickAssigneeOptions,
    agentPickerMode,
    agentPickerQuery,
    filteredAgentOptions,
    scopePickerOpen,
    scopePickerQuery,
    filteredInitiativeOptions,
    canSend,
    activeThreadId,
    guidanceStatus,
    inlineMessages,
    displayedThreads,
    launchWarningOpen,
    launchWarningAccepted,
  } = state;

  const isExpanded = composerMode !== 'resting';
  const isComposing = composerMode === 'composing' || composerMode === 'targeting' || composerMode === 'scoping' || composerMode === 'reviewing';
  const draftTrimmed = draft.trim();
  const hasInlineMessages = inlineMessages.length > 0;

  // Auto-collapse inline messages after 5s of inactivity
  useEffect(() => {
    if (inlineIdleTimerRef.current) clearTimeout(inlineIdleTimerRef.current);
    if (inlineMessages.length <= 2) {
      setInlineCollapsed(false);
      return;
    }
    setInlineCollapsed(false);
    inlineIdleTimerRef.current = window.setTimeout(() => {
      setInlineCollapsed(true);
    }, 5000);
    return () => {
      if (inlineIdleTimerRef.current) clearTimeout(inlineIdleTimerRef.current);
    };
  }, [inlineMessages.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        dispatch.setComposerMode('focused');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  const handleFocus = useCallback(() => {
    if (composerMode === 'resting') dispatch.setComposerMode('focused');
  }, [composerMode, dispatch]);

  const handleBlur = useCallback(() => {
    window.setTimeout(() => {
      if (
        draftTrimmed.length === 0 &&
        !hasInlineMessages &&
        dispatch.composerShellRef.current &&
        !dispatch.composerShellRef.current.contains(document.activeElement)
      ) {
        dispatch.setComposerMode('resting');
        dispatch.setAgentPickerMode(null);
        dispatch.setScopePickerOpen(false);
      }
    }, 0);
  }, [draftTrimmed, hasInlineMessages, dispatch]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      dispatch.setDraft(e.target.value);
      if (composerMode === 'resting' || composerMode === 'focused') {
        dispatch.setComposerMode('composing');
      }
    },
    [composerMode, dispatch]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void dispatch.handlePrimaryAction();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (agentPickerMode) {
          dispatch.setAgentPickerMode(null);
        } else if (scopePickerOpen) {
          dispatch.setScopePickerOpen(false);
        } else {
          dispatch.setComposerMode('resting');
          dispatch.clearInlineMessages();
          (e.target as HTMLElement).blur();
        }
      }
      if (e.key === '@' && !agentPickerMode) {
        dispatch.toggleAssigneePicker();
      }
      if (e.key === '#' && !scopePickerOpen) {
        dispatch.toggleScopePicker();
      }
    },
    [dispatch, agentPickerMode, scopePickerOpen]
  );

  const handleMouseEnter = useCallback(() => {
    if (composerMode === 'resting') dispatch.setComposerMode('focused');
  }, [composerMode, dispatch]);

  const handleInlineClick = useCallback(() => {
    setThreadDrawerOpen(true);
  }, []);

  // CTA icon — always up-arrow, spinner when sending
  const ctaIcon = sending || launching ? (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="52" strokeDashoffset="16" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );

  const showQuickPrompts = isComposing && draftTrimmed.length === 0 && !activeThreadId && !hasInlineMessages;
  const showContextRibbon = composerMode !== 'resting';
  const showInlineResponse = (composerMode === 'reviewing' || hasInlineMessages) && inlineMessages.length > 0;
  const isStreaming = guidanceStatus === 'submitted' || guidanceStatus === 'streaming';

  return (
    <>
      {/* Thread drawer */}
      <ThreadDrawer open={threadDrawerOpen} onClose={() => setThreadDrawerOpen(false)} />

      <div
        ref={(node) => {
          dispatch.composerShellRef.current = node;
        }}
        className="sticky bottom-0 z-20 px-4 pb-4 pt-2"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
      >
        {/* Launch warning (kept as inline, not toast) */}
        <AnimatePresence>
          {launchWarningOpen && (
            <motion.div
              key="launch-warning"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? {} : { opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-2 rounded-lg border border-amber-300/35 bg-amber-300/[0.12] px-2.5 py-2 text-caption text-amber-100"
            >
              <p>Launch includes non-ready attachments. Continue anyway?</p>
              <label className="mt-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={launchWarningAccepted}
                  onChange={(e) => dispatch.setLaunchWarningAccepted(e.target.checked)}
                />
                <span>I understand unresolved attachment extraction may reduce context quality.</span>
              </label>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Popovers anchored to ribbon chips */}
        <div className="relative">
          <AgentPickerPopover
            open={agentPickerMode !== null}
            mode={agentPickerMode ?? 'assignee'}
            agents={filteredAgentOptions}
            quickAgents={quickAssigneeOptions}
            query={agentPickerQuery}
            selectedAssigneeId={selectedAssigneeId}
            selectedWatcherIds={selectedWatcherIds}
            onQueryChange={dispatch.setAgentPickerQuery}
            onSelectAssignee={dispatch.selectAssignee}
            onToggleWatcher={dispatch.toggleWatcher}
            onClose={() => dispatch.setAgentPickerMode(null)}
            onSwitchMode={dispatch.setAgentPickerMode}
            anchorRef={agentChipRef}
          />
          <ScopePopover
            open={scopePickerOpen}
            initiatives={filteredInitiativeOptions}
            query={scopePickerQuery}
            selectedInitiativeId={state.selectedInitiativeId}
            onQueryChange={dispatch.setScopePickerQuery}
            onSelect={dispatch.setSelectedInitiativeId}
            onClose={() => dispatch.setScopePickerOpen(false)}
            anchorRef={scopeChipRef}
          />
        </div>

        {/* Main dock pill */}
        <motion.section
          data-testid="chat-dock"
          data-state={composerMode}
          initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
          animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
          transition={
            prefersReducedMotion
              ? undefined
              : {
                  duration: motionTokens.durationEntrance / 1000,
                  ease: motionTokens.easingEntrance as unknown as number[],
                }
          }
          layout={!prefersReducedMotion}
          layoutDependency={composerMode}
          onMouseEnter={handleMouseEnter}
          className={cn(
            'rounded-[22px] border bg-[#0A0E16]/80 backdrop-blur-xl',
            'shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_14px_34px_rgba(0,0,0,0.36)]',
            isExpanded
              ? 'border-white/[0.14] px-2.5 py-2.5'
              : 'border-white/[0.1] px-2.5 py-1.5'
          )}
        >
          <input
            ref={(node) => {
              dispatch.fileInputRef.current = node;
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              dispatch.handleFilesAdded(e.target.files);
              e.currentTarget.value = '';
            }}
          />

          {/* 1. InlineResponse — mini-conversation above everything */}
          <AnimatePresence>
            {showInlineResponse && (
              <InlineResponse
                messages={inlineMessages}
                isStreaming={isStreaming}
                collapsed={inlineCollapsed}
                onClick={handleInlineClick}
              />
            )}
          </AnimatePresence>

          {/* 2. ContextRibbon — agent + scope chips */}
          <AnimatePresence>
            {showContextRibbon && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
                transition={
                  prefersReducedMotion
                    ? undefined
                    : {
                        duration: motionTokens.durationFast / 1000,
                        ease: motionTokens.easingStandard as unknown as number[],
                      }
                }
                className="overflow-hidden"
              >
                <ContextRibbon
                  selectedAssignee={selectedAssignee}
                  initiativeName={selectedInitiative?.name ?? null}
                  onAgentClick={dispatch.toggleAssigneePicker}
                  onScopeClick={dispatch.toggleScopePicker}
                  agentChipRef={agentChipRef}
                  scopeChipRef={scopeChipRef}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* 3. Input row: thread badge + [+] button + textarea + send button */}
          <div className="flex items-end gap-2">
            {/* Thread count badge (resting state) */}
            {composerMode === 'resting' && displayedThreads.length > 0 && (
              <button
                type="button"
                onClick={() => setThreadDrawerOpen(true)}
                className={cn(
                  'inline-flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full border px-1 text-micro',
                  'border-white/[0.12] bg-white/[0.04] text-secondary',
                  'hover:border-lime/25 hover:bg-lime/[0.08]'
                )}
                aria-label={`${displayedThreads.length} thread${displayedThreads.length === 1 ? '' : 's'}`}
              >
                {displayedThreads.length}
              </button>
            )}

            {/* + button */}
            <button
              type="button"
              onClick={() => dispatch.fileInputRef.current?.click()}
              className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.04] text-caption font-medium text-secondary hover:bg-white/[0.08] hover:text-primary"
              aria-label="Add attachment"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>

            {/* Textarea */}
            <div className="flex-1">
              <label htmlFor="chat-dock-input" className="sr-only">Chat composer</label>
              <textarea
                ref={textareaRef}
                id="chat-dock-input"
                value={draft}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="Message an agent..."
                rows={isComposing ? 3 : 1}
                className={cn(
                  'w-full resize-none rounded-2xl border-none bg-transparent px-1 py-1.5 text-caption text-primary placeholder:text-muted',
                  'focus:outline-none',
                  !isExpanded && 'h-8 overflow-hidden'
                )}
                aria-expanded={isExpanded}
              />
            </div>

            {/* Send CTA — always up-arrow, lime dot when agent set */}
            <div className="relative flex-shrink-0">
              <motion.button
                type="button"
                onClick={() => void dispatch.handlePrimaryAction()}
                disabled={!canSend}
                data-action="chat-send-primary"
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                  prefersReducedMotion ? 'duration-0' : 'duration-150',
                  'disabled:opacity-45',
                  'border-white/[0.14] bg-white/[0.04] text-secondary hover:bg-white/[0.08] hover:text-primary'
                )}
                title={selectedAssignee ? `Send to ${selectedAssignee.name}` : 'Send'}
                aria-label={selectedAssignee ? `Send to ${selectedAssignee.name}` : 'Send message'}
              >
                {ctaIcon}
              </motion.button>
              {/* Lime dot indicator when agent is set */}
              {selectedAssignee && !sending && !launching && (
                <span className="absolute bottom-0 right-0 h-[5px] w-[5px] rounded-full bg-lime" aria-hidden />
              )}
            </div>
          </div>

          {/* 4. Draft attachments */}
          <AnimatePresence initial={false}>
            {draftAttachments.length > 0 && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
                transition={
                  prefersReducedMotion
                    ? undefined
                    : {
                        duration: motionTokens.durationFast / 1000,
                        ease: motionTokens.easingStandard as unknown as number[],
                      }
                }
                className="mt-2 overflow-hidden"
              >
                <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                  {draftAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className={cn(
                        'inline-flex min-h-[26px] items-center gap-1 rounded-full border px-2 py-0.5 text-micro',
                        attachment.status === 'ready'
                          ? 'border-teal/25 bg-teal/[0.1] text-teal-100'
                          : attachment.status === 'failed'
                            ? 'border-rose-400/30 bg-rose-400/[0.12] text-rose-100'
                            : 'border-white/[0.14] bg-white/[0.04] text-secondary'
                      )}
                    >
                      <span className="max-w-[120px] truncate">{attachment.name}</span>
                      <span className="text-[10px] text-muted">
                        {attachmentReadableSize(attachment.sizeBytes)}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.08em]">{attachment.status}</span>
                      {attachment.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => dispatch.handleRetryAttachment(attachment.id)}
                          className="rounded-full border border-white/[0.2] bg-white/[0.05] px-1.5 py-0 text-[10px] hover:bg-white/[0.1]"
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          dispatch.setDraftAttachments((prev) =>
                            prev.filter((a) => a.id !== attachment.id)
                          )
                        }
                        className="rounded-full border border-transparent px-1 py-0 text-[10px] hover:border-white/[0.16] hover:bg-white/[0.05]"
                        aria-label={`Remove attachment ${attachment.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 5. Quick-start prompts */}
          <AnimatePresence initial={false}>
            {showQuickPrompts && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
                transition={
                  prefersReducedMotion
                    ? undefined
                    : {
                        duration: motionTokens.durationFast / 1000,
                        ease: motionTokens.easingStandard as unknown as number[],
                      }
                }
                className="mt-2 overflow-hidden"
              >
                <div className="flex flex-wrap gap-1.5" aria-label="Quick start prompts">
                  {QUICK_START_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => {
                        dispatch.setDraft(prompt);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                      className="inline-flex min-h-[26px] items-center rounded-full border border-white/[0.14] bg-white/[0.03] px-2.5 text-micro text-secondary hover:border-white/[0.24] hover:bg-white/[0.08] hover:text-primary"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>
      </div>
    </>
  );
}
