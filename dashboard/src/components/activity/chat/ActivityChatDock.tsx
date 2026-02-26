import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { useChatDockState, useChatDockDispatch } from './ChatDockContext';
import { CHAT_PROVIDERS, QUICK_START_PROMPTS, attachmentReadableSize } from './chatTypes';
import type { AgentOption, ChatProviderId } from './chatTypes';
import { InlineResponse } from './InlineResponse';
import { ThreadDrawer } from './ThreadDrawer';
import { ThreadSidebar } from './ChatSurface';
import { MentionDropdown } from './MentionDropdown';
import { ScopeDropdown } from './ScopeDropdown';
import { AgentPickerPopover } from './AgentPickerPopover';

// ── Helpers ─────────────────────────────────────────────────────

const TEXTAREA_MIN_HEIGHT = 24;
const TEXTAREA_MAX_HEIGHT = 200;

/** Map MIME prefix to a display-friendly file type icon color. */
function fileTypeColor(mime: string | null): string {
  if (!mime) return '#8F9AB7';
  if (mime.startsWith('application/pdf')) return '#EF4444';
  if (mime.startsWith('image/')) return '#A78BFA';
  if (mime.includes('spreadsheet') || mime.includes('csv')) return '#22C55E';
  if (mime.includes('presentation')) return '#F97316';
  return '#8F9AB7';
}

function fileTypeLabel(mime: string | null, name: string): string {
  if (mime?.startsWith('application/pdf')) return 'PDF';
  if (mime?.startsWith('image/')) return 'Image';
  if (mime?.includes('spreadsheet') || mime?.includes('csv')) return 'Sheet';
  if (mime?.includes('presentation')) return 'Slides';
  const ext = name.split('.').pop()?.toUpperCase();
  return ext && ext.length <= 5 ? ext : 'File';
}

/** Compact provider icon (12×12). */
function ProviderIcon({ icon, className }: { icon: 'anthropic' | 'openai' | 'auto'; className?: string }) {
  if (icon === 'anthropic') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M16.5 2.3L12 21.7l-1.7-6.5L3.8 13l6.5-1.7L12 4.8l1.7 6.5 6.5 1.7-6.5 1.7L12 21.7" />
      </svg>
    );
  }
  if (icon === 'openai') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
        <line x1="10" y1="21" x2="14" y2="21" />
      </svg>
    );
  }
  // Auto icon — sparkle
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────────

const DOCK_COLLAPSED_KEY = 'orgx-chat-dock-collapsed';

