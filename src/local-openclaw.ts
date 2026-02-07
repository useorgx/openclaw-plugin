import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { LiveActivityItem, SessionTreeResponse } from "./types.js";

type OpenClawConfig = {
  agents?: {
    list?: Array<{
      id?: string;
      name?: string;
      default?: boolean;
    }>;
  };
};

type SessionOrigin = {
  label?: string;
};

type SessionRecord = {
  sessionId?: string;
  updatedAt?: number | string;
  displayName?: string;
  kind?: string;
  origin?: SessionOrigin;
  abortedLastRun?: boolean;
  systemSent?: boolean;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  totalTokens?: number;
};

type SessionMap = Record<string, SessionRecord>;

export interface LocalSession {
  key: string;
  sessionId: string | null;
  agentId: string | null;
  agentName: string | null;
  displayName: string;
  kind: string | null;
  updatedAt: string | null;
  updatedAtMs: number;
  abortedLastRun: boolean;
  systemSent: boolean;
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
  totalTokens: number | null;
}

export interface LocalAgent {
  id: string;
  name: string;
  status: "active" | "idle" | "blocked";
  currentTask: string | null;
  runId: string | null;
  initiativeId: string | null;
  startedAt: string | null;
  blockers: string[];
}

export interface LocalOpenClawSnapshot {
  fetchedAt: string;
  sessions: LocalSession[];
  agents: LocalAgent[];
}

const ACTIVE_WINDOW_MS = 30 * 60_000;
const LOCAL_SNAPSHOT_CACHE_TTL_MS = 1_500;

interface LocalSnapshotCacheEntry {
  fetchedAtMs: number;
  limit: number;
  snapshot: LocalOpenClawSnapshot;
}

let localSnapshotCache: LocalSnapshotCacheEntry | null = null;

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toIsoString(value: number | string | undefined): { iso: string | null; ms: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { iso: new Date(value).toISOString(), ms: value };
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return { iso: new Date(parsed).toISOString(), ms: parsed };
    }
  }

  return { iso: null, ms: 0 };
}

function parseAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] ?? null;
}

function parseSessionLabel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":") || sessionKey;
  }
  return sessionKey;
}

function resolveDefaultAgentId(config: OpenClawConfig | null): string {
  const list = config?.agents?.list;
  if (Array.isArray(list) && list.length > 0) {
    const preferred = list.find((entry) => entry.default && typeof entry.id === "string");
    if (preferred?.id) return preferred.id;
    const first = list.find((entry) => typeof entry.id === "string");
    if (first?.id) return first.id;
  }
  return "main";
}

function determineAgentStatus(session: LocalSession | null, nowMs: number): "active" | "idle" | "blocked" {
  if (!session) return "idle";
  if (session.abortedLastRun && nowMs - session.updatedAtMs <= 24 * 60 * 60_000) {
    return "blocked";
  }
  if (session.updatedAtMs > 0 && nowMs - session.updatedAtMs <= ACTIVE_WINDOW_MS) {
    return "active";
  }
  return "idle";
}

