import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";
import { ensureStoreDirSync, parseJsonSafe } from "./stores/json-store.js";

export type ChatAttachmentState = "preparing" | "indexing" | "ready" | "failed";
export type ChatMessageRole = "user" | "agent" | "system";
export type ChatLaunchStatus =
  | "requested"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed";
export type ChatThreadStatus =
  | "message_only"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type ChatAttachmentRecord = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: ChatAttachmentState;
  error: string | null;
  masked: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessageRecord = {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  body: string;
  senderId: string | null;
  senderName: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: ChatAttachmentRecord[];
  metadata: Record<string, unknown>;
};

export type ChatLaunchAttemptRecord = {
  id: string;
  threadId: string;
  messageId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  watcherIds: string[];
  watcherNames: string[];
  executionMode: "local_queue" | "cloud" | "hybrid";
  provider: string | null;
  runId: string | null;
  status: ChatLaunchStatus;
  blockedReason: string | null;
  warnings: string[];
  requestedAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

export type ChatThreadRecord = {
  id: string;
  commandCenterId: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  title: string;
  summary: string | null;
  status: ChatThreadStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  watcherIds: string[];
  watcherNames: string[];
  messageCount: number;
  launchCount: number;
  lastMessageAt: string | null;
  lastLaunchAt: string | null;
  lastActivityAt: string;
  lastSnippet: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageRecord[];
  launches: ChatLaunchAttemptRecord[];
  metadata: Record<string, unknown>;
};

export type ChatThreadSummary = Omit<ChatThreadRecord, "messages" | "launches"> & {
  latestMessage: ChatMessageRecord | null;
  latestLaunch: ChatLaunchAttemptRecord | null;
};

type PersistedChatStore = {
  version: 1;
  updatedAt: string;
  threads: ChatThreadRecord[];
};

const STORE_VERSION = 1 as const;
const STORE_FILENAME = "chat-store.json";
const MAX_THREADS = 400;
const MAX_MESSAGES_PER_THREAD = 200;
const MAX_LAUNCHES_PER_THREAD = 120;

function storeDir(): string {
  return getOrgxPluginConfigDir();
}

function storePath(): string {
  return getOrgxPluginConfigPath(STORE_FILENAME);
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 137)}...`;
}

function titleFromBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 64) return compact || "New thread";
  return `${compact.slice(0, 61)}...`;
}

function threadStatusFromLaunch(status: ChatLaunchStatus): ChatThreadStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "message_only";
}

function normalizeAttachment(
  threadId: string,
  value: Partial<ChatAttachmentRecord> & { name?: string | null }
): ChatAttachmentRecord | null {
  const name = normalizeString(value.name);
  if (!name) return null;
  const now = new Date().toISOString();
  const sizeBytes =
    typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0
      ? Math.floor(value.sizeBytes)
      : null;
  const mimeType = normalizeString(value.mimeType);
  const status: ChatAttachmentState =
    value.status === "preparing" ||
    value.status === "indexing" ||
    value.status === "ready" ||
    value.status === "failed"
      ? value.status
      : "ready";
  const error = normalizeString(value.error);
  const createdAt = normalizeString(value.createdAt) ?? now;
  const updatedAt = normalizeString(value.updatedAt) ?? now;
  const id = normalizeString(value.id) ?? `att_${randomUUID()}`;
  void threadId;
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    status,
    error,
    masked: value.masked === true,
    createdAt,
    updatedAt,
  };
}

type NormalizeMessageInput = {
  id?: string;
  threadId?: string;
  role?: ChatMessageRole;
  body?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  attachments?: Array<Partial<ChatAttachmentRecord> & { name?: string | null }>;
  metadata?: Record<string, unknown>;
};

function normalizeMessage(threadId: string, value: NormalizeMessageInput): ChatMessageRecord | null {
  const body = normalizeString(value.body);
  if (!body) return null;
  const now = new Date().toISOString();
  const role: ChatMessageRole =
    value.role === "agent" || value.role === "system" ? value.role : "user";
  const attachmentsInput = Array.isArray(value.attachments) ? value.attachments : [];
  const attachments = attachmentsInput
    .map((entry) =>
      normalizeAttachment(threadId, (entry ?? {}) as Partial<ChatAttachmentRecord> & { name?: string | null })
    )
    .filter((entry): entry is ChatAttachmentRecord => Boolean(entry));
  return {
    id: normalizeString(value.id) ?? `msg_${randomUUID()}`,
    threadId,
    role,
    body,
    senderId: normalizeString(value.senderId),
    senderName: normalizeString(value.senderName),
    createdAt: normalizeString(value.createdAt) ?? now,
    updatedAt: normalizeString(value.updatedAt) ?? now,
    attachments,
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : {},
  };
}

function normalizeLaunch(threadId: string, value: Partial<ChatLaunchAttemptRecord>): ChatLaunchAttemptRecord | null {
  const messageId = normalizeString(value.messageId);
  if (!messageId) return null;
  const now = new Date().toISOString();
  const executionMode =
    value.executionMode === "cloud" || value.executionMode === "hybrid"
      ? value.executionMode
      : "local_queue";
  const status: ChatLaunchStatus =
    value.status === "queued" ||
    value.status === "running" ||
    value.status === "blocked" ||
    value.status === "completed" ||
    value.status === "failed" ||
    value.status === "requested"
      ? value.status
      : "requested";
  return {
    id: normalizeString(value.id) ?? `launch_${randomUUID()}`,
    threadId,
    messageId,
    assigneeId: normalizeString(value.assigneeId),
    assigneeName: normalizeString(value.assigneeName),
    watcherIds: dedupeStrings(value.watcherIds),
    watcherNames: dedupeStrings(value.watcherNames),
    executionMode,
    provider: normalizeString(value.provider),
    runId: normalizeString(value.runId),
    status,
    blockedReason: normalizeString(value.blockedReason),
    warnings: dedupeStrings(value.warnings),
    requestedAt: normalizeString(value.requestedAt) ?? now,
    updatedAt: normalizeString(value.updatedAt) ?? now,
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : {},
  };
}

function normalizeThread(value: Partial<ChatThreadRecord>): ChatThreadRecord | null {
  const id = normalizeString(value.id);
  if (!id) return null;
  const now = new Date().toISOString();
  const messagesInput = Array.isArray(value.messages) ? value.messages : [];
  const launchesInput = Array.isArray(value.launches) ? value.launches : [];
  const messages = messagesInput
    .map((entry) => normalizeMessage(id, entry ?? {}))
    .filter((entry): entry is ChatMessageRecord => Boolean(entry))
    .sort((a, b) => toEpoch(a.createdAt) - toEpoch(b.createdAt))
    .slice(-MAX_MESSAGES_PER_THREAD);
  const launches = launchesInput
    .map((entry) => normalizeLaunch(id, entry ?? {}))
    .filter((entry): entry is ChatLaunchAttemptRecord => Boolean(entry))
    .sort((a, b) => toEpoch(b.requestedAt) - toEpoch(a.requestedAt))
    .slice(0, MAX_LAUNCHES_PER_THREAD);
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const latestLaunch = launches.length > 0 ? launches[0] : null;
  const lastMessageAt = normalizeString(value.lastMessageAt) ?? latestMessage?.createdAt ?? null;
  const lastLaunchAt = normalizeString(value.lastLaunchAt) ?? latestLaunch?.requestedAt ?? null;
  const lastActivityAt =
    normalizeString(value.lastActivityAt) ??
    (toEpoch(lastLaunchAt) > toEpoch(lastMessageAt) ? (lastLaunchAt as string | null) : lastMessageAt) ??
    now;
  const title = normalizeString(value.title) ?? titleFromBody(latestMessage?.body ?? "");
  const summary = normalizeString(value.summary);
  const status: ChatThreadStatus =
    value.status === "queued" ||
    value.status === "running" ||
    value.status === "blocked" ||
    value.status === "completed" ||
    value.status === "failed"
      ? value.status
      : latestLaunch
        ? threadStatusFromLaunch(latestLaunch.status)
        : "message_only";

  return {
    id,
    commandCenterId: normalizeString(value.commandCenterId),
    initiativeId: normalizeString(value.initiativeId),
    initiativeTitle: normalizeString(value.initiativeTitle),
    workstreamId: normalizeString(value.workstreamId),
    taskId: normalizeString(value.taskId),
    title,
    summary,
    status,
    assigneeId: normalizeString(value.assigneeId) ?? latestLaunch?.assigneeId ?? null,
    assigneeName: normalizeString(value.assigneeName) ?? latestLaunch?.assigneeName ?? null,
    watcherIds: dedupeStrings(value.watcherIds),
    watcherNames: dedupeStrings(value.watcherNames),
    messageCount:
      typeof value.messageCount === "number" && Number.isFinite(value.messageCount)
        ? Math.max(messages.length, Math.floor(value.messageCount))
        : messages.length,
    launchCount:
      typeof value.launchCount === "number" && Number.isFinite(value.launchCount)
        ? Math.max(launches.length, Math.floor(value.launchCount))
        : launches.length,
    lastMessageAt,
    lastLaunchAt,
    lastActivityAt,
    lastSnippet: normalizeString(value.lastSnippet) ?? summarizeBody(latestMessage?.body ?? ""),
    createdAt: normalizeString(value.createdAt) ?? now,
    updatedAt: normalizeString(value.updatedAt) ?? now,
    messages,
    launches,
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : {},
  };
}

function ensureDir(): void {
  ensureStoreDirSync(storeDir());
}

function readPersistedStore(): PersistedChatStore {
  ensureDir();
  const file = storePath();
  if (!existsSync(file)) {
    return { version: STORE_VERSION, updatedAt: new Date().toISOString(), threads: [] };
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedChatStore>(raw);
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.threads)) {
      backupCorruptFileSync(file);
      return { version: STORE_VERSION, updatedAt: new Date().toISOString(), threads: [] };
    }
    const threads = parsed.threads
      .map((entry) => normalizeThread(entry ?? {}))
      .filter((entry): entry is ChatThreadRecord => Boolean(entry))
      .sort((a, b) => toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt))
      .slice(0, MAX_THREADS);
    return {
      version: STORE_VERSION,
      updatedAt: normalizeString(parsed.updatedAt) ?? new Date().toISOString(),
      threads,
    };
  } catch {
    return { version: STORE_VERSION, updatedAt: new Date().toISOString(), threads: [] };
  }
}

function writePersistedStore(store: PersistedChatStore): void {
  ensureDir();
  const normalizedThreads = store.threads
    .map((entry) => normalizeThread(entry))
    .filter((entry): entry is ChatThreadRecord => Boolean(entry))
    .sort((a, b) => toEpoch(b.lastActivityAt) - toEpoch(a.lastActivityAt))
    .slice(0, MAX_THREADS);
  writeJsonFileAtomicSync(
    storePath(),
    {
      version: STORE_VERSION,
      updatedAt: normalizeString(store.updatedAt) ?? new Date().toISOString(),
      threads: normalizedThreads,
    },
    0o600
  );
}

function toSummary(thread: ChatThreadRecord): ChatThreadSummary {
  return {
    ...thread,
    latestMessage: thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null,
    latestLaunch: thread.launches.length > 0 ? thread.launches[0] : null,
  };
}

export function listChatThreads(input?: {
  commandCenterId?: string | null;
  initiativeId?: string | null;
  query?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}): { threads: ChatThreadSummary[]; total: number; updatedAt: string } {
  const store = readPersistedStore();
  const commandCenterId = normalizeString(input?.commandCenterId);
  const initiativeId = normalizeString(input?.initiativeId);
  const query = normalizeString(input?.query)?.toLowerCase() ?? null;
  const status = normalizeString(input?.status)?.toLowerCase() ?? null;
  const limit = Math.max(1, Math.min(200, Math.floor(input?.limit ?? 60)));
  const offset = Math.max(0, Math.floor(input?.offset ?? 0));

  const filtered = store.threads.filter((thread) => {
    if (commandCenterId && thread.commandCenterId !== commandCenterId) return false;
    if (initiativeId && thread.initiativeId !== initiativeId) return false;
    if (status && thread.status.toLowerCase() !== status) return false;
    if (!query) return true;

    const haystack = [
      thread.title,
      thread.summary ?? "",
      thread.lastSnippet ?? "",
      thread.assigneeName ?? "",
      thread.initiativeTitle ?? "",
      ...thread.watcherNames,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  return {
    threads: filtered.slice(offset, offset + limit).map(toSummary),
    total: filtered.length,
    updatedAt: store.updatedAt,
  };
}

export function getChatThread(threadId: string): ChatThreadRecord | null {
  const id = normalizeString(threadId);
  if (!id) return null;
  const store = readPersistedStore();
  return store.threads.find((thread) => thread.id === id) ?? null;
}

export function sendChatMessage(input: {
  threadId?: string | null;
  commandCenterId?: string | null;
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  taskId?: string | null;
  title?: string | null;
  body: string;
  role?: ChatMessageRole;
  senderId?: string | null;
  senderName?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  watcherIds?: string[];
  watcherNames?: string[];
  attachments?: Array<Partial<ChatAttachmentRecord> & { name?: string | null }>;
  metadata?: Record<string, unknown>;
}): {
  thread: ChatThreadRecord;
  message: ChatMessageRecord;
  createdThread: boolean;
  updatedAt: string;
} {
  const body = normalizeString(input.body);
  if (!body) {
    throw new Error("message body is required");
  }
  const role: ChatMessageRole =
    input.role === "agent" || input.role === "system" ? input.role : "user";
  const now = new Date().toISOString();
  const store = readPersistedStore();

  let thread: ChatThreadRecord | null = null;
  const threadId = normalizeString(input.threadId);
  if (threadId) {
    thread = store.threads.find((entry) => entry.id === threadId) ?? null;
  }

  const createdThread = !thread;
  if (!thread) {
    const id = `thread_${randomUUID()}`;
    thread = {
      id,
      commandCenterId: normalizeString(input.commandCenterId),
      initiativeId: normalizeString(input.initiativeId),
      initiativeTitle: normalizeString(input.initiativeTitle),
      workstreamId: normalizeString(input.workstreamId),
      taskId: normalizeString(input.taskId),
      title: normalizeString(input.title) ?? titleFromBody(body),
      summary: summarizeBody(body),
      status: "message_only",
      assigneeId: normalizeString(input.assigneeId),
      assigneeName: normalizeString(input.assigneeName),
      watcherIds: dedupeStrings(input.watcherIds),
      watcherNames: dedupeStrings(input.watcherNames),
      messageCount: 0,
      launchCount: 0,
      lastMessageAt: null,
      lastLaunchAt: null,
      lastActivityAt: now,
      lastSnippet: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
      launches: [],
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    };
    store.threads.unshift(thread);
  }

  const message = normalizeMessage(thread.id, {
    id: `msg_${randomUUID()}`,
    threadId: thread.id,
    role,
    body,
    senderId: normalizeString(input.senderId),
    senderName: normalizeString(input.senderName),
    createdAt: now,
    updatedAt: now,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  });
  if (!message) {
    throw new Error("failed to normalize chat message");
  }

  thread.messages.push(message);
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  thread.messageCount = Math.max(thread.messageCount + 1, thread.messages.length);
  thread.lastMessageAt = now;
  thread.lastActivityAt = now;
  if (role === "user") {
    thread.lastSnippet = summarizeBody(body);
    thread.summary = summarizeBody(body);
    thread.status = "message_only";
  } else if (!thread.lastSnippet) {
    thread.lastSnippet = summarizeBody(body);
  }
  thread.updatedAt = now;
  thread.assigneeId = normalizeString(input.assigneeId) ?? thread.assigneeId;
  thread.assigneeName = normalizeString(input.assigneeName) ?? thread.assigneeName;
  thread.watcherIds = dedupeStrings([...(thread.watcherIds ?? []), ...(input.watcherIds ?? [])]);
  thread.watcherNames = dedupeStrings([...(thread.watcherNames ?? []), ...(input.watcherNames ?? [])]);
  if (role === "user" && (!thread.title || thread.title.trim().length === 0)) {
    thread.title = titleFromBody(body);
  }
  if (!thread.commandCenterId) {
    thread.commandCenterId = normalizeString(input.commandCenterId);
  }
  if (!thread.initiativeId) {
    thread.initiativeId = normalizeString(input.initiativeId);
    thread.initiativeTitle = normalizeString(input.initiativeTitle);
  }
  if (!thread.workstreamId) {
    thread.workstreamId = normalizeString(input.workstreamId);
  }
  if (!thread.taskId) {
    thread.taskId = normalizeString(input.taskId);
  }

  store.updatedAt = now;
  writePersistedStore(store);
  return {
    thread,
    message,
    createdThread,
    updatedAt: store.updatedAt,
  };
}

export function recordChatLaunch(input: {
  threadId: string;
  messageId: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  watcherIds?: string[];
  watcherNames?: string[];
  executionMode?: "local_queue" | "cloud" | "hybrid";
  provider?: string | null;
  runId?: string | null;
  status?: ChatLaunchStatus;
  blockedReason?: string | null;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}): { thread: ChatThreadRecord; launch: ChatLaunchAttemptRecord; updatedAt: string } {
  const threadId = normalizeString(input.threadId);
  const messageId = normalizeString(input.messageId);
  if (!threadId) throw new Error("threadId is required");
  if (!messageId) throw new Error("messageId is required");
  const now = new Date().toISOString();
  const store = readPersistedStore();
  const thread = store.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error("thread not found");
  const messageExists = thread.messages.some((message) => message.id === messageId);
  if (!messageExists) throw new Error("message not found on thread");

  const launch = normalizeLaunch(threadId, {
    id: `launch_${randomUUID()}`,
    threadId,
    messageId,
    assigneeId: normalizeString(input.assigneeId),
    assigneeName: normalizeString(input.assigneeName),
    watcherIds: input.watcherIds ?? [],
    watcherNames: input.watcherNames ?? [],
    executionMode: input.executionMode ?? "local_queue",
    provider: normalizeString(input.provider),
    runId: normalizeString(input.runId),
    status: input.status ?? (normalizeString(input.runId) ? "queued" : "requested"),
    blockedReason: normalizeString(input.blockedReason),
    warnings: input.warnings ?? [],
    requestedAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  });
  if (!launch) throw new Error("failed to create launch attempt");

  thread.launches.unshift(launch);
  if (thread.launches.length > MAX_LAUNCHES_PER_THREAD) {
    thread.launches = thread.launches.slice(0, MAX_LAUNCHES_PER_THREAD);
  }
  thread.launchCount = Math.max(thread.launchCount + 1, thread.launches.length);
  thread.lastLaunchAt = now;
  thread.lastActivityAt = now;
  thread.updatedAt = now;
  thread.assigneeId = launch.assigneeId ?? thread.assigneeId;
  thread.assigneeName = launch.assigneeName ?? thread.assigneeName;
  thread.watcherIds = dedupeStrings([...(thread.watcherIds ?? []), ...launch.watcherIds]);
  thread.watcherNames = dedupeStrings([...(thread.watcherNames ?? []), ...launch.watcherNames]);
  thread.status = threadStatusFromLaunch(launch.status);
  const baseSnippet = launch.blockedReason
    ? `Launch blocked: ${launch.blockedReason}`
    : launch.status === "queued"
      ? "Queued locally. Run starts when a worker is available."
      : launch.status === "running"
        ? "Run is active."
        : launch.status === "completed"
          ? "Launch completed."
          : launch.status === "failed"
            ? "Launch failed."
            : "Launch requested.";
  thread.lastSnippet = baseSnippet;

  store.updatedAt = now;
  writePersistedStore(store);
  return {
    thread,
    launch,
    updatedAt: store.updatedAt,
  };
}

export function updateChatLaunchStatus(input: {
  threadId: string;
  launchId: string;
  status: ChatLaunchStatus;
  runId?: string | null;
  blockedReason?: string | null;
  warnings?: string[];
}): { thread: ChatThreadRecord; launch: ChatLaunchAttemptRecord; updatedAt: string } {
  const threadId = normalizeString(input.threadId);
  const launchId = normalizeString(input.launchId);
  if (!threadId) throw new Error("threadId is required");
  if (!launchId) throw new Error("launchId is required");
  const now = new Date().toISOString();
  const store = readPersistedStore();
  const thread = store.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error("thread not found");
  const launch = thread.launches.find((entry) => entry.id === launchId);
  if (!launch) throw new Error("launch not found");

  launch.status = input.status;
  launch.updatedAt = now;
  launch.runId = normalizeString(input.runId) ?? launch.runId;
  launch.blockedReason = normalizeString(input.blockedReason) ?? launch.blockedReason;
  launch.warnings = dedupeStrings(input.warnings ?? launch.warnings);

  thread.status = threadStatusFromLaunch(launch.status);
  thread.lastActivityAt = now;
  thread.lastLaunchAt = now;
  thread.updatedAt = now;
  thread.lastSnippet = launch.blockedReason
    ? `Launch blocked: ${launch.blockedReason}`
    : launch.status === "running"
      ? "Run is active."
      : launch.status === "completed"
        ? "Launch completed."
        : launch.status === "failed"
          ? "Launch failed."
          : thread.lastSnippet;

  store.updatedAt = now;
  writePersistedStore(store);
  return { thread, launch, updatedAt: store.updatedAt };
}

export function linkChatThreadScope(input: {
  threadId: string;
  commandCenterId?: string | null;
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  taskId?: string | null;
}): { thread: ChatThreadRecord; eventMessage: ChatMessageRecord; updatedAt: string } {
  const threadId = normalizeString(input.threadId);
  if (!threadId) throw new Error("threadId is required");
  const now = new Date().toISOString();
  const store = readPersistedStore();
  const thread = store.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error("thread not found");

  const previousInitiative = thread.initiativeTitle ?? thread.initiativeId ?? "Unscoped";
  const nextInitiativeId = normalizeString(input.initiativeId);
  const nextInitiativeTitle = normalizeString(input.initiativeTitle);
  thread.commandCenterId = normalizeString(input.commandCenterId) ?? thread.commandCenterId;
  thread.initiativeId = nextInitiativeId;
  thread.initiativeTitle = nextInitiativeTitle;
  thread.workstreamId = normalizeString(input.workstreamId);
  thread.taskId = normalizeString(input.taskId);
  thread.updatedAt = now;
  thread.lastActivityAt = now;

  const currentLabel = nextInitiativeTitle ?? nextInitiativeId ?? "Unscoped";
  const eventBody =
    previousInitiative === currentLabel
      ? `Linked to ${currentLabel}.`
      : `Scope updated: ${previousInitiative} -> ${currentLabel}.`;

  const eventMessage = normalizeMessage(thread.id, {
    id: `msg_${randomUUID()}`,
    threadId: thread.id,
    role: "system",
    body: eventBody,
    senderId: "orgx_system",
    senderName: "OrgX",
    createdAt: now,
    updatedAt: now,
    attachments: [],
    metadata: {
      event: "thread_scope_linked",
      previousInitiative,
      currentInitiative: currentLabel,
    },
  });
  if (!eventMessage) throw new Error("failed to create scope event message");

  thread.messages.push(eventMessage);
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  thread.messageCount = Math.max(thread.messageCount + 1, thread.messages.length);
  thread.lastMessageAt = now;
  thread.lastSnippet = eventBody;
  thread.summary = summarizeBody(eventBody);

  store.updatedAt = now;
  writePersistedStore(store);
  return { thread, eventMessage, updatedAt: store.updatedAt };
}
