import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport, type UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { cutoffEpochForActivityFilter, type ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { formatRelativeTime } from '@/lib/time';
import { captureTelemetry } from '@/lib/telemetry';
import type {
  ChatAttachmentSummary,
  ChatLaunchSummary,
  ChatThreadSummary,
  Initiative,
  LiveChatSnapshot,
  SessionTreeNode,
} from '@/types';

type StatusFilterId = 'all' | 'completed' | 'needs_attention' | 'in_progress';
type SortOrder = 'newest' | 'oldest';

type ChatSurfaceProps = {
  sessions: SessionTreeNode[];
  initiatives: Initiative[];
  workspaceId: string | null;
  query: string;
  statusFilter: StatusFilterId;
  sortOrder: SortOrder;
  timeFilterId: ActivityTimeFilterId;
  customTimeRange: {
    startIso: string | null;
    endIso: string | null;
  };
  snapshot?: LiveChatSnapshot;
  onRequestRefresh?: () => Promise<void> | void;
};

type ChatThreadDetail = Omit<ChatThreadSummary, 'latestMessage' | 'latestLaunch'> & {
  messages: Array<{
    id: string;
    threadId: string;
    role: 'user' | 'agent' | 'system';
    body: string;
    senderId: string | null;
    senderName: string | null;
    createdAt: string;
    updatedAt: string;
    attachments: ChatAttachmentSummary[];
    metadata: Record<string, unknown>;
  }>;
  launches: ChatLaunchSummary[];
};

type DraftAttachment = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: 'preparing' | 'indexing' | 'ready' | 'failed';
  error: string | null;
  masked: boolean;
  createdAt: string;
  updatedAt: string;
};

type AgentOption = {
  id: string;
  name: string;
};

type UiChatMessage = UIMessage<{
  threadId?: string;
  messageId?: string;
  source?: string;
}>;

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function attachmentReadableSize(bytes: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const QUICK_START_PROMPTS = [
  'Draft an implementation plan for this initiative.',
  'Summarize blockers from Activity and propose next actions.',
  'Prepare a ready-to-send update for stakeholders.',
] as const;

const CONTROL_SPRING = { type: 'spring' as const, stiffness: 400, damping: 25 };
const CONTROL_TAP = { scale: 0.985 };

function humanizeApiError(error: string | null, action: 'send' | 'launch' | 'load'): string {
  const normalized = (error ?? '').trim().toLowerCase();
  if (normalized.includes('unknown api endpoint')) {
    return 'Chat API unavailable in current runtime. Restart the plugin so /orgx/api/chat/* routes are active.';
  }
  if (normalized.includes('network error') || normalized.includes('failed to fetch')) {
    return action === 'load'
      ? 'Could not load thread details. Check connection and retry.'
      : 'Connection lost while sending. Draft is preserved.';
  }
  if (!normalized) {
    if (action === 'send') return 'Message send failed. Draft is preserved.';
    if (action === 'launch') return 'Launch request failed. Thread remains saved.';
    return 'Request failed.';
  }
  return error as string;
}

function summarizeThreadForSearch(thread: ChatThreadSummary): string {
  return [
    thread.title,
    thread.summary ?? '',
    thread.lastSnippet ?? '',
    thread.assigneeName ?? '',
    thread.initiativeTitle ?? '',
    ...(thread.watcherNames ?? []),
  ]
    .join(' ')
    .toLowerCase();
}

function statusMatchesFilter(thread: ChatThreadSummary, filter: StatusFilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'completed') return thread.status === 'completed';
  if (filter === 'in_progress') return thread.status === 'queued' || thread.status === 'running';
  if (filter === 'needs_attention') return thread.status === 'blocked' || thread.status === 'failed';
  return true;
}

function statusLabel(status: ChatThreadSummary['status']): string {
  if (status === 'message_only') return 'Message sent';
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'blocked') return 'Blocked';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return status;
}

function statusClasses(status: ChatThreadSummary['status']): string {
  if (status === 'running') {
    return 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]';
  }
  if (status === 'completed') {
    return 'border-teal/30 bg-teal/[0.12] text-teal-100';
  }
  if (status === 'blocked' || status === 'failed') {
    return 'border-rose-400/30 bg-rose-400/[0.12] text-rose-100';
  }
  if (status === 'queued') {
    return 'border-white/[0.18] bg-white/[0.08] text-primary';
  }
  return 'border-white/[0.12] bg-white/[0.04] text-secondary';
}

function roleBadge(role: 'user' | 'agent' | 'system'): string {
  if (role === 'user') return 'You';
  if (role === 'agent') return 'Agent';
  return 'System';
}

function threadRoleToUiRole(role: 'user' | 'agent' | 'system'): UiChatMessage['role'] {
  if (role === 'agent') return 'assistant';
  return role;
}

function uiMessageToText(message: UiChatMessage): string {
  return message.parts
    .filter((part): part is Extract<UiChatMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

function toUiMessagesFromThreadMessages(
  threadId: string,
  messages: ChatThreadDetail['messages']
): UiChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: threadRoleToUiRole(message.role),
    metadata: {
      threadId,
      messageId: message.id,
      source: 'thread-store',
    },
    parts: [
      {
        type: 'text',
        text: message.body,
        state: 'done',
      },
    ],
  }));
}