function normalizeSessions(input: SessionMap | null, configuredAgents: Map<string, string>): LocalSession[] {
  if (!input || typeof input !== "object") return [];

  const sessions: LocalSession[] = [];
  for (const [key, record] of Object.entries(input)) {
    if (!record || typeof record !== "object") continue;

    const { iso, ms } = toIsoString(record.updatedAt);
    const agentId = parseAgentId(key);
    const displayName =
      typeof record.displayName === "string" && record.displayName.trim().length > 0
        ? record.displayName.trim()
        : typeof record.origin?.label === "string" && record.origin.label.trim().length > 0
          ? record.origin.label.trim()
          : parseSessionLabel(key);

    const agentName = agentId ? configuredAgents.get(agentId) ?? agentId : null;

    sessions.push({
      key,
      sessionId: typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : null,
      agentId,
      agentName,
      displayName,
      kind: typeof record.kind === "string" ? record.kind : null,
      updatedAt: iso,
      updatedAtMs: ms,
      abortedLastRun: Boolean(record.abortedLastRun),
      systemSent: Boolean(record.systemSent),
      modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : null,
      model: typeof record.model === "string" ? record.model : null,
      contextTokens: typeof record.contextTokens === "number" ? record.contextTokens : null,
      totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : null,
    });
  }

  return sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function buildAgentList(config: OpenClawConfig | null, sessions: LocalSession[]): LocalAgent[] {
  const nowMs = Date.now();
  const configured = new Map<string, string>();

  for (const entry of config?.agents?.list ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) continue;
    const id = entry.id.trim();
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;
    configured.set(id, name);
  }

  const latestByAgent = new Map<string, LocalSession>();
  for (const session of sessions) {
    if (!session.agentId) continue;
    const existing = latestByAgent.get(session.agentId);
    if (!existing || session.updatedAtMs > existing.updatedAtMs) {
      latestByAgent.set(session.agentId, session);
    }
  }

  const agentIds = new Set<string>([...configured.keys(), ...latestByAgent.keys()]);
  const agents: LocalAgent[] = [];

  for (const id of agentIds) {
    const latest = latestByAgent.get(id) ?? null;
    agents.push({
      id,
      name: configured.get(id) ?? latest?.agentName ?? id,
      status: determineAgentStatus(latest, nowMs),
      currentTask: latest?.displayName ?? null,
      runId: latest?.sessionId ?? latest?.key ?? null,
      initiativeId: id ? `agent:${id}` : null,
      startedAt: latest?.updatedAt ?? null,
      blockers: latest?.abortedLastRun ? ["Last run was aborted"] : [],
    });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function withSessionLimit(
  snapshot: LocalOpenClawSnapshot,
  limit: number
): LocalOpenClawSnapshot {
  if (snapshot.sessions.length <= limit) {
    return snapshot;
  }

  return {
    ...snapshot,
    sessions: snapshot.sessions.slice(0, limit),
  };
}

async function readLocalOpenClawSnapshot(
  limit: number
): Promise<LocalOpenClawSnapshot> {
  const baseDir = join(homedir(), ".openclaw");
  const configPath = join(baseDir, "openclaw.json");
  const config = await readJsonFile<OpenClawConfig>(configPath);

  const configuredAgents = new Map<string, string>();
  for (const entry of config?.agents?.list ?? []) {
    if (typeof entry?.id !== "string") continue;
    const id = entry.id.trim();
    if (!id) continue;
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;
    configuredAgents.set(id, name);
  }

  const defaultAgentId = resolveDefaultAgentId(config);
  const sessionsPath = join(baseDir, "agents", defaultAgentId, "sessions", "sessions.json");
  const sessionMap = await readJsonFile<SessionMap>(sessionsPath);

  const sessions = normalizeSessions(sessionMap, configuredAgents).slice(0, Math.max(1, limit));
  const agents = buildAgentList(config, sessions);

  return {
    fetchedAt: new Date().toISOString(),
    sessions,
    agents,
  };
}

export async function loadLocalOpenClawSnapshot(
  limit = 200
): Promise<LocalOpenClawSnapshot> {
  const normalizedLimit = Math.max(1, limit);
  const now = Date.now();

  if (
    localSnapshotCache &&
    now - localSnapshotCache.fetchedAtMs <= LOCAL_SNAPSHOT_CACHE_TTL_MS &&
    localSnapshotCache.limit >= normalizedLimit
  ) {
    return withSessionLimit(localSnapshotCache.snapshot, normalizedLimit);
  }

  const snapshot = await readLocalOpenClawSnapshot(normalizedLimit);
  localSnapshotCache = {
    fetchedAtMs: now,
    limit: normalizedLimit,
    snapshot,
  };
  return snapshot;
}

function deriveSessionStatus(session: LocalSession): string {
  if (session.abortedLastRun) return "failed";
  const ageMs = Date.now() - session.updatedAtMs;
  if (session.updatedAtMs > 0 && ageMs <= 5 * 60_000) return "running";
  if (session.updatedAtMs > 0 && ageMs <= ACTIVE_WINDOW_MS) return "queued";
  return "archived";
}

export function toLocalSessionTree(
  snapshot: LocalOpenClawSnapshot,
  limit = 100
): SessionTreeResponse {
  const nodes = snapshot.sessions.slice(0, Math.max(1, limit)).map((session) => {
    const groupId = session.agentId ? `agent:${session.agentId}` : "local";
    const groupLabel = session.agentName ? `Agent ${session.agentName}` : "Local Sessions";

    return {
      id: session.sessionId ?? session.key,
      parentId: null,
      runId: session.sessionId ?? session.key,
      title: session.displayName,
      agentId: session.agentId,
      agentName: session.agentName,
      status: deriveSessionStatus(session),
      progress: null,
      initiativeId: groupId,
      workstreamId: null,
      groupId,
      groupLabel,
      startedAt: session.updatedAt,
      updatedAt: session.updatedAt,
      lastEventAt: session.updatedAt,
      lastEventSummary: session.systemSent
        ? "Session sent an update"
        : "Local OpenClaw session activity",
      blockers: session.abortedLastRun ? ["Last run was aborted"] : [],
    };
  });

  const groupsMap = new Map<string, { id: string; label: string; status: string | null }>();
  for (const node of nodes) {
    if (!groupsMap.has(node.groupId)) {
      groupsMap.set(node.groupId, {
        id: node.groupId,
        label: node.groupLabel,
        status: node.status,
      });
    }
  }

  return {
    nodes,
    edges: [],
    groups: Array.from(groupsMap.values()),
  };
}

// ---------------------------------------------------------------------------
// JSONL message reading for rich activity feed
// ---------------------------------------------------------------------------

interface JnlContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface JnlMessage {
  role: string;
  content?: string | JnlContentBlock[];
  stopReason?: string;
  model?: string;
  errorMessage?: string;
}

interface JnlEvent {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: JnlMessage;
}

const JSONL_RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7 days
const MAX_MESSAGES_PER_SESSION = 50;
const MAX_TOTAL_MESSAGES = 200;

function extractMessageText(
  content: string | JnlContentBlock[] | undefined,
  maxLen: number
): string {
  if (!content) return "";

  if (typeof content === "string") {
    return content.length > maxLen ? content.slice(0, maxLen) + "…" : content;
  }

  if (!Array.isArray(content)) return "";

  // Prefer text blocks first
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      const text = block.text.trim();
      return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    }
  }

  // Then tool_use blocks
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return `[tool: ${block.name}]`;
    }
  }

  // Then tool_result blocks
  for (const block of content) {
    if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") {
        return inner.length > maxLen ? inner.slice(0, maxLen) + "…" : inner;
      }
      if (Array.isArray(inner)) {
        const textBlock = (inner as JnlContentBlock[]).find(
          (b) => b.type === "text" && typeof b.text === "string"
        );
        if (textBlock?.text) {
          const t = textBlock.text.trim();
          return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
        }
      }
      return "[tool result]";
    }
  }

  return "";
}

