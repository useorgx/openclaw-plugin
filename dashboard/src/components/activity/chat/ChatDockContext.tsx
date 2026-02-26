import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport } from 'ai';
import { captureTelemetry } from '@/lib/telemetry';
import type {
  ChatThreadSummary,
  Initiative,
  LiveChatSnapshot,
  SessionTreeNode,
} from '@/types';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { useAgentCatalog } from '@/hooks/useAgentCatalog';
import {
  type AgentOption,
  type ChatProviderId,
  type ChatThreadDetail,
  type ComposerMode,
  type DraftAttachment,
  type InlineMessage,
  type StatusFilterId,
  type SortOrder,
  type UiChatMessage,
  CANONICAL_AGENTS,
  CHAT_PROVIDERS,
  SYSTEM_AGENT_IDS,
  attachmentReadableSize,
  fetchJson,
  humanizeApiError,
  mergeThreads,
  normalizeThreadDetail,
  normalizeThreadSummary,
  statusMatchesFilter,
  summarizeThreadForSearch,
  threadMatchesTimeWindow,
  toEpoch,
  toUiMessagesFromThreadMessages,
  uiMessageToText,
  upsertThread,
} from './chatTypes';

// ── State context (values that trigger re-renders) ───────────────

export interface ChatDockState {
  threads: ChatThreadSummary[];
  activeThreadId: string | null;
  activeThread: ChatThreadDetail | null;
  activeThreadSummary: ChatThreadSummary | null;
  displayedThreads: ChatThreadSummary[];

  composerMode: ComposerMode;
  draft: string;
  draftAttachments: DraftAttachment[];
  sending: boolean;
  launching: boolean;
  composerError: string | null;
  composerNotice: string | null;

  selectedAssigneeId: string;
  selectedAssignee: AgentOption | null;
  selectedWatcherIds: string[];
  selectedWatchers: AgentOption[];
  selectedInitiativeId: string;
  selectedInitiative: { id: string; name: string } | null;

  agentOptions: AgentOption[];
  quickAssigneeOptions: AgentOption[];
  initiativeOptions: { id: string; name: string }[];

  agentPickerMode: 'assignee' | 'watcher' | null;
  agentPickerQuery: string;
  filteredAgentOptions: AgentOption[];
  scopePickerOpen: boolean;
  scopePickerQuery: string;
  filteredInitiativeOptions: { id: string; name: string }[];

  panelLoading: boolean;
  panelError: string | null;
  scopeSaving: boolean;
  launchWarningOpen: boolean;
  launchWarningAccepted: boolean;

  unresolvedAttachmentCount: number;
  canSend: boolean;
  composerGuidance: string;
  primaryActionLabel: string;

  guidanceStatus: string;
  guidancePreview: string | null;
  guidanceError: Error | null;

  inlineMessages: InlineMessage[];

  threadSidebarOpen: boolean;
  workspaceId: string | null;
  selectedProvider: ChatProviderId;
  selectedProviderDef: (typeof CHAT_PROVIDERS)[number];
}

const ChatDockStateContext = createContext<ChatDockState | null>(null);

// ── Dispatch context (stable callbacks) ──────────────────────────

export interface ChatDockDispatch {
  setDraft: (value: string) => void;
  setComposerMode: (mode: ComposerMode) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;

  selectAssignee: (agentId: string) => void;
  toggleWatcher: (agentId: string) => void;
  setSelectedInitiativeId: (id: string) => void;

  toggleAssigneePicker: () => void;
  toggleWatcherPicker: () => void;
  toggleScopePicker: () => void;
  setAgentPickerQuery: (query: string) => void;
  setScopePickerQuery: (query: string) => void;
  setAgentPickerMode: (mode: 'assignee' | 'watcher' | null) => void;
  setScopePickerOpen: (open: boolean) => void;

  handlePrimaryAction: () => Promise<void>;
  handleFilesAdded: (files: FileList | null) => void;
  handleRetryAttachment: (attachmentId: string) => void;

  openThreadPanel: (threadId: string, sourceEl?: HTMLElement | null) => Promise<void>;
  closeThreadPanel: () => void;
  loadThreadDetail: (threadId: string) => Promise<ChatThreadDetail | null>;
  applyScopeLink: (threadId: string, initiativeId: string | null) => Promise<void>;

  resetComposer: () => void;
  setComposerError: (error: string | null) => void;
  setComposerNotice: (notice: string | null) => void;
  setLaunchWarningAccepted: (accepted: boolean) => void;
  pushInlineMessage: (msg: Omit<InlineMessage, 'id' | 'timestamp'>) => void;
  clearInlineMessages: () => void;
  toggleThreadSidebar: () => void;
  setSelectedProvider: (provider: ChatProviderId) => void;
  cycleProvider: () => void;

  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  panelHeadingRef: React.MutableRefObject<HTMLHeadingElement | null>;
  composerShellRef: React.MutableRefObject<HTMLDivElement | null>;
}