function inferThreadStatusFromLaunch(status: ChatLaunchSummary['status']): ChatThreadSummary['status'] {
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'message_only';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeThreadSummary(input: unknown): ChatThreadSummary | null {
  const row = asRecord(input);
  if (!row) return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  const latestMessage = asRecord(row.latestMessage);
  const latestLaunch = asRecord(row.latestLaunch);
  return {
    id,
    commandCenterId: typeof row.commandCenterId === 'string' ? row.commandCenterId : null,
    initiativeId: typeof row.initiativeId === 'string' ? row.initiativeId : null,
    initiativeTitle: typeof row.initiativeTitle === 'string' ? row.initiativeTitle : null,
    workstreamId: typeof row.workstreamId === 'string' ? row.workstreamId : null,
    taskId: typeof row.taskId === 'string' ? row.taskId : null,
    title: typeof row.title === 'string' && row.title.trim().length > 0 ? row.title : 'Untitled thread',
    summary: typeof row.summary === 'string' ? row.summary : null,
    status:
      row.status === 'queued' ||
      row.status === 'running' ||
      row.status === 'blocked' ||
      row.status === 'completed' ||
      row.status === 'failed' ||
      row.status === 'message_only'
        ? row.status
        : 'message_only',
    assigneeId: typeof row.assigneeId === 'string' ? row.assigneeId : null,
    assigneeName: typeof row.assigneeName === 'string' ? row.assigneeName : null,
    watcherIds: Array.isArray(row.watcherIds)
      ? row.watcherIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    watcherNames: Array.isArray(row.watcherNames)
      ? row.watcherNames.filter((entry): entry is string => typeof entry === 'string')
      : [],
    messageCount: typeof row.messageCount === 'number' ? Math.max(0, Math.floor(row.messageCount)) : 0,
    launchCount: typeof row.launchCount === 'number' ? Math.max(0, Math.floor(row.launchCount)) : 0,
    lastMessageAt: typeof row.lastMessageAt === 'string' ? row.lastMessageAt : null,
    lastLaunchAt: typeof row.lastLaunchAt === 'string' ? row.lastLaunchAt : null,
    lastActivityAt:
      typeof row.lastActivityAt === 'string' && row.lastActivityAt.length > 0
        ? row.lastActivityAt
        : new Date().toISOString(),
    lastSnippet: typeof row.lastSnippet === 'string' ? row.lastSnippet : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
    latestMessage: latestMessage
      ? ({
          id: typeof latestMessage.id === 'string' ? latestMessage.id : `msg_${id}`,
          threadId: typeof latestMessage.threadId === 'string' ? latestMessage.threadId : id,
          role:
            latestMessage.role === 'agent' || latestMessage.role === 'system'
              ? latestMessage.role
              : 'user',
          body: typeof latestMessage.body === 'string' ? latestMessage.body : '',
          senderId: typeof latestMessage.senderId === 'string' ? latestMessage.senderId : null,
          senderName: typeof latestMessage.senderName === 'string' ? latestMessage.senderName : null,
          createdAt:
            typeof latestMessage.createdAt === 'string'
              ? latestMessage.createdAt
              : typeof row.lastMessageAt === 'string'
                ? row.lastMessageAt
                : new Date().toISOString(),
          updatedAt:
            typeof latestMessage.updatedAt === 'string'
              ? latestMessage.updatedAt
              : typeof row.lastMessageAt === 'string'
                ? row.lastMessageAt
                : new Date().toISOString(),
          attachments: Array.isArray(latestMessage.attachments)
            ? latestMessage.attachments.filter(
                (entry): entry is ChatAttachmentSummary =>
                  Boolean(entry) && typeof entry === 'object'
              )
            : [],
          metadata:
            latestMessage.metadata && typeof latestMessage.metadata === 'object'
              ? (latestMessage.metadata as Record<string, unknown>)
              : {},
        } as const)
      : null,
    latestLaunch: latestLaunch
      ? ({
          id: typeof latestLaunch.id === 'string' ? latestLaunch.id : `launch_${id}`,
          threadId: typeof latestLaunch.threadId === 'string' ? latestLaunch.threadId : id,
          messageId:
            typeof latestLaunch.messageId === 'string'
              ? latestLaunch.messageId
              : (typeof row.lastMessageAt === 'string' ? `msg_${row.lastMessageAt}` : `msg_${id}`),
          assigneeId: typeof latestLaunch.assigneeId === 'string' ? latestLaunch.assigneeId : null,
          assigneeName: typeof latestLaunch.assigneeName === 'string' ? latestLaunch.assigneeName : null,
          watcherIds: Array.isArray(latestLaunch.watcherIds)
            ? latestLaunch.watcherIds.filter((entry): entry is string => typeof entry === 'string')
            : [],
          watcherNames: Array.isArray(latestLaunch.watcherNames)
            ? latestLaunch.watcherNames.filter((entry): entry is string => typeof entry === 'string')
            : [],
          executionMode:
            latestLaunch.executionMode === 'cloud' || latestLaunch.executionMode === 'hybrid'
              ? latestLaunch.executionMode
              : 'local_queue',
          provider: typeof latestLaunch.provider === 'string' ? latestLaunch.provider : null,
          runId: typeof latestLaunch.runId === 'string' ? latestLaunch.runId : null,
          status:
            latestLaunch.status === 'queued' ||
            latestLaunch.status === 'running' ||
            latestLaunch.status === 'blocked' ||
            latestLaunch.status === 'completed' ||
            latestLaunch.status === 'failed' ||
            latestLaunch.status === 'requested'
              ? latestLaunch.status
              : 'requested',
          blockedReason:
            typeof latestLaunch.blockedReason === 'string' ? latestLaunch.blockedReason : null,
          warnings: Array.isArray(latestLaunch.warnings)
            ? latestLaunch.warnings.filter((entry): entry is string => typeof entry === 'string')
            : [],
          requestedAt:
            typeof latestLaunch.requestedAt === 'string'
              ? latestLaunch.requestedAt
              : typeof row.lastLaunchAt === 'string'
                ? row.lastLaunchAt
                : new Date().toISOString(),
          updatedAt:
            typeof latestLaunch.updatedAt === 'string'
              ? latestLaunch.updatedAt
              : typeof row.lastLaunchAt === 'string'
                ? row.lastLaunchAt
                : new Date().toISOString(),
          metadata:
            latestLaunch.metadata && typeof latestLaunch.metadata === 'object'
              ? (latestLaunch.metadata as Record<string, unknown>)
              : {},
        } as const)
      : null,
  };
}

function normalizeThreadDetail(input: unknown): ChatThreadDetail | null {
  const row = asRecord(input);
  if (!row) return null;
  const summary = normalizeThreadSummary({
    ...row,
    latestMessage: Array.isArray(row.messages) ? row.messages[row.messages.length - 1] : null,
    latestLaunch: Array.isArray(row.launches) ? row.launches[0] : null,
  });
  if (!summary) return null;
  const messages: ChatThreadDetail['messages'] = Array.isArray(row.messages)
    ? row.messages
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((message) => {
          const role: ChatThreadDetail['messages'][number]['role'] =
            message.role === 'agent' || message.role === 'system' ? message.role : 'user';
          return {
            id: typeof message.id === 'string' ? message.id : `msg_${summary.id}`,
            threadId: typeof message.threadId === 'string' ? message.threadId : summary.id,
            role,
            body: typeof message.body === 'string' ? message.body : '',
            senderId: typeof message.senderId === 'string' ? message.senderId : null,
            senderName: typeof message.senderName === 'string' ? message.senderName : null,
            createdAt: typeof message.createdAt === 'string' ? message.createdAt : summary.createdAt,
            updatedAt: typeof message.updatedAt === 'string' ? message.updatedAt : summary.updatedAt,
            attachments: Array.isArray(message.attachments)
              ? message.attachments.filter(
                  (entry): entry is ChatAttachmentSummary =>
                    Boolean(entry) && typeof entry === 'object'
                )
              : [],
            metadata:
              message.metadata && typeof message.metadata === 'object'
                ? (message.metadata as Record<string, unknown>)
                : {},
          };
        })
    : [];
  const launches: ChatLaunchSummary[] = Array.isArray(row.launches)
    ? row.launches
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((launch) => {
          const executionMode: ChatLaunchSummary['executionMode'] =
            launch.executionMode === 'cloud' || launch.executionMode === 'hybrid'
              ? launch.executionMode
              : 'local_queue';
          const status: ChatLaunchSummary['status'] =
            launch.status === 'queued' ||
            launch.status === 'running' ||
            launch.status === 'blocked' ||
            launch.status === 'completed' ||
            launch.status === 'failed' ||
            launch.status === 'requested'
              ? launch.status
              : 'requested';

          return {
            id: typeof launch.id === 'string' ? launch.id : `launch_${summary.id}`,
            threadId: typeof launch.threadId === 'string' ? launch.threadId : summary.id,
            messageId: typeof launch.messageId === 'string' ? launch.messageId : '',
            assigneeId: typeof launch.assigneeId === 'string' ? launch.assigneeId : null,
            assigneeName: typeof launch.assigneeName === 'string' ? launch.assigneeName : null,
            watcherIds: Array.isArray(launch.watcherIds)
              ? launch.watcherIds.filter((entry): entry is string => typeof entry === 'string')
              : [],
            watcherNames: Array.isArray(launch.watcherNames)
              ? launch.watcherNames.filter((entry): entry is string => typeof entry === 'string')
              : [],
            executionMode,
            provider: typeof launch.provider === 'string' ? launch.provider : null,
            runId: typeof launch.runId === 'string' ? launch.runId : null,
            status,
            blockedReason: typeof launch.blockedReason === 'string' ? launch.blockedReason : null,
            warnings: Array.isArray(launch.warnings)
              ? launch.warnings.filter((entry): entry is string => typeof entry === 'string')
              : [],
            requestedAt: typeof launch.requestedAt === 'string' ? launch.requestedAt : summary.updatedAt,
            updatedAt: typeof launch.updatedAt === 'string' ? launch.updatedAt : summary.updatedAt,
            metadata:
              launch.metadata && typeof launch.metadata === 'object'
                ? (launch.metadata as Record<string, unknown>)
                : {},
          };
        })
    : [];
  return {
    ...summary,
    messages: messages.sort((a, b) => toEpoch(a.createdAt) - toEpoch(b.createdAt)),
    launches: launches.sort((a, b) => toEpoch(b.requestedAt) - toEpoch(a.requestedAt)),
  };
}

function threadMatchesTimeWindow(
  thread: ChatThreadSummary,
  timeFilterId: ActivityTimeFilterId,
  customTimeRange: { startIso: string | null; endIso: string | null }
): boolean {
  const threadEpoch = toEpoch(thread.lastActivityAt);
  if (!threadEpoch) return false;
  if (timeFilterId === 'custom') {
    const startEpoch = toEpoch(customTimeRange.startIso);
    const endEpoch = toEpoch(customTimeRange.endIso);
    if (startEpoch && threadEpoch < startEpoch) return false;
    if (endEpoch && threadEpoch > endEpoch) return false;
    return true;
  }
  const cutoff = cutoffEpochForActivityFilter(timeFilterId, Date.now());
  if (!cutoff) return true;
  return threadEpoch >= cutoff;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}> {
  try {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error:
          (payload && typeof payload.error === 'string' ? payload.error : null) ??
          `Request failed (${response.status})`,
      };
    }
    return {
      ok: true,
      status: response.status,
      data: payload as T,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

function upsertThread(threads: ChatThreadSummary[], next: ChatThreadSummary): ChatThreadSummary[] {
  const map = new Map<string, ChatThreadSummary>();
  for (const item of threads) map.set(item.id, item);
  map.set(next.id, next);
  return Array.from(map.values()).sort(
    (a, b) => toEpoch(b.lastActivityAt ?? b.updatedAt) - toEpoch(a.lastActivityAt ?? a.updatedAt)
  );
}

function mergeThreads(
  previous: ChatThreadSummary[],
  incoming: ChatThreadSummary[]
): ChatThreadSummary[] {
  const map = new Map<string, ChatThreadSummary>();
  for (const item of previous) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values()).sort(
    (a, b) => toEpoch(b.lastActivityAt ?? b.updatedAt) - toEpoch(a.lastActivityAt ?? a.updatedAt)
  );
}

export function ChatSurface({
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
}: ChatSurfaceProps) {
  const prefersReducedMotion = useReducedMotion();
  const [threads, setThreads] = useState<ChatThreadSummary[]>(snapshot?.threads ?? []);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string>('');
  const [selectedWatcherIds, setSelectedWatcherIds] = useState<string[]>([]);
  const [selectedInitiativeId, setSelectedInitiativeId] = useState<string>('');
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ChatThreadDetail | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [launchWarningOpen, setLaunchWarningOpen] = useState(false);
  const [launchWarningAccepted, setLaunchWarningAccepted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!snapshot?.threads) return;
    setThreads((previous) => mergeThreads(previous, snapshot.threads));
  }, [snapshot?.threads, snapshot?.updatedAt]);

  useEffect(() => {
    if (!activeThreadId) return;
    setThreads((previous) => previous.sort((a, b) => toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt)));
  }, [activeThreadId]);

  const agentOptions = useMemo<AgentOption[]>(() => {
    const map = new Map<string, AgentOption>();
    for (const session of sessions) {
      const id = (session.agentId ?? '').trim();
      const name = (session.agentName ?? '').trim();
      if (!id || !name) continue;
      if (!map.has(id)) {
        map.set(id, { id, name });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const initiativeOptions = useMemo(() => {
    return initiatives
      .map((initiative) => ({
        id: initiative.id,
        name: initiative.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [initiatives]);

  const selectedAssignee = useMemo(
    () => agentOptions.find((agent) => agent.id === selectedAssigneeId) ?? null,
    [agentOptions, selectedAssigneeId]
  );

  const selectedWatchers = useMemo(() => {
    const selected = new Set(selectedWatcherIds);
    return agentOptions.filter((agent) => selected.has(agent.id));
  }, [agentOptions, selectedWatcherIds]);

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
    if (filteredThreads.some((thread) => thread.id === activeThreadId)) return filteredThreads;
    const activeThreadSummary = threads.find((thread) => thread.id === activeThreadId);
    if (!activeThreadSummary) return filteredThreads;
    return [activeThreadSummary, ...filteredThreads];
  }, [activeThreadId, filteredThreads, threads]);

  const unresolvedAttachmentCount = useMemo(
    () => draftAttachments.filter((attachment) => attachment.status !== 'ready').length,
    [draftAttachments]
  );

  const draftTrimmed = draft.trim();
  const canSend = draftTrimmed.length > 0 && !sending;
  const canLaunch = canSend && !launching && Boolean(selectedAssignee);
  const composerGuidance = useMemo(() => {
    if (!selectedAssignee) return 'Choose a primary assignee to enable launch.';
    if (unresolvedAttachmentCount > 0) {
      return `${unresolvedAttachmentCount} attachment(s) still processing.`;
    }
    return 'Press Enter to send. Shift+Enter for a new line.';
  }, [selectedAssignee, unresolvedAttachmentCount]);

  const resetComposer = useCallback(() => {
    setDraft('');
    setDraftAttachments([]);
    setLaunchWarningOpen(false);
    setLaunchWarningAccepted(false);
    setComposerError(null);
    setComposerNotice(null);
  }, []);

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
      if (sourceEl) {
        activeCardRef.current = sourceEl;
      }
      setActiveThreadId(threadId);
      await loadThreadDetail(threadId);
      requestAnimationFrame(() => {
        panelHeadingRef.current?.focus();
      });
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

  const refreshAfterMutation = useCallback(async () => {
    if (typeof onRequestRefresh === 'function') {
      await onRequestRefresh();
    }
  }, [onRequestRefresh]);

  const queueAttachmentStatusProgress = useCallback((attachmentId: string) => {
    window.setTimeout(() => {
      setDraftAttachments((previous) =>
        previous.map((attachment) =>
          attachment.id === attachmentId
            ? {
                ...attachment,
                status: 'indexing',
                updatedAt: new Date().toISOString(),
              }
            : attachment
        )
      );
    }, 80);

    window.setTimeout(() => {
      setDraftAttachments((previous) =>
        previous.map((attachment) => {
          if (attachment.id !== attachmentId) return attachment;
          const unsupported =
            attachment.mimeType?.toLowerCase() === 'application/x-msdownload' ||
            attachment.name.toLowerCase().endsWith('.exe');
          const tooLarge = (attachment.sizeBytes ?? 0) > 25 * 1024 * 1024;
          if (unsupported) {
            return {
              ...attachment,
              status: 'failed',
              error: 'Unsupported file type.',
              updatedAt: new Date().toISOString(),
            };
          }
          if (tooLarge) {
            return {
              ...attachment,
              status: 'failed',
              error: 'File exceeds 25 MB extraction limit.',
              updatedAt: new Date().toISOString(),
            };
          }
          return {
            ...attachment,
            status: 'ready',
            error: null,
            updatedAt: new Date().toISOString(),
          };
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
      setDraftAttachments((previous) => previous.concat(next));
      next.forEach((attachment) => queueAttachmentStatusProgress(attachment.id));
      captureTelemetry('chat_attachment_state_changed', {
        count: next.length,
        state: 'preparing',
      });
    },
    [queueAttachmentStatusProgress]
  );

  const handleRetryAttachment = useCallback(
    (attachmentId: string) => {
      setDraftAttachments((previous) =>
        previous.map((attachment) =>
          attachment.id === attachmentId
            ? {
                ...attachment,
                status: 'preparing',
                error: null,
                updatedAt: new Date().toISOString(),
              }
            : attachment
        )
      );
      queueAttachmentStatusProgress(attachmentId);
      captureTelemetry('chat_attachment_state_changed', {
        state: 'retry',
      });
    },
    [queueAttachmentStatusProgress]
  );

  const selectedInitiative = useMemo(
    () => initiativeOptions.find((initiative) => initiative.id === selectedInitiativeId) ?? null,
    [initiativeOptions, selectedInitiativeId]
  );

  const guidanceTransport = useMemo(
    () =>
      new TextStreamChatTransport<UiChatMessage>({
        api: '/orgx/api/chat/usechat',
      }),
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
    const lastAssistant = [...guidanceMessages].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant) return null;
    const text = uiMessageToText(lastAssistant);
    return text.length > 0 ? text : null;
  }, [guidanceMessages]);

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
            watcherIds: selectedWatchers.map((watcher) => watcher.id),
            watcherNames: selectedWatchers.map((watcher) => watcher.name),
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
        watcherIds: selectedWatchers.map((watcher) => watcher.id),
        watcherNames: selectedWatchers.map((watcher) => watcher.name),
        body,
        attachments: draftAttachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          status: attachment.status,
          error: attachment.error,
          masked: attachment.masked,
        })),
      }),
    });
    setSending(false);

    if (!response.ok || !response.data?.thread) {
      setComposerError(humanizeApiError(response.error, 'send'));
      captureTelemetry('chat_message_send_failed', {
        reason: response.error ?? 'unknown',
      });
      return { thread: null, messageId: null };
    }

    const normalized = normalizeThreadSummary(response.data.thread);
    if (!normalized) {
      setComposerError('Send succeeded but thread payload was invalid.');
      return { thread: null, messageId: null };
    }
    setThreads((previous) => upsertThread(previous, normalized));
    setComposerNotice('Message sent. Assistant guidance is drafting...');
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
      setComposerError(
        humanizeApiError(error instanceof Error ? error.message : String(error ?? ''), 'send')
      );
    });
    resetComposer();
    setComposerExpanded(true);
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
    selectedWatchers,
    workspaceId,
  ]);

  const launchThread = useCallback(
    async (thread: ChatThreadSummary, messageId: string | null) => {
      if (!messageId) {
        setComposerError('Launch blocked: send a message first.');
        return;
      }
      if (!selectedAssignee) {
        setComposerError('Launch blocked: set a primary assignee.');
        return;
      }
      if (unresolvedAttachmentCount > 0 && !launchWarningAccepted) {
        setLaunchWarningOpen(true);
        setComposerError('Launch includes non-ready attachments. Confirm to continue.');
        return;
      }

      setLaunching(true);
      setComposerError(null);
      setComposerNotice(null);

      const launchStart = await fetchJson<{
        ok?: boolean;
        sessionId?: string;
        runId?: string;
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
          watcherIds: selectedWatchers.map((watcher) => watcher.id),
          watcherNames: selectedWatchers.map((watcher) => watcher.name),
          executionMode: 'local_queue',
          provider: 'openclaw',
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
      if (nextThread) {
        setThreads((previous) => upsertThread(previous, nextThread));
      }
      await loadThreadDetail(thread.id);
      await refreshAfterMutation();

      if (!launchStart.ok) {
        setComposerError(
          `Launch blocked: ${blockedReason ?? 'Set assignee and retry.'}`
        );
        captureTelemetry('chat_launch_blocked', {
          threadId: thread.id,
          reason: blockedReason ?? 'unknown',
        });
        return;
      }

      setComposerNotice(
        runId
          ? 'Launch started. Thread timeline now tracks execution state.'
          : 'Launch queued locally. Run starts when a worker is available.'
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
      selectedWatchers,
      unresolvedAttachmentCount,
    ]
  );

  const handleSendOnly = useCallback(async () => {
    const result = await sendMessage();
    if (result.thread && result.thread.id) {
      await openThreadPanel(result.thread.id);
    }
  }, [openThreadPanel, sendMessage]);

  const handleSendAndLaunch = useCallback(async () => {
    const result = await sendMessage();
    if (!result.thread) return;
    await launchThread(result.thread, result.messageId);
    await openThreadPanel(result.thread.id);
  }, [launchThread, openThreadPanel, sendMessage]);

  const applyScopeLink = useCallback(
    async (threadId: string, initiativeId: string | null) => {
      setScopeSaving(true);
      const initiative = initiativeOptions.find((entry) => entry.id === initiativeId) ?? null;
      const response = await fetchJson<{
        ok?: boolean;
        thread?: unknown;
        error?: string;
      }>('/orgx/api/chat/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          project_id: workspaceId ?? undefined,
          initiativeId: initiative?.id ?? null,
          initiativeTitle: initiative?.name ?? null,
          relinked: true,
        }),
      });
      setScopeSaving(false);
      if (!response.ok || !response.data?.thread) {
        setPanelError(response.error ?? 'Scope link failed.');
        return;
      }
      const updated = normalizeThreadSummary(response.data.thread);
      if (updated) {
        setThreads((previous) => upsertThread(previous, updated));
      }
      await loadThreadDetail(threadId);
      await refreshAfterMutation();
      captureTelemetry('chat_thread_linked_initiative', {
        threadId,
        initiativeId: initiative?.id ?? null,
      });
    },
    [initiativeOptions, loadThreadDetail, refreshAfterMutation, workspaceId]
  );

  const activeThreadSummary = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  const activePanelThreadId = activeThread?.id ?? activeThreadSummary?.id ?? null;

  return (
    <section
      aria-label="Chat threads"
      data-testid="chat-surface"
      className="rounded-xl border border-subtle bg-white/[0.02] p-3 sm:p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-body font-semibold text-primary">Chat Threads</h3>
          <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
            {displayedThreads.length}
          </span>
        </div>
        {snapshot?.updatedAt && (
          <time className="text-micro text-muted" dateTime={snapshot.updatedAt}>
            Updated {formatRelativeTime(snapshot.updatedAt)}
          </time>
        )}
      </header>

      <motion.section
        data-testid="chat-composer"
        data-state={composerExpanded ? 'expanded' : 'collapsed'}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
        animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
        transition={
          prefersReducedMotion
            ? undefined
            : {
                duration: motionTokens.durationStandard / 1000,
                ease: motionTokens.easingStandard as unknown as number[],
              }
        }
        className={cn(
          'rounded-xl border bg-[#090D15]/90 px-3 py-3 backdrop-blur',
          composerExpanded ? 'border-lime/35 shadow-[0_0_0_1px_rgba(191,255,0,0.08)]' : 'border-white/[0.12]'
        )}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-micro uppercase tracking-[0.08em] text-muted">New message</p>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-micro',
                canLaunch
                  ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                  : 'border-white/[0.16] bg-white/[0.05] text-secondary'
              )}
            >
              {canLaunch ? 'Launch ready' : 'Draft'}
            </span>
          </div>

          <label htmlFor="chat-composer-input" className="sr-only">
            Chat composer
          </label>
          <textarea
            id="chat-composer-input"
            value={draft}
            onFocus={() => setComposerExpanded(true)}
            onChange={(event) => {
              setDraft(event.target.value);
              if (!composerExpanded) setComposerExpanded(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSendOnly();
              }
            }}
            placeholder="Message an assignee, set scope, and launch when ready."
            rows={composerExpanded ? 4 : 1}
            className={cn(
              'w-full resize-none rounded-xl border border-white/[0.14] bg-[#05080F] px-3 py-2.5 text-body text-primary placeholder:text-muted',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-lime/35',
              !composerExpanded && 'h-[48px]'
            )}
            aria-expanded={composerExpanded}
          />

          <AnimatePresence initial={false}>
            {composerExpanded && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: -6 }}
                animate={prefersReducedMotion ? {} : { opacity: 1, y: 0 }}
                exit={prefersReducedMotion ? {} : { opacity: 0, y: -4 }}
                transition={
                  prefersReducedMotion
                    ? undefined
                    : {
                        duration: motionTokens.durationFast / 1000,
                        ease: motionTokens.easingStandard as unknown as number[],
                      }
                }
                className="space-y-3"
              >
                {draftTrimmed.length === 0 && (
                  <div className="flex flex-wrap gap-1.5" aria-label="Quick start prompts">
                    {QUICK_START_PROMPTS.map((prompt) => (
                      <motion.button
                        key={prompt}
                        type="button"
                        whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                        whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                        transition={CONTROL_SPRING}
                        onClick={() => {
                          setDraft(prompt);
                          requestAnimationFrame(() => {
                            const composer = document.getElementById('chat-composer-input');
                            if (composer instanceof HTMLTextAreaElement) composer.focus();
                          });
                        }}
                        className="inline-flex min-h-[32px] items-center rounded-full border border-white/[0.14] bg-white/[0.03] px-2.5 text-micro text-secondary hover:border-white/[0.24] hover:bg-white/[0.08] hover:text-primary"
                      >
                        {prompt}
                      </motion.button>
                    ))}
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.02] px-2.5 py-1.5 text-caption text-secondary">
                    <span className="whitespace-nowrap text-micro uppercase tracking-[0.08em] text-muted">
                      Assignee
                    </span>
                    <select
                      value={selectedAssigneeId}
                      onChange={(event) => setSelectedAssigneeId(event.target.value)}
                      className="min-h-[32px] w-full rounded-md border border-transparent bg-transparent text-caption text-primary outline-none focus:border-lime/30"
                      aria-label="Primary assignee"
                    >
                      <option value="">Select</option>
                      {agentOptions.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.02] px-2.5 py-1.5 text-caption text-secondary">
                    <span className="whitespace-nowrap text-micro uppercase tracking-[0.08em] text-muted">
                      Scope
                    </span>
                    <select
                      value={selectedInitiativeId}
                      onChange={(event) => setSelectedInitiativeId(event.target.value)}
                      className="min-h-[32px] w-full rounded-md border border-transparent bg-transparent text-caption text-primary outline-none focus:border-lime/30"
                      aria-label="Initiative scope"
                    >
                      <option value="">Unscoped</option>
                      {initiativeOptions.map((initiative) => (
                        <option key={initiative.id} value={initiative.id}>
                          {initiative.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.02] px-2.5 py-1.5 text-caption text-secondary">
                    <span className="whitespace-nowrap text-micro uppercase tracking-[0.08em] text-muted">
                      Watchers
                    </span>
                    <select
                      value=""
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value) return;
                        setSelectedWatcherIds((previous) =>
                          previous.includes(value) ? previous : previous.concat(value)
                        );
                      }}
                      className="min-h-[32px] w-full rounded-md border border-transparent bg-transparent text-caption text-primary outline-none focus:border-lime/30"
                      aria-label="Add watcher"
                    >
                      <option value="">Add watcher</option>
                      {agentOptions
                        .filter((agent) => !selectedWatcherIds.includes(agent.id))
                        .map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>

                {selectedWatchers.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {selectedWatchers.map((watcher) => (
                      <motion.button
                        key={watcher.id}
                        type="button"
                        whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                        whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                        transition={CONTROL_SPRING}
                        onClick={() =>
                          setSelectedWatcherIds((previous) =>
                            previous.filter((entry) => entry !== watcher.id)
                          )
                        }
                        className="inline-flex min-h-[30px] items-center gap-1 rounded-full border border-white/[0.16] bg-white/[0.04] px-2 py-0.5 text-micro text-secondary hover:bg-white/[0.1] hover:text-primary"
                        aria-label={`Remove watcher ${watcher.name}`}
                      >
                        @{watcher.name}
                        <span aria-hidden>×</span>
                      </motion.button>
                    ))}
                  </div>
                )}

                {draftAttachments.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                    {draftAttachments.map((attachment) => (
                      <div
                        key={attachment.id}
                        className={cn(
                          'inline-flex min-h-[30px] items-center gap-1 rounded-full border px-2 py-0.5 text-micro',
                          attachment.status === 'ready'
                            ? 'border-teal/25 bg-teal/[0.1] text-teal-100'
                            : attachment.status === 'failed'
                              ? 'border-rose-400/30 bg-rose-400/[0.12] text-rose-100'
                              : 'border-white/[0.14] bg-white/[0.04] text-secondary'
                        )}
                      >
                        <span className="max-w-[160px] truncate">{attachment.name}</span>
                        <span className="text-[10px] text-muted">{attachmentReadableSize(attachment.sizeBytes)}</span>
                        <span className="text-[10px] uppercase tracking-[0.08em]">{attachment.status}</span>
                        {attachment.status === 'failed' ? (
                          <button
                            type="button"
                            onClick={() => handleRetryAttachment(attachment.id)}
                            className="rounded-full border border-white/[0.2] bg-white/[0.05] px-1.5 py-0 text-[10px] hover:bg-white/[0.1]"
                          >
                            Retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            setDraftAttachments((previous) =>
                              previous.filter((entry) => entry.id !== attachment.id)
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
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] pt-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        handleFilesAdded(event.target.files);
                        event.currentTarget.value = '';
                      }}
                    />
                    <motion.button
                      type="button"
                      whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                      whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                      transition={CONTROL_SPRING}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex min-h-[36px] items-center gap-1 rounded-full border border-white/[0.14] bg-white/[0.04] px-2.5 text-caption font-medium text-secondary hover:bg-white/[0.08] hover:text-primary"
                    >
                      Attach
                    </motion.button>
                    <span className="text-micro text-muted">
                      {unresolvedAttachmentCount > 0
                        ? `${unresolvedAttachmentCount} attachment(s) not ready`
                        : 'Attachments ready'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <motion.button
                      type="button"
                      whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                      whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                      transition={CONTROL_SPRING}
                      onClick={() => setComposerExpanded(false)}
                      className="inline-flex min-h-[36px] items-center rounded-full border border-white/[0.12] bg-white/[0.03] px-3 text-caption font-medium text-secondary hover:bg-white/[0.08] hover:text-primary"
                    >
                      Collapse
                    </motion.button>
                    <motion.button
                      type="button"
                      whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                      whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                      transition={CONTROL_SPRING}
                      onClick={() => void handleSendOnly()}
                      disabled={!canSend}
                      data-action="chat-send"
                      className="inline-flex min-h-[36px] items-center rounded-full border border-white/[0.2] bg-white/[0.06] px-3 text-caption font-semibold text-primary hover:bg-white/[0.1] disabled:opacity-45"
                    >
                      {sending ? 'Sending…' : 'Send'}
                    </motion.button>
                    <motion.button
                      type="button"
                      whileHover={prefersReducedMotion ? undefined : { y: -1 }}
                      whileTap={prefersReducedMotion ? undefined : CONTROL_TAP}
                      transition={CONTROL_SPRING}
                      onClick={() => void handleSendAndLaunch()}
                      disabled={!canLaunch}
                      data-action="chat-send-launch"
                      className="inline-flex min-h-[36px] items-center rounded-full border border-lime/30 bg-lime/[0.14] px-3 text-caption font-semibold text-[#E1FFB2] hover:bg-lime/[0.2] disabled:opacity-45"
                      aria-describedby={!selectedAssignee ? 'chat-launch-requirements' : undefined}
                    >
                      {launching ? 'Launching…' : 'Launch'}
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.section>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro">
        <p id="chat-launch-requirements" className="text-muted">
          Launch requires a persisted message and a primary assignee.
        </p>
        <span aria-hidden className="text-muted">
          ·
        </span>
        <p className="text-secondary">{composerGuidance}</p>
      </div>
      {composerError && (
        <p className="mt-1.5 rounded-md border border-rose-400/30 bg-rose-400/[0.12] px-2.5 py-1.5 text-caption text-rose-100">
          {composerError}
        </p>
      )}
      {composerNotice && (
        <p className="mt-1.5 rounded-md border border-lime/30 bg-lime/[0.1] px-2.5 py-1.5 text-caption text-[#E1FFB2]">
          {composerNotice}
        </p>
      )}
      {(guidanceStatus === 'submitted' || guidanceStatus === 'streaming') && (
        <p className="mt-1.5 rounded-md border border-cyan-300/28 bg-cyan-500/[0.1] px-2.5 py-1.5 text-caption text-cyan-100">
          Assistant is drafting guidance...
        </p>
      )}
      {guidancePreview && (
        <p className="mt-1.5 rounded-md border border-teal/28 bg-teal/[0.1] px-2.5 py-1.5 text-caption text-teal-100">
          {guidancePreview}
        </p>
      )}
      {guidanceError && (
        <p className="mt-1.5 rounded-md border border-rose-400/30 bg-rose-400/[0.12] px-2.5 py-1.5 text-caption text-rose-100">
          {humanizeApiError(guidanceError.message, 'send')}
        </p>
      )}
      {launchWarningOpen && (
        <div className="mt-1.5 rounded-md border border-amber-300/35 bg-amber-300/[0.12] px-2.5 py-2 text-caption text-amber-100">
          <p>Launch includes non-ready attachments. Continue anyway?</p>
          <label className="mt-1.5 flex items-center gap-2">
            <input
              type="checkbox"
              checked={launchWarningAccepted}
              onChange={(event) => setLaunchWarningAccepted(event.target.checked)}
            />
            <span>I understand unresolved attachment extraction may reduce context quality.</span>
          </label>
        </div>
      )}

      <div
        className={cn(
          'mt-3 grid gap-2 lg:gap-3',
          activeThreadId && 'lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]'
        )}
      >
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
                  setComposerExpanded(true);
                  requestAnimationFrame(() => {
                    const composer = document.getElementById('chat-composer-input');
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
