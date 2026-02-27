import { cutoffEpochForActivityFilter, type ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { humanizeWarning, sanitizeDisplayText } from '@/lib/humanize';
import type {
  ChatAttachmentSummary,
  ChatLaunchSummary,
  ChatThreadSummary,
  Initiative,
  SessionTreeNode,
} from '@/types';
import type { UIMessage } from 'ai';

// ── Types ────────────────────────────────────────────────────────

export type StatusFilterId = 'all' | 'completed' | 'needs_attention' | 'in_progress';
export type SortOrder = 'newest' | 'oldest';

export type ChatThreadDetail = Omit<ChatThreadSummary, 'latestMessage' | 'latestLaunch'> & {
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

export type DraftAttachment = {
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

export type AgentOption = {
  id: string;
  name: string;
  handle: string;
  domain: string;
  domainLabel: string;
  role: string;
  status: 'running' | 'idle' | 'blocked' | 'offline';
  currentTask: string | null;
  isSystem: boolean;
};

export const SYSTEM_AGENT_IDS = new Set([
  'orgx-orchestrator',
  'xandy',
  'dispatcher',
  'router-all-agents',
]);

export type CanonicalAgentDef = {
  id: string;
  name: string;
  handle: string;
  domain: string;
  domainLabel: string;
  role: string;
};

export const CANONICAL_AGENTS: CanonicalAgentDef[] = [
  { id: 'eli', name: 'Eli', handle: 'eli', domain: 'engineering', domainLabel: 'Engineering', role: 'Engineering' },
  { id: 'dana', name: 'Dana', handle: 'dana', domain: 'design', domainLabel: 'Product Design', role: 'Product Design' },
  { id: 'mark', name: 'Mark', handle: 'mark', domain: 'marketing', domainLabel: 'Marketing', role: 'Marketing' },
  { id: 'sage', name: 'Sage', handle: 'sage', domain: 'sales', domainLabel: 'Sales', role: 'Sales' },
  { id: 'orion', name: 'Orion', handle: 'orion', domain: 'operations', domainLabel: 'Operations', role: 'Operations' },
  { id: 'pace', name: 'Pace', handle: 'pace', domain: 'product', domainLabel: 'Product', role: 'Product' },
];

export type UiChatMessage = UIMessage<{
  threadId?: string;
  messageId?: string;
  source?: string;
}>;

export type ComposerMode =
  | 'resting'
  | 'focused'
  | 'composing'
  | 'targeting'
  | 'scoping'
  | 'reviewing';

export type InlineMessage = {
  id: string;
  role: 'user' | 'agent' | 'system' | 'error';
  body: string;
  timestamp: string;
};

export type ChatProviderId = 'auto' | 'anthropic' | 'openai';

export type ChatProviderDef = {
  id: ChatProviderId;
  label: string;
  shortLabel: string;
  accent: string;
  icon: 'anthropic' | 'openai' | 'auto';
};

export const CHAT_PROVIDERS: ChatProviderDef[] = [
  { id: 'auto', label: 'Auto (best available)', shortLabel: 'Auto', accent: '#8F9AB7', icon: 'auto' },
  { id: 'anthropic', label: 'Claude Code', shortLabel: 'Claude', accent: '#F5B700', icon: 'anthropic' },
  { id: 'openai', label: 'Codex', shortLabel: 'Codex', accent: '#10B981', icon: 'openai' },
];

// ── Constants ────────────────────────────────────────────────────

export const QUICK_START_PROMPTS = [
  'Draft an implementation plan for this initiative.',
  'Summarize blockers from Activity and propose next actions.',
  'Prepare a ready-to-send update for stakeholders.',
] as const;

export const CONTROL_SPRING = { type: 'spring' as const, stiffness: 400, damping: 25 };
export const CONTROL_TAP = { scale: 0.985 };

// ── Functions ────────────────────────────────────────────────────

export function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function attachmentReadableSize(bytes: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function humanizeApiError(error: string | null, action: 'send' | 'launch' | 'load'): string {
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
  return sanitizeDisplayText(humanizeWarning(error ?? 'Request failed.'));
}

export function summarizeThreadForSearch(thread: ChatThreadSummary): string {
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

export function statusMatchesFilter(thread: ChatThreadSummary, filter: StatusFilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'completed') return thread.status === 'completed';
  if (filter === 'in_progress') return thread.status === 'queued' || thread.status === 'running';
  if (filter === 'needs_attention') return thread.status === 'blocked' || thread.status === 'failed';
  return true;
}

export function statusLabel(status: ChatThreadSummary['status']): string {
  if (status === 'message_only') return 'Message sent';
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'blocked') return 'Blocked';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return status;
}

export function statusClasses(status: ChatThreadSummary['status']): string {
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

export function roleBadge(role: 'user' | 'agent' | 'system'): string {
  if (role === 'user') return 'You';
  if (role === 'agent') return 'Agent';
  return 'System';
}

export function threadRoleToUiRole(role: 'user' | 'agent' | 'system'): UiChatMessage['role'] {
  if (role === 'agent') return 'assistant';
  return role;
}

export function uiMessageToText(message: UiChatMessage): string {
  return message.parts
    .filter((part): part is Extract<UiChatMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

export function toUiMessagesFromThreadMessages(
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

export function inferThreadStatusFromLaunch(status: ChatLaunchSummary['status']): ChatThreadSummary['status'] {
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

export function normalizeThreadSummary(input: unknown): ChatThreadSummary | null {
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

export function normalizeThreadDetail(input: unknown): ChatThreadDetail | null {
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

export function threadMatchesTimeWindow(
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

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<{
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

export function upsertThread(threads: ChatThreadSummary[], next: ChatThreadSummary): ChatThreadSummary[] {
  const map = new Map<string, ChatThreadSummary>();
  for (const item of threads) map.set(item.id, item);
  map.set(next.id, next);
  return Array.from(map.values()).sort(
    (a, b) => toEpoch(b.lastActivityAt ?? b.updatedAt) - toEpoch(a.lastActivityAt ?? a.updatedAt)
  );
}

export function mergeThreads(
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