function readCollapsedPref(): boolean {
  try {
    return localStorage.getItem(DOCK_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function ActivityChatDock() {
  const state = useChatDockState();
  const dispatch = useChatDockDispatch();
  const prefersReducedMotion = useReducedMotion();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentChipRef = useRef<HTMLButtonElement>(null);

  // ── Dock collapsed state (persisted) ──────────────────────────
  const [dockCollapsed, setDockCollapsed] = useState(readCollapsedPref);
  const toggleDockCollapsed = useCallback(() => {
    setDockCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(DOCK_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* */ }
      return next;
    });
  }, []);

  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [inlineCollapsed, setInlineCollapsed] = useState(false);
  const inlineIdleTimerRef = useRef<number | null>(null);

  // ── Mention (@) dropdown state ──────────────────────────────
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);

  // ── Scope (#) dropdown state ────────────────────────────────
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState('');
  const [scopeIndex, setScopeIndex] = useState(0);
  const [scopeStart, setScopeStart] = useState(-1);

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
    agentOptions,
    quickAssigneeOptions,
    agentPickerMode,
    agentPickerQuery,
    filteredAgentOptions,
    initiativeOptions,
    canSend,
    activeThreadId,
    guidanceStatus,
    inlineMessages,
    displayedThreads,
    launchWarningOpen,
    launchWarningAccepted,
    selectedProvider,
    selectedProviderDef,
  } = state;

  const draftTrimmed = draft.trim();
  const hasInlineMessages = inlineMessages.length > 0;
  const hasDraft = draftTrimmed.length > 0;

  // ── Auto-resize textarea (ChatGPT-style) ────────────────────
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0';
    const next = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }, []);

  useLayoutEffect(() => {
    autoResize();
  }, [draft, autoResize]);

  // ── Filtered lists for inline dropdowns ─────────────────────
  const mentionFiltered = useMemo(() => {
    if (!mentionOpen) return agentOptions;
    const q = mentionQuery.toLowerCase();
    if (!q) return agentOptions;
    return agentOptions.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.handle.toLowerCase().includes(q) ||
        a.domain.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q)
    );
  }, [agentOptions, mentionOpen, mentionQuery]);

  const scopeFiltered = useMemo(() => {
    if (!scopeOpen) return initiativeOptions;
    const q = scopeQuery.toLowerCase();
    if (!q) return initiativeOptions;
    return initiativeOptions.filter((i) => i.name.toLowerCase().includes(q));
  }, [initiativeOptions, scopeOpen, scopeQuery]);

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
        if (dockCollapsed) {
          setDockCollapsed(false);
          try { localStorage.setItem(DOCK_COLLAPSED_KEY, '0'); } catch { /* */ }
        }
        dispatch.setComposerMode('focused');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, dockCollapsed]);

  const handleFocus = useCallback(() => {
    if (composerMode === 'resting') dispatch.setComposerMode('focused');
  }, [composerMode, dispatch]);

  const handleBlur = useCallback(() => {
    window.setTimeout(() => {
      if (
        draftTrimmed.length === 0 &&
        !hasInlineMessages &&
        !mentionOpen &&
        !scopeOpen &&
        draftAttachments.length === 0 &&
        dispatch.composerShellRef.current &&
        !dispatch.composerShellRef.current.contains(document.activeElement)
      ) {
        dispatch.setComposerMode('resting');
        dispatch.setAgentPickerMode(null);
        setMentionOpen(false);
        setScopeOpen(false);
      }
    }, 100);
  }, [draftTrimmed, hasInlineMessages, mentionOpen, scopeOpen, draftAttachments.length, dispatch]);

  // ── Detect @query and #query from text before cursor ────────
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursorPos = e.target.selectionStart ?? value.length;
      dispatch.setDraft(value);

      if (composerMode === 'resting' || composerMode === 'focused') {
        dispatch.setComposerMode('composing');
      }

      const textBeforeCursor = value.slice(0, cursorPos);

      // Detect @mention trigger
      const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
      if (mentionMatch) {
        setMentionOpen(true);
        setMentionQuery(mentionMatch[1]);
        setMentionIndex(0);
        setMentionStart(cursorPos - mentionMatch[0].length);
        setScopeOpen(false);
        return;
      }

      // Detect #scope trigger
      const scopeMatch = textBeforeCursor.match(/#(\w*)$/);
      if (scopeMatch) {
        setScopeOpen(true);
        setScopeQuery(scopeMatch[1]);
        setScopeIndex(0);
        setScopeStart(cursorPos - scopeMatch[0].length);
        setMentionOpen(false);
        return;
      }

      if (mentionOpen) setMentionOpen(false);
      if (scopeOpen) setScopeOpen(false);
    },
    [composerMode, dispatch, mentionOpen, scopeOpen]
  );

  // ── Handle mention selection ────────────────────────────────
  const handleMentionSelect = useCallback(
    (agent: AgentOption) => {
      const before = draft.slice(0, mentionStart);
      const after = draft.slice(textareaRef.current?.selectionStart ?? draft.length);
      const newDraft = `${before}@${agent.name} ${after}`;
      dispatch.setDraft(newDraft);
      dispatch.selectAssignee(agent.id);
      setMentionOpen(false);
      setMentionQuery('');
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = before.length + agent.name.length + 2;
          textareaRef.current.setSelectionRange(newPos, newPos);
          textareaRef.current.focus();
        }
      });
    },
    [draft, mentionStart, dispatch]
  );

  // ── Handle scope selection ──────────────────────────────────
  const handleScopeSelect = useCallback(
    (initiative: { id: string; name: string } | null) => {
      const before = draft.slice(0, scopeStart);
      const after = draft.slice(textareaRef.current?.selectionStart ?? draft.length);
      if (initiative) {
        const newDraft = `${before}#${initiative.name} ${after}`;
        dispatch.setDraft(newDraft);
        dispatch.setSelectedInitiativeId(initiative.id);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            const newPos = before.length + initiative.name.length + 2;
            textareaRef.current.setSelectionRange(newPos, newPos);
            textareaRef.current.focus();
          }
        });
      } else {
        const newDraft = `${before}${after}`;
        dispatch.setDraft(newDraft);
        dispatch.setSelectedInitiativeId('');
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.setSelectionRange(before.length, before.length);
            textareaRef.current.focus();
          }
        });
      }
      setScopeOpen(false);
      setScopeQuery('');
    },
    [draft, scopeStart, dispatch]
  );

  // ── Keyboard handling ───────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Mention dropdown navigation
      if (mentionOpen && mentionFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionIndex((prev) => (prev + 1) % mentionFiltered.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionIndex((prev) => (prev - 1 + mentionFiltered.length) % mentionFiltered.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          handleMentionSelect(mentionFiltered[mentionIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMentionOpen(false);
          return;
        }
      }

      // Scope dropdown navigation
      if (scopeOpen) {
        const total = scopeFiltered.length + 1;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setScopeIndex((prev) => (prev + 1) % total);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setScopeIndex((prev) => (prev - 1 + total) % total);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          handleScopeSelect(scopeIndex === 0 ? null : scopeFiltered[scopeIndex - 1]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setScopeOpen(false);
          return;
        }
      }

      // Primary send
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void dispatch.handlePrimaryAction();
        return;
      }

      // Escape cascade: picker → inline → blur
      if (e.key === 'Escape') {
        e.preventDefault();
        if (agentPickerMode) {
          dispatch.setAgentPickerMode(null);
        } else if (hasInlineMessages) {
          dispatch.clearInlineMessages();
        } else {
          dispatch.setComposerMode('resting');
          (e.target as HTMLElement).blur();
        }
      }
    },
    [
      dispatch,
      agentPickerMode,
      hasInlineMessages,
      mentionOpen,
      mentionFiltered,
      mentionIndex,
      handleMentionSelect,
      scopeOpen,
      scopeFiltered,
      scopeIndex,
      handleScopeSelect,
    ]
  );

  const handleInlineClick = useCallback(() => {
    dispatch.toggleThreadSidebar();
  }, [dispatch]);

  // ── Send button ─────────────────────────────────────────────
  const ctaIcon = sending || launching ? (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="52" strokeDashoffset="16" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );

  const showQuickPrompts =
    composerMode !== 'resting' && draftTrimmed.length === 0 && !activeThreadId && !hasInlineMessages;
  const showInlineResponse = (composerMode === 'reviewing' || hasInlineMessages) && inlineMessages.length > 0;
  const isStreaming = guidanceStatus === 'submitted' || guidanceStatus === 'streaming';

  // Track unread count while collapsed
  const lastSeenCountRef = useRef(inlineMessages.length);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!dockCollapsed) {
      lastSeenCountRef.current = inlineMessages.length;
      setUnreadCount(0);
      return;
    }
    const newMessages = inlineMessages.length - lastSeenCountRef.current;
    if (newMessages > 0) setUnreadCount(newMessages);
  }, [dockCollapsed, inlineMessages.length]);

  // ── Collapsed: floating chat bubble ───────────────────────────
  if (dockCollapsed) {
    return (
      <>
        <ThreadDrawer open={threadDrawerOpen} onClose={() => setThreadDrawerOpen(false)} />
        <ThreadSidebar />

        <div
          className="sticky bottom-0 z-20 flex justify-end px-4 pb-4 pt-2"
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
        >
          <motion.button
            type="button"
            onClick={() => {
              toggleDockCollapsed();
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            initial={prefersReducedMotion ? false : { scale: 0.8, opacity: 0 }}
            animate={prefersReducedMotion ? {} : { scale: 1, opacity: 1 }}
            whileHover={prefersReducedMotion ? undefined : { scale: 1.08 }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            className={cn(
              'relative inline-flex h-12 w-12 items-center justify-center rounded-full',
              'border border-white/[0.14] bg-[#0A0E16]/90 text-primary backdrop-blur-xl',
              'shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]',
              'hover:border-white/[0.22] hover:bg-[#0A0E16]'
            )}
            aria-label="Open chat"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>

            {/* Unread badge */}
            <AnimatePresence>
              {unreadCount > 0 && (
                <motion.span
                  key="unread"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                  className={cn(
                    'absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full',
                    'bg-lime px-1 text-[10px] font-bold text-[#0A0E16]'
                  )}
                >
                  {unreadCount > 9 ? '9+' : unreadCount}
                </motion.span>
              )}
            </AnimatePresence>

            {/* Active thread dot */}
            {activeThreadId && unreadCount === 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0A0E16] bg-lime" />
            )}
          </motion.button>
        </div>
      </>
    );
  }

  // ── Expanded: full composer ────────────────────────────────────
  return (
    <>
      <ThreadDrawer open={threadDrawerOpen} onClose={() => setThreadDrawerOpen(false)} />
      <ThreadSidebar />

      <div
        ref={(node) => { dispatch.composerShellRef.current = node; }}
        className="sticky bottom-0 z-20 px-4 pb-4 pt-2"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
      >
        {/* Launch warning */}
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

        {/* Advanced agent picker popover (watcher mode) */}
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
        </div>

        {/* ── Main dock pill ─────────────────────────────────── */}
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
          className={cn(
            'group/dock relative rounded-[22px] border border-white/[0.12] bg-[#0A0E16]/80 px-3 py-2.5 backdrop-blur-xl',
            'shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_14px_34px_rgba(0,0,0,0.36)]',
            'transition-[border-color] duration-200',
            (composerMode !== 'resting') && 'border-white/[0.16]'
          )}
        >
          {/* Collapse / minimize button */}
          <button
            type="button"
            onClick={toggleDockCollapsed}
            className={cn(
              'absolute -right-1 -top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full',
              'border border-white/[0.14] bg-[#0A0E16] text-secondary',
              'opacity-0 transition-opacity duration-200',
              'hover:bg-white/[0.08] hover:text-primary',
              'group-hover/dock:opacity-100'
            )}
            aria-label="Minimize chat"
            title="Minimize to icon"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <input
            ref={(node) => { dispatch.fileInputRef.current = node; }}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              dispatch.handleFilesAdded(e.target.files);
              e.currentTarget.value = '';
            }}
          />

          {/* InlineResponse above everything */}
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

          {/* Inline dropdowns */}
          <div className="relative">
            <MentionDropdown
              open={mentionOpen}
              agents={mentionFiltered}
              query={mentionQuery}
              activeIndex={mentionIndex}
              anchorRect={null}
              onSelect={handleMentionSelect}
              onClose={() => setMentionOpen(false)}
            />
            <ScopeDropdown
              open={scopeOpen}
              initiatives={scopeFiltered}
              query={scopeQuery}
              activeIndex={scopeIndex}
              onSelect={handleScopeSelect}
              onClose={() => setScopeOpen(false)}
            />
          </div>

          {/* Attachment cards — ABOVE the input (ChatGPT-style) */}
          <AnimatePresence initial={false}>
            {draftAttachments.length > 0 && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="mb-2 overflow-hidden"
              >
                <div className="flex flex-wrap items-start gap-2" aria-live="polite">
                  {draftAttachments.map((att) => (
                    <div
                      key={att.id}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-xl border px-3 py-2',
                        'transition-colors duration-150',
                        att.status === 'failed'
                          ? 'border-rose-400/30 bg-rose-400/[0.08]'
                          : 'border-white/[0.1] bg-white/[0.04]'
                      )}
                    >
                      {/* File type icon */}
                      <div
                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg"
                        style={{ backgroundColor: `${fileTypeColor(att.mimeType)}20` }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={fileTypeColor(att.mimeType)}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="max-w-[180px] truncate text-caption font-medium text-primary">
                          {att.name}
                        </p>
                        <p className="text-micro text-muted">
                          {fileTypeLabel(att.mimeType, att.name)}
                          {att.sizeBytes ? ` · ${attachmentReadableSize(att.sizeBytes)}` : ''}
                        </p>
                      </div>
                      {/* Dismiss button */}
                      <button
                        type="button"
                        onClick={() =>
                          dispatch.setDraftAttachments((prev) => prev.filter((a) => a.id !== att.id))
                        }
                        className={cn(
                          'absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full',
                          'border border-white/[0.16] bg-[#0A0E16] text-[10px] text-secondary',
                          'opacity-0 transition-opacity duration-150 group-hover:opacity-100',
                          'hover:bg-white/[0.1] hover:text-primary'
                        )}
                        aria-label={`Remove ${att.name}`}
                      >
                        ×
                      </button>
                      {/* Status indicator for processing */}
                      {att.status !== 'ready' && att.status !== 'failed' && (
                        <div className="absolute bottom-0.5 left-3 right-3 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
                          <div className="h-full w-1/2 animate-pulse rounded-full bg-white/[0.2]" />
                        </div>
                      )}
                      {att.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => dispatch.handleRetryAttachment(att.id)}
                          className="ml-1 rounded-md border border-rose-300/20 bg-rose-400/[0.12] px-1.5 py-0.5 text-micro text-rose-200 hover:bg-rose-400/[0.2]"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Input row: + button + provider toggle + textarea + send button ── */}
          <div className="flex items-end gap-2">
            {/* + button */}
            <button
              type="button"
              onClick={() => dispatch.fileInputRef.current?.click()}
              className={cn(
                'mb-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
                'border border-white/[0.12] bg-transparent text-secondary',
                'transition-colors duration-150',
                'hover:bg-white/[0.06] hover:text-primary'
              )}
              aria-label="Add files and more"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>

            {/* Provider toggle chip */}
            <motion.button
              type="button"
              onClick={dispatch.cycleProvider}
              whileTap={prefersReducedMotion ? undefined : { scale: 0.93 }}
              transition={{ duration: 0.1 }}
              className={cn(
                'mb-0.5 inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-full px-2',
                'border text-micro font-medium',
                'transition-all duration-200',
                selectedProvider === 'anthropic'
                  ? 'border-[#F5B700]/30 bg-[#F5B700]/[0.08] text-[#F5B700]'
                  : selectedProvider === 'openai'
                    ? 'border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300'
                    : 'border-white/[0.12] bg-white/[0.04] text-muted'
              )}
              title={`Provider: ${selectedProviderDef.label}. Click to switch.`}
              aria-label={`Current provider: ${selectedProviderDef.label}. Click to cycle.`}
            >
              <ProviderIcon icon={selectedProviderDef.icon} />
              <span>{selectedProviderDef.shortLabel}</span>
            </motion.button>

            {/* Textarea — auto-resize, no fixed rows */}
            <div className="min-w-0 flex-1">
              <label htmlFor="chat-dock-input" className="sr-only">Chat composer</label>
              <textarea
                ref={textareaRef}
                id="chat-dock-input"
                value={draft}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything"
                rows={1}
                className={cn(
                  'w-full resize-none border-none bg-transparent py-1 text-[13px] leading-[22px] text-primary',
                  'placeholder:text-muted/60 focus:outline-none',
                )}
                style={{
                  minHeight: TEXTAREA_MIN_HEIGHT,
                  maxHeight: TEXTAREA_MAX_HEIGHT,
                  overflowY: 'auto',
                }}
                aria-expanded={composerMode !== 'resting'}
              />
            </div>

            {/* Thread count (always visible as subtle badge) */}
            {displayedThreads.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (window.innerWidth >= 768) {
                    dispatch.toggleThreadSidebar();
                  } else {
                    setThreadDrawerOpen(true);
                  }
                }}
                className={cn(
                  'mb-0.5 inline-flex h-7 min-w-[28px] flex-shrink-0 items-center justify-center gap-1 rounded-full px-1.5',
                  'text-micro text-muted transition-colors duration-150',
                  'hover:bg-white/[0.06] hover:text-secondary'
                )}
                aria-label={`${displayedThreads.length} thread${displayedThreads.length === 1 ? '' : 's'}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {displayedThreads.length}
              </button>
            )}

            {/* Send button — accent-filled when ready */}
            <motion.button
              type="button"
              onClick={() => void dispatch.handlePrimaryAction()}
              disabled={!canSend}
              data-action="chat-send-primary"
              whileTap={prefersReducedMotion ? undefined : { scale: 0.92 }}
              transition={{ duration: 0.1 }}
              className={cn(
                'mb-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
                'transition-all duration-200',
                canSend
                  ? 'bg-lime text-[#0A0E16] shadow-[0_0_12px_rgba(191,255,0,0.25)]'
                  : 'bg-white/[0.08] text-muted'
              )}
              title={
                selectedAssignee
                  ? `Send to ${selectedAssignee.name} via ${selectedProviderDef.shortLabel}`
                  : `Send via ${selectedProviderDef.shortLabel}`
              }
              aria-label={
                selectedAssignee
                  ? `Send to ${selectedAssignee.name} via ${selectedProviderDef.shortLabel}`
                  : `Send message via ${selectedProviderDef.shortLabel}`
              }
            >
              {ctaIcon}
            </motion.button>
          </div>

          {/* Context indicators (below input, subtle) */}
          <AnimatePresence>
            {(selectedAssignee || selectedInitiative) && composerMode !== 'resting' && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1 }}
                exit={prefersReducedMotion ? {} : { opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="mt-1.5 flex items-center gap-2 px-10"
              >
                {selectedAssignee && (
                  <button
                    ref={(node) => { (agentChipRef as React.MutableRefObject<HTMLButtonElement | null>).current = node; }}
                    type="button"
                    onClick={dispatch.toggleWatcherPicker}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro',
                      'text-[#E1FFB2]/80 transition-colors duration-150 hover:bg-lime/[0.08]'
                    )}
                  >
                    <AgentAvatar name={selectedAssignee.name} hint={selectedAssignee.name} size="xs" />
                    <span className="max-w-[100px] truncate">@{selectedAssignee.name}</span>
                    {selectedAssignee.status === 'running' && (
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-lime" />
                    )}
                  </button>
                )}
                {selectedInitiative && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-micro text-cyan-100/70">
                    #{selectedInitiative.name}
                  </span>
                )}
                {selectedProvider !== 'auto' && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro"
                    style={{ color: selectedProviderDef.accent }}
                  >
                    <ProviderIcon icon={selectedProviderDef.icon} />
                    {selectedProviderDef.shortLabel}
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Quick-start prompts */}
          <AnimatePresence initial={false}>
            {showQuickPrompts && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
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
                      className={cn(
                        'inline-flex min-h-[26px] items-center rounded-full border px-2.5 text-micro',
                        'border-white/[0.1] bg-white/[0.02] text-secondary',
                        'transition-colors duration-150',
                        'hover:border-white/[0.2] hover:bg-white/[0.06] hover:text-primary'
                      )}
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