const ChatDockDispatchContext = createContext<ChatDockDispatch | null>(null);

// ── Hooks ────────────────────────────────────────────────────────

export function useChatDockState() {
  const ctx = useContext(ChatDockStateContext);
  if (!ctx) throw new Error('useChatDockState must be used within ChatDockProvider');
  return ctx;
}

export function useChatDockDispatch() {
  const ctx = useContext(ChatDockDispatchContext);
  if (!ctx) throw new Error('useChatDockDispatch must be used within ChatDockProvider');
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────

interface ChatDockProviderProps {
  children: ReactNode;
  sessions: SessionTreeNode[];
  initiatives: Initiative[];
  workspaceId: string | null;
  query: string;
  statusFilter: StatusFilterId;
  sortOrder: SortOrder;
  timeFilterId: ActivityTimeFilterId;
  customTimeRange: { startIso: string | null; endIso: string | null };
  snapshot?: LiveChatSnapshot;
  onRequestRefresh?: () => Promise<void> | void;
}

export function ChatDockProvider({
  children,
  sessions,
  initiatives,
  workspaceId,
  query,
  statusFilter,
  sortOrder,
  timeFilterId,
  customTimeRange,
  snapshot,
  onRequestRefresh,
}: ChatDockProviderProps) {
  // ── Thread state ─────────────────────────────────────────────
  const [threads, setThreads] = useState<ChatThreadSummary[]>(snapshot?.threads ?? []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ChatThreadDetail | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  // ── Composer state ───────────────────────────────────────────
  const [composerMode, setComposerMode] = useState<ComposerMode>('resting');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);

  // ── Selection state ──────────────────────────────────────────
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>('');
  const [selectedWatcherIds, setSelectedWatcherIds] = useState<string[]>([]);
  const [selectedInitiativeId, setSelectedInitiativeId] = useState<string>('');

  // ── Picker state ─────────────────────────────────────────────
  const [agentPickerMode, setAgentPickerMode] = useState<'assignee' | 'watcher' | null>(null);
  const [agentPickerQuery, setAgentPickerQuery] = useState('');
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [scopePickerQuery, setScopePickerQuery] = useState('');

  // ── Inline messages state ────────────────────────────────────
  const [inlineMessages, setInlineMessages] = useState<InlineMessage[]>([]);

  // ── Thread sidebar state ────────────────────────────────────
  const [threadSidebarOpen, setThreadSidebarOpen] = useState(false);

  // ── Provider state ────────────────────────────────────────────
  const [selectedProvider, setSelectedProvider] = useState<ChatProviderId>('auto');

  // ── Launch warning state ─────────────────────────────────────
  const [scopeSaving, setScopeSaving] = useState(false);
  const [launchWarningOpen, setLaunchWarningOpen] = useState(false);
  const [launchWarningAccepted, setLaunchWarningAccepted] = useState(false);

  // ── Refs ─────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeCardRef = useRef<HTMLElement | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);

  // ── Snapshot merge ───────────────────────────────────────────
  useEffect(() => {
    if (!snapshot?.threads) return;
    setThreads((previous) => mergeThreads(previous, snapshot.threads));
  }, [snapshot?.threads, snapshot?.updatedAt]);

  useEffect(() => {
    if (!activeThreadId) return;
    setThreads((previous) =>
      previous.sort((a, b) => toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt))
    );
  }, [activeThreadId]);

  // ── Agent catalog ────────────────────────────────────────────
  const { data: catalogData } = useAgentCatalog({ enabled: true, refetchInterval: 8_000 });

  // ── Derived: options (3-layer merge) ────────────────────────
  const agentOptions = useMemo<AgentOption[]>(() => {
    const map = new Map<string, AgentOption>();

    // Layer 1: Seed from CANONICAL_AGENTS (always present)
    for (const def of CANONICAL_AGENTS) {
      map.set(def.id, {
        id: def.id,
        name: def.name,
        handle: def.handle,
        domain: def.domain,
        domainLabel: def.domainLabel,
        role: def.role,
        status: 'idle',
        currentTask: null,
        isSystem: false,
      });
    }

    // Layer 2: Overlay with live catalog agents (adds status/currentTask)
    if (catalogData?.agents) {
      for (const cat of catalogData.agents) {
        const existing = map.get(cat.id);
        if (existing) {
          existing.status = cat.status === 'running' ? 'running' : cat.blockers?.length ? 'blocked' : 'idle';
          existing.currentTask = cat.currentTask ?? null;
        } else {
          // Non-canonical live agent
          map.set(cat.id, {
            id: cat.id,
            name: cat.name,
            handle: cat.id,
            domain: 'custom',
            domainLabel: 'Custom Agent',
            role: 'Custom',
            status: cat.status === 'running' ? 'running' : cat.blockers?.length ? 'blocked' : 'idle',
            currentTask: cat.currentTask ?? null,
            isSystem: SYSTEM_AGENT_IDS.has(cat.id),
          });
        }
      }
    }

    // Layer 3: Merge any session-derived agents as fallback (custom agents)
    for (const session of sessions) {
      const id = (session.agentId ?? '').trim();
      const name = (session.agentName ?? '').trim();
      if (!id || !name || map.has(id)) continue;
      map.set(id, {
        id,
        name,
        handle: id,
        domain: 'custom',
        domainLabel: 'Custom Agent',
        role: 'Custom',
        status: 'idle',
        currentTask: null,
        isSystem: SYSTEM_AGENT_IDS.has(id),
      });
    }

    // Filter out system agents, sort by name
    return Array.from(map.values())
      .filter((a) => !a.isSystem)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [catalogData, sessions]);

  const initiativeOptions = useMemo(
    () =>
      initiatives
        .map((i) => ({ id: i.id, name: i.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [initiatives]
  );

  const selectedAssignee = useMemo(
    () => agentOptions.find((a) => a.id === selectedAssigneeId) ?? null,
    [agentOptions, selectedAssigneeId]
  );

  const selectedWatchers = useMemo(() => {
    const set = new Set(selectedWatcherIds);
    return agentOptions.filter((a) => set.has(a.id));
  }, [agentOptions, selectedWatcherIds]);

  const selectedInitiative = useMemo(
    () => initiativeOptions.find((i) => i.id === selectedInitiativeId) ?? null,
    [initiativeOptions, selectedInitiativeId]
  );

  useEffect(() => {
    if (!selectedAssigneeId) return;
    setSelectedWatcherIds((prev) => prev.filter((id) => id !== selectedAssigneeId));
  }, [selectedAssigneeId]);

  const quickAssigneeOptions = useMemo(() => agentOptions.slice(0, 8), [agentOptions]);

  const filteredAgentOptions = useMemo(() => {
    const q = agentPickerQuery.trim().toLowerCase();
    if (!q) return agentOptions;
    return agentOptions.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.handle.toLowerCase().includes(q) ||
        a.domain.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q)
    );
  }, [agentOptions, agentPickerQuery]);

  const filteredInitiativeOptions = useMemo(() => {
    const q = scopePickerQuery.trim().toLowerCase();
    if (!q) return initiativeOptions;
    return initiativeOptions.filter((i) => i.name.toLowerCase().includes(q));
  }, [initiativeOptions, scopePickerQuery]);

  // ── Derived: threads ─────────────────────────────────────────
  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = threads.filter((thread) => {
      if (!statusMatchesFilter(thread, statusFilter)) return false;
      if (!threadMatchesTimeWindow(thread, timeFilterId, customTimeRange)) return false;
      if (normalizedQuery.length === 0) return true;
      return summarizeThreadForSearch(thread).includes(normalizedQuery);
    });
    filtered.sort((a, b) => {
      const delta = toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt);
      return sortOrder === 'newest' ? delta : -delta;
    });
    return filtered;
  }, [customTimeRange, query, sortOrder, statusFilter, threads, timeFilterId]);

  const displayedThreads = useMemo(() => {
    if (!activeThreadId) return filteredThreads;
    if (filteredThreads.some((t) => t.id === activeThreadId)) return filteredThreads;
    const summary = threads.find((t) => t.id === activeThreadId);
    if (!summary) return filteredThreads;
    return [summary, ...filteredThreads];
  }, [activeThreadId, filteredThreads, threads]);

  const activeThreadSummary = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  // ── Derived: composer ────────────────────────────────────────
  const unresolvedAttachmentCount = useMemo(
    () => draftAttachments.filter((a) => a.status !== 'ready').length,
    [draftAttachments]
  );

  const draftTrimmed = draft.trim();
  const canSend = draftTrimmed.length > 0 && !sending;

  const composerGuidance = useMemo(() => {
    if (unresolvedAttachmentCount > 0)
      return `${unresolvedAttachmentCount} attachment(s) still processing.`;
    return 'Press Enter to send.';
  }, [unresolvedAttachmentCount]);

  const primaryActionLabel = useMemo(() => {
    if (sending) return 'Sending\u2026';
    if (launching) return 'Launching\u2026';
    return 'Send';
  }, [launching, sending]);

  // ── Guidance chat ────────────────────────────────────────────
  const guidanceTransport = useMemo(
    () => new TextStreamChatTransport<UiChatMessage>({ api: '/orgx/api/chat/usechat' }),
    []
  );

  const {
    messages: guidanceMessages,
    setMessages: setGuidanceMessages,
    sendMessage: sendGuidanceMessage,
    status: guidanceStatus,
    error: guidanceError,
    clearError: clearGuidanceError,
  } = useChat<UiChatMessage>({
    id: `orgx-chat-guidance-${workspaceId ?? 'global'}`,
    transport: guidanceTransport,
    onError: (error) => {
      setComposerError(humanizeApiError(error?.message ?? null, 'send'));
    },
  });

  useEffect(() => {
    if (!activeThread) {
      setGuidanceMessages([]);
      return;
    }
    setGuidanceMessages(toUiMessagesFromThreadMessages(activeThread.id, activeThread.messages));
  }, [activeThread, setGuidanceMessages]);

  const guidancePreview = useMemo(() => {
    const last = [...guidanceMessages].reverse().find((m) => m.role === 'assistant');
    if (!last) return null;
    const text = uiMessageToText(last);
    return text.length > 0 ? text : null;
  }, [guidanceMessages]);

  // Pipe completed guidance messages into inlineMessages
  const lastGuidanceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (guidanceStatus !== 'ready' && guidanceStatus !== 'error') return;
    if (!guidancePreview) return;
    const lastAssistant = [...guidanceMessages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant || lastAssistant.id === lastGuidanceIdRef.current) return;
    lastGuidanceIdRef.current = lastAssistant.id;
    setInlineMessages((prev) => [
      ...prev,
      {
        id: `guidance_${lastAssistant.id}`,
        role: 'agent' as const,
        body: guidancePreview,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, [guidanceStatus, guidancePreview, guidanceMessages]);

  // ── Callbacks ────────────────────────────────────────────────

  const resetComposer = useCallback(() => {
    setDraft('');
    setDraftAttachments([]);
    setLaunchWarningOpen(false);
    setLaunchWarningAccepted(false);
    setComposerError(null);
    setComposerNotice(null);
  }, []);

  const pushInlineMessage = useCallback(
    (msg: Omit<InlineMessage, 'id' | 'timestamp'>) => {
      setInlineMessages((prev) => [
        ...prev,
        { ...msg, id: `inline_${crypto.randomUUID()}`, timestamp: new Date().toISOString() },
      ]);
    },
    []
  );

  const clearInlineMessages = useCallback(() => setInlineMessages([]), []);

  const toggleThreadSidebar = useCallback(() => setThreadSidebarOpen((prev) => !prev), []);

  const selectedProviderDef = useMemo(
    () => CHAT_PROVIDERS.find((p) => p.id === selectedProvider) ?? CHAT_PROVIDERS[0],
    [selectedProvider]
  );

  const cycleProvider = useCallback(() => {
    setSelectedProvider((prev) => {
      const idx = CHAT_PROVIDERS.findIndex((p) => p.id === prev);
      return CHAT_PROVIDERS[(idx + 1) % CHAT_PROVIDERS.length].id;
    });
  }, []);

  const refreshAfterMutation = useCallback(async () => {
    if (typeof onRequestRefresh === 'function') await onRequestRefresh();
  }, [onRequestRefresh]);

  const loadThreadDetail = useCallback(async (threadId: string) => {
    setPanelLoading(true);
    setPanelError(null);
    const response = await fetchJson<{ ok?: boolean; thread?: unknown; error?: string }>(
      `/orgx/api/chat/threads/${encodeURIComponent(threadId)}`
    );
    if (!response.ok || !response.data?.thread) {
      setPanelLoading(false);
      setPanelError(humanizeApiError(response.error, 'load'));
      return null;
    }
    const detail = normalizeThreadDetail(response.data.thread);
    if (!detail) {
      setPanelLoading(false);
      setPanelError('Thread detail payload was invalid.');
      return null;
    }
    setActiveThread(detail);
    setPanelLoading(false);
    return detail;
  }, []);

  const openThreadPanel = useCallback(
    async (threadId: string, sourceEl?: HTMLElement | null) => {
      if (sourceEl) activeCardRef.current = sourceEl;
      setActiveThreadId(threadId);
      await loadThreadDetail(threadId);
      requestAnimationFrame(() => panelHeadingRef.current?.focus());
    },
    [loadThreadDetail]
  );

  const closeThreadPanel = useCallback(() => {
    setActiveThreadId(null);
    setActiveThread(null);
    setPanelError(null);
    setPanelLoading(false);
    activeCardRef.current?.focus();
  }, []);

  const queueAttachmentStatusProgress = useCallback((attachmentId: string) => {
    window.setTimeout(() => {
      setDraftAttachments((prev) =>
        prev.map((a) =>
          a.id === attachmentId
            ? { ...a, status: 'indexing', updatedAt: new Date().toISOString() }
            : a
        )
      );
    }, 80);
    window.setTimeout(() => {
      setDraftAttachments((prev) =>
        prev.map((a) => {
          if (a.id !== attachmentId) return a;
          const unsupported =
            a.mimeType?.toLowerCase() === 'application/x-msdownload' ||
            a.name.toLowerCase().endsWith('.exe');
          const tooLarge = (a.sizeBytes ?? 0) > 25 * 1024 * 1024;
          if (unsupported)
            return { ...a, status: 'failed', error: 'Unsupported file type.', updatedAt: new Date().toISOString() };
          if (tooLarge)
            return { ...a, status: 'failed', error: 'File exceeds 25 MB extraction limit.', updatedAt: new Date().toISOString() };
          return { ...a, status: 'ready', error: null, updatedAt: new Date().toISOString() };
        })
      );
    }, 420);
  }, []);

  const handleFilesAdded = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const now = new Date().toISOString();
      const next = Array.from(files).map((file) => ({
        id: `draft_att_${crypto.randomUUID()}`,
        name: file.name,
        mimeType: file.type || null,
        sizeBytes: Number.isFinite(file.size) ? file.size : null,
        status: 'preparing' as const,
        error: null,
        masked: false,
        createdAt: now,
        updatedAt: now,
      }));
      setDraftAttachments((prev) => prev.concat(next));
      next.forEach((a) => queueAttachmentStatusProgress(a.id));
      captureTelemetry('chat_attachment_state_changed', { count: next.length, state: 'preparing' });
    },
    [queueAttachmentStatusProgress]
  );

  const handleRetryAttachment = useCallback(
    (attachmentId: string) => {
      setDraftAttachments((prev) =>
        prev.map((a) =>
          a.id === attachmentId
            ? { ...a, status: 'preparing', error: null, updatedAt: new Date().toISOString() }
            : a
        )
      );
      queueAttachmentStatusProgress(attachmentId);
      captureTelemetry('chat_attachment_state_changed', { state: 'retry' });
    },
    [queueAttachmentStatusProgress]
  );

  const selectAssignee = useCallback((agentId: string) => {
    setSelectedAssigneeId((prev) => (prev === agentId ? '' : agentId));
    setSelectedWatcherIds((prev) => prev.filter((id) => id !== agentId));
    setAgentPickerMode(null);
    setAgentPickerQuery('');
  }, []);

  const toggleWatcher = useCallback((agentId: string) => {
    setSelectedWatcherIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : prev.concat(agentId)
    );
  }, []);

  const toggleAssigneePicker = useCallback(() => {
    setScopePickerOpen(false);
    setScopePickerQuery('');
    setAgentPickerMode((prev) => (prev === 'assignee' ? null : 'assignee'));
    setAgentPickerQuery('');
  }, []);

  const toggleWatcherPicker = useCallback(() => {
    setScopePickerOpen(false);
    setScopePickerQuery('');
    setAgentPickerMode((prev) => (prev === 'watcher' ? null : 'watcher'));
    setAgentPickerQuery('');
  }, []);

  const toggleScopePicker = useCallback(() => {
    setAgentPickerMode(null);
    setAgentPickerQuery('');
    setScopePickerOpen((prev) => !prev);
    setScopePickerQuery('');
  }, []);

  const applyScopeLink = useCallback(
    async (threadId: string, initiativeId: string | null) => {
      setScopeSaving(true);
      const initiative = initiativeOptions.find((i) => i.id === initiativeId) ?? null;
      const response = await fetchJson<{ ok?: boolean; thread?: unknown; error?: string }>(
        '/orgx/api/chat/link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId,
            project_id: workspaceId ?? undefined,
            initiativeId: initiative?.id ?? null,
            initiativeTitle: initiative?.name ?? null,
            relinked: true,
          }),
        }
      );
      setScopeSaving(false);
      if (!response.ok || !response.data?.thread) {
        setPanelError(response.error ?? 'Scope link failed.');
        return;
      }
      const updated = normalizeThreadSummary(response.data.thread);
      if (updated) setThreads((prev) => upsertThread(prev, updated));
      await loadThreadDetail(threadId);
      await refreshAfterMutation();
      captureTelemetry('chat_thread_linked_initiative', {
        threadId,
        initiativeId: initiative?.id ?? null,
      });
    },
    [initiativeOptions, loadThreadDetail, refreshAfterMutation, workspaceId]
  );

  // ── Send + Launch ────────────────────────────────────────────

  const sendAssistantGuidance = useCallback(
    async (input: { thread: ChatThreadSummary; prompt: string }) => {
      clearGuidanceError();
      await sendGuidanceMessage(
        { text: input.prompt },
        {
          body: {
            threadId: input.thread.id,
            project_id: workspaceId ?? undefined,
            initiativeId: input.thread.initiativeId ?? selectedInitiative?.id ?? undefined,
            initiativeTitle: input.thread.initiativeTitle ?? selectedInitiative?.name ?? undefined,
            assigneeId: selectedAssignee?.id ?? input.thread.assigneeId ?? undefined,
            assigneeName: selectedAssignee?.name ?? input.thread.assigneeName ?? undefined,
            watcherIds: selectedWatchers.map((w) => w.id),
            watcherNames: selectedWatchers.map((w) => w.name),
          },
        }
      );
      await refreshAfterMutation();
      await loadThreadDetail(input.thread.id);
    },
    [
      clearGuidanceError,
      loadThreadDetail,
      refreshAfterMutation,
      selectedAssignee?.id,
      selectedAssignee?.name,
      selectedInitiative?.id,
      selectedInitiative?.name,
      selectedWatchers,
      sendGuidanceMessage,
      workspaceId,
    ]
  );

  const sendMessage = useCallback(async (): Promise<{
    thread: ChatThreadSummary | null;
    messageId: string | null;
  }> => {
    const body = draft.trim();
    if (!body) {
      setComposerError('Write a message before sending.');
      return { thread: null, messageId: null };
    }
    setComposerError(null);
    setComposerNotice(null);
    setSending(true);
    const response = await fetchJson<{
      ok?: boolean;
      thread?: unknown;
      message?: { id?: string };
      error?: string;
    }>('/orgx/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: activeThreadId ?? undefined,
        project_id: workspaceId ?? undefined,
        initiativeId: selectedInitiative?.id ?? activeThread?.initiativeId ?? undefined,
        initiativeTitle: selectedInitiative?.name ?? activeThread?.initiativeTitle ?? undefined,
        assigneeId: selectedAssignee?.id ?? activeThread?.assigneeId ?? undefined,
        assigneeName: selectedAssignee?.name ?? activeThread?.assigneeName ?? undefined,
        watcherIds: selectedWatchers.map((w) => w.id),
        watcherNames: selectedWatchers.map((w) => w.name),
        body,
        attachments: draftAttachments.map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          status: a.status,
          error: a.error,
          masked: a.masked,
        })),
      }),
    });
    setSending(false);
    if (!response.ok || !response.data?.thread) {
      setComposerError(humanizeApiError(response.error, 'send'));
      captureTelemetry('chat_message_send_failed', { reason: response.error ?? 'unknown' });
      return { thread: null, messageId: null };
    }
    const normalized = normalizeThreadSummary(response.data.thread);
    if (!normalized) {
      setComposerError('Send succeeded but thread payload was invalid.');
      return { thread: null, messageId: null };
    }
    setThreads((prev) => upsertThread(prev, normalized));
    // Push user message inline instead of setting toast notice
    pushInlineMessage({ role: 'user', body });
    if (selectedProvider !== 'auto' && selectedAssignee) {
      pushInlineMessage({
        role: 'system',
        body: `Routing to ${selectedAssignee.name} via ${selectedProviderDef.label}`,
      });
    }
    captureTelemetry('chat_message_sent', {
      threadId: normalized.id,
      watcherCount: normalized.watcherIds.length,
    });
    await refreshAfterMutation();
    const messageId =
      response.data.message && typeof response.data.message.id === 'string'
        ? response.data.message.id
        : normalized.latestMessage?.id ?? null;
    setActiveThreadId(normalized.id);
    await loadThreadDetail(normalized.id);
    void sendAssistantGuidance({ thread: normalized, prompt: body }).catch((error) => {
      pushInlineMessage({
        role: 'error',
        body: humanizeApiError(error instanceof Error ? error.message : String(error ?? ''), 'send'),
      });
    });
    resetComposer();
    // Stay in reviewing mode so inline response is visible
    setComposerMode('reviewing');
    return { thread: normalized, messageId };
  }, [
    activeThread?.assigneeId,
    activeThread?.assigneeName,
    activeThread?.initiativeId,
    activeThread?.initiativeTitle,
    activeThreadId,
    draft,
    draftAttachments,
    loadThreadDetail,
    refreshAfterMutation,
    resetComposer,
    sendAssistantGuidance,
    selectedAssignee?.id,
    selectedAssignee?.name,
    selectedInitiative?.id,
    selectedInitiative?.name,
    selectedProvider,
    selectedProviderDef,
    selectedWatchers,
    workspaceId,
  ]);

  const launchThread = useCallback(
    async (thread: ChatThreadSummary, messageId: string | null) => {
      if (!messageId) {
        pushInlineMessage({ role: 'error', body: 'Send a message first to launch.' });
        return;
      }
      if (!selectedAssignee) {
        pushInlineMessage({ role: 'error', body: 'Pick an agent with @ before launching.' });
        return;
      }
      if (unresolvedAttachmentCount > 0 && !launchWarningAccepted) {
        setLaunchWarningOpen(true);
        pushInlineMessage({ role: 'error', body: 'Some attachments are still processing. Confirm to continue.' });
        return;
      }
      setLaunching(true);
      setComposerError(null);
      setComposerNotice(null);
      const launchStart = await fetchJson<{
        ok?: boolean;
        sessionId?: string;
        runId?: string;
        provider?: string;
        model?: string;
        error?: string;
        code?: string;
      }>('/orgx/api/agents/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAssignee.id,
          message: draft.trim().length > 0 ? draft.trim() : thread.lastSnippet ?? thread.title,
          initiativeId: thread.initiativeId ?? selectedInitiative?.id ?? undefined,
          initiativeTitle: thread.initiativeTitle ?? selectedInitiative?.name ?? undefined,
          workstreamId: thread.workstreamId ?? undefined,
          taskId: thread.taskId ?? undefined,
          provider: selectedProvider !== 'auto' ? selectedProvider : undefined,
        }),
      });
      const runId = launchStart.data?.sessionId ?? launchStart.data?.runId ?? null;
      const launchStatus =
        launchStart.ok && runId
          ? ('running' as const)
          : launchStart.ok
            ? ('queued' as const)
            : ('blocked' as const);
      const blockedReason = launchStart.ok
        ? null
        : launchStart.error ?? 'Launch request failed before queueing.';
      const recordLaunch = await fetchJson<{
        ok?: boolean;
        thread?: unknown;
        launch?: { id?: string; status?: string };
        error?: string;
      }>('/orgx/api/chat/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: thread.id,
          messageId,
          assigneeId: selectedAssignee.id,
          assigneeName: selectedAssignee.name,
          watcherIds: selectedWatchers.map((w) => w.id),
          watcherNames: selectedWatchers.map((w) => w.name),
          executionMode: 'local_queue',
          provider: launchStart.data?.provider ?? (selectedProvider !== 'auto' ? selectedProvider : 'openclaw'),
          runId: runId ?? undefined,
          status: launchStatus,
          blockedReason: blockedReason ?? undefined,
          warnings:
            unresolvedAttachmentCount > 0
              ? [`${unresolvedAttachmentCount} attachment(s) were not ready at launch.`]
              : [],
        }),
      });
      setLaunching(false);
      setLaunchWarningAccepted(false);
      setLaunchWarningOpen(false);
      if (!recordLaunch.ok || !recordLaunch.data?.thread) {
        setComposerError(
          recordLaunch.error
            ? humanizeApiError(recordLaunch.error, 'launch')
            : blockedReason ?? 'Launch state could not be persisted. Message remained saved.'
        );
        captureTelemetry('chat_launch_failed', {
          threadId: thread.id,
          reason: recordLaunch.error ?? blockedReason ?? 'unknown',
        });
        return;
      }
      const nextThread = normalizeThreadSummary(recordLaunch.data.thread);
      if (nextThread) setThreads((prev) => upsertThread(prev, nextThread));
      await loadThreadDetail(thread.id);
      await refreshAfterMutation();
      if (!launchStart.ok) {
        setComposerError(`Launch blocked: ${blockedReason ?? 'Set assignee and retry.'}`);
        captureTelemetry('chat_launch_blocked', {
          threadId: thread.id,
          reason: blockedReason ?? 'unknown',
        });
        return;
      }
      const routedLabel =
        launchStart.data?.provider === 'anthropic'
          ? 'Claude Code'
          : launchStart.data?.provider === 'openai'
            ? 'Codex'
            : selectedProviderDef.shortLabel;
      const modelSuffix = launchStart.data?.model ? ` (${launchStart.data.model})` : '';
      setComposerNotice(
        runId
          ? `Launch started via ${routedLabel}${modelSuffix}. Thread timeline now tracks execution state.`
          : `Launch queued locally via ${routedLabel}. Run starts when a worker is available.`
      );
      captureTelemetry(runId ? 'chat_launch_started' : 'chat_launch_queued', {
        threadId: thread.id,
        runId,
        assigneeId: selectedAssignee.id,
      });
    },
    [
      draft,
      launchWarningAccepted,
      loadThreadDetail,
      refreshAfterMutation,
      selectedAssignee,
      selectedInitiative?.id,
      selectedInitiative?.name,
      selectedProvider,
      selectedProviderDef,
      selectedWatchers,
      unresolvedAttachmentCount,
    ]
  );

  const handleSendOnly = useCallback(async () => {
    const result = await sendMessage();
    if (result.thread?.id) await openThreadPanel(result.thread.id);
  }, [openThreadPanel, sendMessage]);

  const handleSendAndLaunch = useCallback(async () => {
    const result = await sendMessage();
    if (!result.thread) return;
    await launchThread(result.thread, result.messageId);
    await openThreadPanel(result.thread.id);
  }, [launchThread, openThreadPanel, sendMessage]);

  const handlePrimaryAction = useCallback(async () => {
    if (!canSend) return;
    if (selectedAssignee) {
      await handleSendAndLaunch();
      return;
    }
    await handleSendOnly();
  }, [canSend, handleSendAndLaunch, handleSendOnly, selectedAssignee]);

  // ── Assemble contexts ────────────────────────────────────────

  const stateValue = useMemo<ChatDockState>(
    () => ({
      threads,
      activeThreadId,
      activeThread,
      activeThreadSummary,
      displayedThreads,
      composerMode,
      draft,
      draftAttachments,
      sending,
      launching,
      composerError,
      composerNotice,
      selectedAssigneeId,
      selectedAssignee,
      selectedWatcherIds,
      selectedWatchers,
      selectedInitiativeId,
      selectedInitiative,
      agentOptions,
      quickAssigneeOptions,
      initiativeOptions,
      agentPickerMode,
      agentPickerQuery,
      filteredAgentOptions,
      scopePickerOpen,
      scopePickerQuery,
      filteredInitiativeOptions,
      panelLoading,
      panelError,
      scopeSaving,
      launchWarningOpen,
      launchWarningAccepted,
      unresolvedAttachmentCount,
      canSend,
      composerGuidance,
      primaryActionLabel,
      guidanceStatus,
      guidancePreview,
      guidanceError: guidanceError ?? null,
      inlineMessages,
      threadSidebarOpen,
      workspaceId,
      selectedProvider,
      selectedProviderDef,
    }),
    [
      threads,
      activeThreadId,
      activeThread,
      activeThreadSummary,
      displayedThreads,
      composerMode,
      draft,
      draftAttachments,
      sending,
      launching,
      composerError,
      composerNotice,
      selectedAssigneeId,
      selectedAssignee,
      selectedWatcherIds,
      selectedWatchers,
      selectedInitiativeId,
      selectedInitiative,
      agentOptions,
      quickAssigneeOptions,
      initiativeOptions,
      agentPickerMode,
      agentPickerQuery,
      filteredAgentOptions,
      scopePickerOpen,
      scopePickerQuery,
      filteredInitiativeOptions,
      panelLoading,
      panelError,
      scopeSaving,
      launchWarningOpen,
      launchWarningAccepted,
      unresolvedAttachmentCount,
      canSend,
      composerGuidance,
      primaryActionLabel,
      guidanceStatus,
      guidancePreview,
      guidanceError,
      inlineMessages,
      threadSidebarOpen,
      workspaceId,
      selectedProvider,
      selectedProviderDef,
    ]
  );

  const dispatchValue = useMemo<ChatDockDispatch>(
    () => ({
      setDraft,
      setComposerMode,
      setDraftAttachments,
      selectAssignee,
      toggleWatcher,
      setSelectedInitiativeId,
      toggleAssigneePicker,
      toggleWatcherPicker,
      toggleScopePicker,
      setAgentPickerQuery,
      setScopePickerQuery,
      setAgentPickerMode,
      setScopePickerOpen,
      handlePrimaryAction,
      handleFilesAdded,
      handleRetryAttachment,
      openThreadPanel,
      closeThreadPanel,
      loadThreadDetail,
      applyScopeLink,
      resetComposer,
      setComposerError,
      setComposerNotice,
      setLaunchWarningAccepted,
      pushInlineMessage,
      clearInlineMessages,
      toggleThreadSidebar,
      setSelectedProvider,
      cycleProvider,
      fileInputRef,
      panelHeadingRef,
      composerShellRef,
    }),
    [
      selectAssignee,
      toggleWatcher,
      toggleAssigneePicker,
      toggleWatcherPicker,
      toggleScopePicker,
      handlePrimaryAction,
      handleFilesAdded,
      handleRetryAttachment,
      openThreadPanel,
      closeThreadPanel,
      loadThreadDetail,
      applyScopeLink,
      resetComposer,
      pushInlineMessage,
      clearInlineMessages,
      toggleThreadSidebar,
      cycleProvider,
    ]
  );

  return (
    <ChatDockStateContext.Provider value={stateValue}>
      <ChatDockDispatchContext.Provider value={dispatchValue}>
        {children}
      </ChatDockDispatchContext.Provider>
    </ChatDockStateContext.Provider>
  );
}
