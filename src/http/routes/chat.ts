import type {
  ChatAttachmentRecord,
  ChatLaunchStatus,
  ChatThreadRecord,
} from "../../chat-store.js";
import type {
  ChatThreadSummary,
} from "../../chat-store.js";
import {
  getChatThread,
  linkChatThreadScope,
  listChatThreads,
  recordChatLaunch,
  sendChatMessage,
  updateChatLaunchStatus,
} from "../../chat-store.js";
import { asRecord, asStringArray } from "../../lib/type-coercion.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RegisterChatRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  parsePositiveInt: (raw: string | null, fallback: number, max?: number) => number;
  emitActivitySafe?: (input: {
    initiativeId: string | null;
    sourceClient?: string;
    message: string;
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    progressPct?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function normalizeStatus(value: string | null | undefined): ChatLaunchStatus {
  const normalized = (value ?? "").trim().toLowerCase();
  if (
    normalized === "requested" ||
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "blocked" ||
    normalized === "completed" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return "requested";
}

function normalizeAttachments(input: unknown): Array<Partial<ChatAttachmentRecord> & { name?: string | null }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : undefined,
      name: typeof entry.name === "string" ? entry.name : undefined,
      mimeType: typeof entry.mimeType === "string" ? entry.mimeType : null,
      sizeBytes:
        typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)
          ? Math.max(0, Math.floor(entry.sizeBytes))
          : null,
      status:
        entry.status === "preparing" ||
        entry.status === "indexing" ||
        entry.status === "ready" ||
        entry.status === "failed"
          ? entry.status
          : "ready",
      error: typeof entry.error === "string" ? entry.error : null,
      masked: entry.masked === true,
    }));
}

function extractUiMessageText(value: unknown): string | null {
  const row = asRecord(value);
  if (!row) return null;
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const text = parts
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text.length > 0) return text;
  if (typeof row.content === "string" && row.content.trim().length > 0) {
    return row.content.trim();
  }
  return null;
}

function extractLastUserPrompt(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (message.role !== "user") continue;
    const text = extractUiMessageText(message);
    if (text) return text;
  }
  return null;
}