function findToolNames(content: string | JnlContentBlock[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

async function readSessionMessages(
  session: LocalSession,
  baseDir: string,
  agentId: string,
  limit: number
): Promise<JnlEvent[]> {
  if (!session.sessionId) return [];

  const jsonlPath = join(baseDir, "agents", agentId, "sessions", `${session.sessionId}.jsonl`);

  // Quick existence/size check
  try {
    const info = await stat(jsonlPath);
    if (info.size === 0) return [];
  } catch {
    return [];
  }

  try {
    const raw = await readFile(jsonlPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    // Read from end (most recent first)
    const messages: JnlEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
      try {
        const event = JSON.parse(lines[i]) as JnlEvent;
        if (event.type === "message" && event.message && event.timestamp) {
          messages.push(event);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

function messageEventToActivity(
  event: JnlEvent,
  session: LocalSession,
  index: number
): LiveActivityItem | null {
  const msg = event.message;
  if (!msg) return null;

  const role = msg.role;
  const timestamp = event.timestamp ?? session.updatedAt ?? new Date().toISOString();
  const agentLabel = session.agentName ?? session.agentId ?? "OpenClaw";
  const modelInfo = msg.model ?? ([session.modelProvider, session.model].filter(Boolean).join("/") || null);

  let type: LiveActivityItem["type"] = "delegation";
  let title: string;
  let summary: string;

  if (role === "user") {
    const text = extractMessageText(msg.content, 200);
    title = `User: ${text || "(empty prompt)"}`;
    summary = extractMessageText(msg.content, 400);
  } else if (role === "assistant") {
    if (msg.stopReason === "toolUse" || msg.stopReason === "tool_use") {
      type = "artifact_created";
      const tools = findToolNames(msg.content);
      const toolLabel = tools.length > 0 ? tools.join(", ") : "tool";
      title = `${agentLabel} used ${toolLabel}`;
      summary = extractMessageText(msg.content, 400);
    } else if (msg.stopReason === "error" || msg.errorMessage) {
      type = "run_failed";
      const errText = msg.errorMessage ?? extractMessageText(msg.content, 200);
      title = `Error: ${errText || "Unknown error"}`;
      summary = errText ?? "";
    } else {
      // Normal assistant response (stopReason: "stop" or "end_turn")
      const text = extractMessageText(msg.content, 200);
      title = `${agentLabel}: ${text || "(empty response)"}`;
      summary = extractMessageText(msg.content, 400);
    }
  } else if (role === "toolResult" || role === "tool") {
    const text = extractMessageText(msg.content, 200);
    title = `Tool result: ${text || "(empty)"}`;
    summary = extractMessageText(msg.content, 400);
  } else {
    return null;
  }

  return {
    id: `local:msg:${event.id ?? `${session.key}:${index}`}`,
    type,
    title,
    description: modelInfo ? `${modelInfo}` : null,
    agentId: session.agentId,
    agentName: session.agentName,
    runId: session.sessionId ?? session.key,
    initiativeId: session.agentId ? `agent:${session.agentId}` : null,
    timestamp,
    summary,
    metadata: {
      source: "local_openclaw",
      sessionKey: session.key,
      role,
    },
  };
}

export async function toLocalLiveActivity(
  snapshot: LocalOpenClawSnapshot,
  limit = 200
): Promise<{ activities: LiveActivityItem[]; total: number }> {
  const baseDir = join(homedir(), ".openclaw");
  const nowMs = Date.now();
  const recentCutoff = nowMs - JSONL_RECENT_WINDOW_MS;
  const totalCap = Math.min(limit, MAX_TOTAL_MESSAGES);

  const allActivities: LiveActivityItem[] = [];

  // Determine agent ID for file paths (use first session's agentId or "main")
  const defaultAgentId =
    snapshot.sessions.find((s) => s.agentId)?.agentId ?? "main";

  for (const session of snapshot.sessions) {
    if (allActivities.length >= totalCap) break;

    const hasSessionFile = Boolean(session.sessionId);
    const isRecent = session.updatedAtMs >= recentCutoff;

    if (hasSessionFile && isRecent) {
      // Read JSONL messages for recent sessions
      const agentId = session.agentId ?? defaultAgentId;
      const remaining = totalCap - allActivities.length;
      const perSessionCap = Math.min(MAX_MESSAGES_PER_SESSION, remaining);

      const messages = await readSessionMessages(session, baseDir, agentId, perSessionCap);

      for (let i = 0; i < messages.length; i++) {
        const item = messageEventToActivity(messages[i], session, i);
        if (item) allActivities.push(item);
      }

      // If no messages found (e.g. empty/missing file), fall back to summary
      if (messages.length === 0) {
        allActivities.push(makeSessionSummaryItem(session));
      }
    } else {
      // Old session or no sessionId — use single summary event
      allActivities.push(makeSessionSummaryItem(session));
    }
  }

  return {
    activities: allActivities,
    total: allActivities.length,
  };
}

function makeSessionSummaryItem(session: LocalSession): LiveActivityItem {
  const type: LiveActivityItem["type"] = session.abortedLastRun
    ? "run_failed"
    : deriveSessionStatus(session) === "running"
      ? "run_started"
      : "delegation";

  const modelInfo = [session.modelProvider, session.model].filter(Boolean).join("/");

  return {
    id: `local:${session.key}:${session.updatedAtMs}`,
    type,
    title:
      type === "run_failed"
        ? `Session failed: ${session.displayName}`
        : type === "run_started"
          ? `Session active: ${session.displayName}`
          : `Session update: ${session.displayName}`,
    description: modelInfo ? `Local OpenClaw session (${modelInfo})` : "Local OpenClaw session",
    agentId: session.agentId,
    agentName: session.agentName,
    runId: session.sessionId ?? session.key,
    initiativeId: session.agentId ? `agent:${session.agentId}` : null,
    timestamp: session.updatedAt ?? new Date().toISOString(),
    metadata: {
      source: "local_openclaw",
      sessionKey: session.key,
      kind: session.kind,
      totalTokens: session.totalTokens,
      contextTokens: session.contextTokens,
    },
  };
}

export function toLocalLiveAgents(snapshot: LocalOpenClawSnapshot): {
  agents: Array<{
    id: string;
    name: string;
    status: string;
    currentTask: string | null;
    runId: string | null;
    initiativeId: string | null;
    startedAt: string | null;
    blockers: string[];
  }>;
  summary: Record<string, number>;
} {
  const summary: Record<string, number> = {};

  const agents = snapshot.agents.map((agent) => {
    summary[agent.status] = (summary[agent.status] ?? 0) + 1;
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      currentTask: agent.currentTask,
      runId: agent.runId,
      initiativeId: agent.initiativeId,
      startedAt: agent.startedAt,
      blockers: agent.blockers,
    };
  });

  return { agents, summary };
}

export function toLocalLiveInitiatives(snapshot: LocalOpenClawSnapshot): {
  initiatives: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    sessionCount: number;
    activeAgents: number;
  }>;
  total: number;
} {
  const byAgent = new Map<
    string,
    {
      id: string;
      title: string;
      status: string;
      updatedAt: string | null;
      updatedAtMs: number;
      sessionCount: number;
      activeAgents: Set<string>;
    }
  >();

  for (const session of snapshot.sessions) {
    const groupId = session.agentId ? `agent:${session.agentId}` : "agent:unknown";
    const existing =
      byAgent.get(groupId) ?? {
        id: groupId,
        title: session.agentName ? `Agent ${session.agentName}` : "Unassigned",
        status: "active",
        updatedAt: session.updatedAt,
        updatedAtMs: session.updatedAtMs,
        sessionCount: 0,
        activeAgents: new Set<string>(),
      };

    existing.sessionCount += 1;
    if (session.agentId) existing.activeAgents.add(session.agentId);
    if (session.updatedAtMs > existing.updatedAtMs) {
      existing.updatedAtMs = session.updatedAtMs;
      existing.updatedAt = session.updatedAt;
    }

    byAgent.set(groupId, existing);
  }

  const initiatives = Array.from(byAgent.values())
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      updatedAt: entry.updatedAt,
      sessionCount: entry.sessionCount,
      activeAgents: entry.activeAgents.size,
    }));

  return {
    initiatives,
    total: initiatives.length,
  };
}