function chunkText(value: string, chunkSize = 36): string[] {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return [];
  const chunks: string[] = [];
  for (let i = 0; i < compact.length; i += chunkSize) {
    chunks.push(compact.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildAssistantReply(input: {
  prompt: string;
  assigneeName: string | null;
  initiativeTitle: string | null;
  watcherCount: number;
}): string {
  const hasAgent = Boolean(input.assigneeName);
  const hasScope = Boolean(input.initiativeTitle);

  if (hasAgent && hasScope) {
    return `Got it \u2014 ${input.assigneeName} is on it. Scoped to ${input.initiativeTitle}.`;
  }
  if (hasAgent && !hasScope) {
    return `Got it \u2014 ${input.assigneeName} is assigned. Scope to an initiative when ready to launch.`;
  }
  if (!hasAgent && hasScope) {
    return `Saved to ${input.initiativeTitle}. Pick an agent with @ to get started.`;
  }
  return "Message saved. Pick an agent with @ and scope with # to get started.";
}

function sendThreadList(
  deps: RegisterChatRoutesDeps<any, any>,
  res: any,
  input: {
    commandCenterId: string | null;
    initiativeId: string | null;
    query: string | null;
    status: string | null;
    limit: number;
    offset: number;
  }
): void {
  const listed = listChatThreads({
    commandCenterId: input.commandCenterId,
    initiativeId: input.initiativeId,
    query: input.query,
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });
  deps.sendJson(res, 200, {
    ok: true,
    threads: listed.threads,
    total: listed.total,
    limit: input.limit,
    offset: input.offset,
    updatedAt: listed.updatedAt,
  });
}

async function emitThreadEvent(
  deps: RegisterChatRoutesDeps<any, any>,
  input: {
    event: string;
    message: string;
    thread: ChatThreadRecord | ChatThreadSummary;
    messageId?: string | null;
    launchId?: string | null;
    runId?: string | null;
    status?: string | null;
    assigneeId?: string | null;
    watcherCount?: number | null;
    provider?: string | null;
  }
): Promise<void> {
  if (typeof deps.emitActivitySafe !== "function") return;
  const normalizedStatus = (input.status ?? "").trim().toLowerCase();
  const phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed" =
    normalizedStatus === "running"
      ? "execution"
      : normalizedStatus === "blocked" || normalizedStatus === "failed"
        ? "blocked"
        : normalizedStatus === "completed"
          ? "completed"
          : "intent";
  try {
    await deps.emitActivitySafe({
      initiativeId: input.thread.initiativeId ?? null,
      sourceClient: "openclaw",
      message: input.message,
      phase,
      metadata: {
        event: input.event,
        activity_bucket: "message",
        thread_id: input.thread.id,
        message_id: input.messageId ?? null,
        launch_id: input.launchId ?? null,
        run_id: input.runId ?? null,
        status: input.status ?? null,
        initiative_id: input.thread.initiativeId ?? null,
        workstream_id: input.thread.workstreamId ?? null,
        task_id: input.thread.taskId ?? null,
        assignee_id: input.assigneeId ?? null,
        watcher_count: input.watcherCount ?? null,
        provider: input.provider ?? null,
      },
    });
  } catch {
    // best effort
  }
}

export function registerChatRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterChatRoutesDeps<TReq, TRes>
): void {
  router.add(
    "GET",
    "chat/threads",
    async ({ query, res }) => {
      try {
        const commandCenterId =
          query.get("project_id") ??
          query.get("workspace_id") ??
          query.get("workspaceId") ??
          query.get("command_center_id") ??
          query.get("commandCenterId");
        const initiativeId = query.get("initiative_id") ?? query.get("initiative");
        const searchQuery = query.get("query") ?? query.get("q");
        const status = query.get("status");
        const limit = deps.parsePositiveInt(query.get("limit"), 60, 200);
        const offset = deps.parsePositiveInt(query.get("offset"), 0, 10000);
        sendThreadList(deps, res, {
          commandCenterId: commandCenterId?.trim() ?? null,
          initiativeId: initiativeId?.trim() ?? null,
          query: searchQuery?.trim() ?? null,
          status: status?.trim() ?? null,
          limit,
          offset,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "List chat threads"
  );

  router.add(
    "GET",
    "chat/threads/*",
    async ({ path, res }) => {
      try {
        const match = path.match(/^chat\/threads\/([^/]+)$/);
        if (!match) {
          deps.sendJson(res, 404, { ok: false, error: "Unknown API endpoint" });
          return;
        }
        const threadId = decodeURIComponent(match[1]).trim();
        if (!threadId) {
          deps.sendJson(res, 400, { ok: false, error: "threadId is required" });
          return;
        }
        const thread = getChatThread(threadId);
        if (!thread) {
          deps.sendJson(res, 404, { ok: false, error: "thread not found" });
          return;
        }
        deps.sendJson(res, 200, { ok: true, thread });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Get chat thread detail"
  );

  router.add(
    "POST",
    "chat/messages",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const threadId = deps.pickString(payload, ["threadId", "thread_id"]);
        const body = deps.pickString(payload, ["body", "message", "text"]);
        if (!body) {
          deps.sendJson(res, 400, { ok: false, error: "message body is required" });
          return;
        }

        const result = sendChatMessage({
          threadId,
          commandCenterId:
            deps.pickString(payload, [
              "projectId",
              "project_id",
              "workspaceId",
              "workspace_id",
              "commandCenterId",
              "command_center_id",
            ]) ??
            null,
          initiativeId: deps.pickString(payload, ["initiativeId", "initiative_id"]) ?? null,
          initiativeTitle:
            deps.pickString(payload, [
              "initiativeTitle",
              "initiative_title",
              "initiativeName",
              "initiative_name",
            ]) ?? null,
          workstreamId: deps.pickString(payload, ["workstreamId", "workstream_id"]) ?? null,
          taskId: deps.pickString(payload, ["taskId", "task_id"]) ?? null,
          title: deps.pickString(payload, ["title"]),
          body,
          senderId: deps.pickString(payload, ["senderId", "sender_id", "authorId", "author_id"]),
          senderName: deps.pickString(payload, ["senderName", "sender_name", "authorName", "author_name"]),
          assigneeId: deps.pickString(payload, ["assigneeId", "assignee_id"]),
          assigneeName: deps.pickString(payload, ["assigneeName", "assignee_name"]),
          watcherIds: asStringArray(payload.watcherIds),
          watcherNames: asStringArray(payload.watcherNames),
          attachments: normalizeAttachments(payload.attachments),
          metadata: asRecord(payload.metadata) ?? {},
        });

        await emitThreadEvent(deps, {
          event: result.createdThread ? "chat_thread_created" : "chat_message_sent",
          message: result.createdThread
            ? `Thread created: ${result.thread.title}`
            : `Message sent: ${result.thread.title}`,
          thread: result.thread,
          messageId: result.message.id,
          assigneeId: result.thread.assigneeId,
          watcherCount: result.thread.watcherIds.length,
          status: result.thread.status,
        });

        deps.sendJson(res, 201, {
          ok: true,
          createdThread: result.createdThread,
          thread: result.thread,
          message: result.message,
          updatedAt: result.updatedAt,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Create thread message"
  );

  router.add(
    "POST",
    "chat/usechat",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const threadId = deps.pickString(payload, ["threadId", "thread_id"]);
        const prompt =
          deps.pickString(payload, ["prompt", "text", "message"]) ??
          extractLastUserPrompt(payload.messages);

        if (!prompt) {
          deps.sendJson(res, 400, { ok: false, error: "A user prompt is required." });
          return;
        }

        const assigneeId = deps.pickString(payload, ["assigneeId", "assignee_id"]);
        const assigneeName = deps.pickString(payload, ["assigneeName", "assignee_name"]);
        const initiativeId = deps.pickString(payload, ["initiativeId", "initiative_id"]);
        const initiativeTitle = deps.pickString(payload, [
          "initiativeTitle",
          "initiative_title",
          "initiativeName",
          "initiative_name",
        ]);
        const watcherIds = asStringArray(payload.watcherIds);
        const watcherNames = asStringArray(payload.watcherNames);
        const commandCenterId =
          deps.pickString(payload, [
            "projectId",
            "project_id",
            "workspaceId",
            "workspace_id",
            "commandCenterId",
            "command_center_id",
          ]) ??
          null;

        const reply = buildAssistantReply({
          prompt,
          assigneeName,
          initiativeTitle,
          watcherCount: watcherIds.length > 0 ? watcherIds.length : watcherNames.length,
        });

        // Persist the assistant guidance onto the active thread when possible, without
        // altering the user-message-first thread summary semantics.
        if (threadId && getChatThread(threadId)) {
          const result = sendChatMessage({
            threadId,
            commandCenterId,
            initiativeId,
            initiativeTitle,
            role: "agent",
            body: reply,
            senderId: assigneeId ?? "orgx-assistant",
            senderName: assigneeName ?? "OrgX Assistant",
            watcherIds,
            watcherNames,
            metadata: {
              source: "usechat",
              mode: "guidance",
            },
          });
          await emitThreadEvent(deps, {
            event: "chat_assistant_guidance_sent",
            message: `Assistant guidance updated: ${result.thread.title}`,
            thread: result.thread,
            messageId: result.message.id,
            assigneeId: result.thread.assigneeId,
            watcherCount: result.thread.watcherIds.length,
            status: result.thread.status,
          });
        }

        const writable = res as unknown as {
          writeHead?: (status: number, headers: Record<string, string>) => void;
          write?: (chunk: string) => boolean;
          once?: (event: string, listener: () => void) => void;
          end?: () => void;
        };
        const write = writable.write?.bind(writable);
        if (!writable.writeHead || !write || !writable.end) {
          deps.sendJson(res, 501, { ok: false, error: "Streaming not supported" });
          return;
        }

        writable.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        const chunks = chunkText(reply, 28);
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = index === chunks.length - 1 ? chunks[index] : `${chunks[index]} `;
          const writeOk = write(chunk);
          if (!writeOk && typeof writable.once === "function") {
            await new Promise<void>((resolve) => writable.once?.("drain", resolve));
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 12));
        }
        writable.end();
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Stream assistant guidance for Vercel useChat"
  );

  router.add(
    "POST",
    "chat/launch",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const threadId = deps.pickString(payload, ["threadId", "thread_id"]);
        const messageId = deps.pickString(payload, ["messageId", "message_id"]);
        if (!threadId || !messageId) {
          deps.sendJson(res, 400, {
            ok: false,
            error: "threadId and messageId are required",
          });
          return;
        }

        const status = normalizeStatus(deps.pickString(payload, ["status"]));
        const result = recordChatLaunch({
          threadId,
          messageId,
          assigneeId: deps.pickString(payload, ["assigneeId", "assignee_id"]),
          assigneeName: deps.pickString(payload, ["assigneeName", "assignee_name"]),
          watcherIds: asStringArray(payload.watcherIds),
          watcherNames: asStringArray(payload.watcherNames),
          executionMode:
            deps.pickString(payload, ["executionMode", "execution_mode"]) === "cloud"
              ? "cloud"
              : deps.pickString(payload, ["executionMode", "execution_mode"]) === "hybrid"
                ? "hybrid"
                : "local_queue",
          provider: deps.pickString(payload, ["provider", "runtimeProvider", "runtime_provider"]),
          runId: deps.pickString(payload, ["runId", "run_id", "sessionId", "session_id"]),
          status,
          blockedReason: deps.pickString(payload, ["blockedReason", "blocked_reason", "error", "reason"]),
          warnings: asStringArray(payload.warnings),
          metadata: asRecord(payload.metadata) ?? {},
        });

        await emitThreadEvent(deps, {
          event:
            status === "queued"
              ? "chat_launch_queued"
              : status === "running"
                ? "chat_launch_started"
                : status === "blocked"
                  ? "chat_launch_blocked"
                  : status === "completed"
                    ? "chat_launch_completed"
                    : status === "failed"
                      ? "chat_launch_failed"
                      : "chat_launch_requested",
          message:
            status === "blocked"
              ? `Launch blocked: ${result.thread.title}`
              : `Launch ${status}: ${result.thread.title}`,
          thread: result.thread,
          messageId,
          launchId: result.launch.id,
          runId: result.launch.runId,
          status,
          assigneeId: result.launch.assigneeId,
          watcherCount: result.launch.watcherIds.length,
          provider: result.launch.provider,
        });

        deps.sendJson(res, 201, {
          ok: true,
          thread: result.thread,
          launch: result.launch,
          updatedAt: result.updatedAt,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Record chat launch attempt"
  );

  router.add(
    "PATCH",
    "chat/launch",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const threadId = deps.pickString(payload, ["threadId", "thread_id"]);
        const launchId = deps.pickString(payload, ["launchId", "launch_id"]);
        if (!threadId || !launchId) {
          deps.sendJson(res, 400, { ok: false, error: "threadId and launchId are required" });
          return;
        }
        const result = updateChatLaunchStatus({
          threadId,
          launchId,
          status: normalizeStatus(deps.pickString(payload, ["status"])),
          runId: deps.pickString(payload, ["runId", "run_id", "sessionId", "session_id"]),
          blockedReason: deps.pickString(payload, ["blockedReason", "blocked_reason", "error"]),
          warnings: asStringArray(payload.warnings),
        });
        deps.sendJson(res, 200, {
          ok: true,
          thread: result.thread,
          launch: result.launch,
          updatedAt: result.updatedAt,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Update chat launch status"
  );

  router.add(
    "POST",
    "chat/link",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const threadId = deps.pickString(payload, ["threadId", "thread_id"]);
        if (!threadId) {
          deps.sendJson(res, 400, { ok: false, error: "threadId is required" });
          return;
        }
        const result = linkChatThreadScope({
          threadId,
          commandCenterId:
            deps.pickString(payload, [
              "projectId",
              "project_id",
              "workspaceId",
              "workspace_id",
              "commandCenterId",
              "command_center_id",
            ]) ??
            null,
          initiativeId: deps.pickString(payload, ["initiativeId", "initiative_id"]),
          initiativeTitle:
            deps.pickString(payload, [
              "initiativeTitle",
              "initiative_title",
              "initiativeName",
              "initiative_name",
            ]) ?? null,
          workstreamId: deps.pickString(payload, ["workstreamId", "workstream_id"]),
          taskId: deps.pickString(payload, ["taskId", "task_id"]),
        });

        const metadata = asRecord(payload);
        const relinked = Boolean(metadata?.relinked === true);
        await emitThreadEvent(deps, {
          event: relinked ? "chat_thread_relinked_initiative" : "chat_thread_linked_initiative",
          message: result.eventMessage.body,
          thread: result.thread,
          messageId: result.eventMessage.id,
          status: result.thread.status,
          assigneeId: result.thread.assigneeId,
          watcherCount: result.thread.watcherIds.length,
        });

        deps.sendJson(res, 200, {
          ok: true,
          thread: result.thread,
          eventMessage: result.eventMessage,
          updatedAt: result.updatedAt,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Link/relink chat thread scope"
  );
}
