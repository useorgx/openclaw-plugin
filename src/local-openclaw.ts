import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

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
  const candidate = match?.[1] ?? null;
  return candidate && isSafePathSegment(candidate) ? candidate : null;
}

function isSafePathSegment(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === "..") return false;
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    return false;
  }
  if (normalized.includes("..")) return false;
  return true;
}

function coerceSafePathSegment(
  value: string | null | undefined,
  fallback: string
): string {
  if (typeof value === "string" && isSafePathSegment(value)) {
    return value.trim();
  }
  return fallback;
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
    if (preferred?.id && isSafePathSegment(preferred.id)) return preferred.id.trim();
    const first = list.find((entry) => typeof entry.id === "string");
    if (first?.id && isSafePathSegment(first.id)) return first.id.trim();
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
    if (!isSafePathSegment(id)) continue;
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
    if (!id || !isSafePathSegment(id)) continue;
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;
    configuredAgents.set(id, name);
  }

  const defaultAgentId = coerceSafePathSegment(resolveDefaultAgentId(config), "main");
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
// JSONL reading, turn grouping, and digest-based activity feed
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
  usage?: { input?: number; output?: number; cost?: { total?: number } };
}

interface JnlEvent {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: JnlMessage;
}

/** A "turn" groups consecutive JSONL events into one logical work unit. */
export interface SessionTurn {
  id: string;
  userPrompt: string | null;
  toolNames: string[];
  assistantResponse: string | null;
  errorMessage: string | null;
  model: string | null;
  timestamp: string;
  endTimestamp: string;
  costTotal: number;
  eventCount: number;
}

/** Cached digest entry for a single turn. */
interface DigestEntry {
  turnId: string;
  summary: string;
}

interface DigestCache {
  sessionId: string;
  updatedAtMs: number;
  entries: DigestEntry[];
}

const JSONL_RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7 days
const MAX_TURNS_PER_SESSION = 30;
const MAX_TOTAL_TURNS = 120;
const MAX_RAW_EVENTS = 600; // Cap raw events read from JSONL
const MAX_RAW_EVENTS_DETAIL = 5_000;
const USER_PROMPT_MAX_CHARS = 1_200;
const ERROR_TEXT_MAX_CHARS = 2_000;
const ASSISTANT_TEXT_MAX_CHARS = 20_000;

interface TurnGroupingLimits {
  userPromptMaxChars?: number;
  errorTextMaxChars?: number;
  assistantTextMaxChars?: number;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function extractText(
  content: string | JnlContentBlock[] | undefined,
  maxLen: number
): string {
  const clip = (value: string): string => {
    if (maxLen <= 0 || value.length <= maxLen) return value;
    return value.slice(0, maxLen) + "\u2026";
  };

  if (!content) return "";
  if (typeof content === "string") {
    return clip(content);
  }
  if (!Array.isArray(content)) return "";

  const textBlocks = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter((block) => block.length > 0);
  if (textBlocks.length > 0) {
    return clip(textBlocks.join("\n\n"));
  }

  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return `[tool: ${block.name}]`;
    }
  }
  for (const block of content) {
    if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") {
        return clip(inner);
      }
      if (Array.isArray(inner)) {
        const innerText = (inner as JnlContentBlock[])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => (b.text as string).trim())
          .filter((b) => b.length > 0);
        if (innerText.length > 0) {
          return clip(innerText.join("\n\n"));
        }
      }
      return "[tool result]";
    }
  }
  return "";
}

function collectToolNames(content: string | JnlContentBlock[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

// ---------------------------------------------------------------------------
// JSONL reading
// ---------------------------------------------------------------------------

async function readSessionEvents(
  session: LocalSession,
  baseDir: string,
  agentId: string,
  maxEvents: number
): Promise<JnlEvent[]> {
  if (!session.sessionId) return [];
  if (!isSafePathSegment(agentId) || !isSafePathSegment(session.sessionId)) {
    return [];
  }

  const jsonlPath = join(baseDir, "agents", agentId, "sessions", `${session.sessionId}.jsonl`);

  try {
    const info = await stat(jsonlPath);
    if (info.size === 0) return [];
  } catch {
    return [];
  }

  try {
    const raw = await readFile(jsonlPath, "utf8");
    const lines = raw.split("\n");

    // Read from end (most recent first), but only message events
    const events: JnlEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && events.length < maxEvents; i--) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      try {
        const evt = JSON.parse(line) as JnlEvent;
        if (evt.type === "message" && evt.message && evt.timestamp) {
          events.push(evt);
        }
      } catch {
        // skip
      }
    }

    // Reverse so they're in chronological order for grouping
    events.reverse();
    return events;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

function groupEventsIntoTurns(
  events: JnlEvent[],
  maxTurns: number,
  limits?: TurnGroupingLimits
): SessionTurn[] {
  const userPromptMaxChars = limits?.userPromptMaxChars ?? USER_PROMPT_MAX_CHARS;
  const errorTextMaxChars = limits?.errorTextMaxChars ?? ERROR_TEXT_MAX_CHARS;
  const assistantTextMaxChars =
    limits?.assistantTextMaxChars ?? ASSISTANT_TEXT_MAX_CHARS;
  const turns: SessionTurn[] = [];
  let current: {
    id: string;
    userPrompt: string | null;
    toolNames: string[];
    assistantTexts: string[];
    errorMessage: string | null;
    model: string | null;
    timestamp: string;
    endTimestamp: string;
    costTotal: number;
    eventCount: number;
  } | null = null;

  function finalizeTurn() {
    if (!current) return;
    turns.push({
      id: current.id,
      userPrompt: current.userPrompt,
      toolNames: [...new Set(current.toolNames)], // dedupe
      assistantResponse: current.assistantTexts.length > 0
        ? current.assistantTexts[current.assistantTexts.length - 1]
        : null,
      errorMessage: current.errorMessage,
      model: current.model,
      timestamp: current.timestamp,
      endTimestamp: current.endTimestamp,
      costTotal: current.costTotal,
      eventCount: current.eventCount,
    });
    current = null;
  }

  for (const evt of events) {
    if (turns.length >= maxTurns) break;

    const msg = evt.message;
    if (!msg) continue;

    const role = msg.role;
    const ts = evt.timestamp ?? "";
    const cost = msg.usage?.cost?.total ?? 0;

    // A user message always starts a new turn
    if (role === "user") {
      finalizeTurn();
      current = {
        id: evt.id ?? `turn-${turns.length}`,
        userPrompt: extractText(msg.content, userPromptMaxChars),
        toolNames: [],
        assistantTexts: [],
        errorMessage: null,
        model: null,
        timestamp: ts,
        endTimestamp: ts,
        costTotal: 0,
        eventCount: 1,
      };
      continue;
    }

    // Ensure we have a current turn (auto-start for autonomous assistant messages)
    if (!current) {
      current = {
        id: evt.id ?? `turn-${turns.length}`,
        userPrompt: null,
        toolNames: [],
        assistantTexts: [],
        errorMessage: null,
        model: null,
        timestamp: ts,
        endTimestamp: ts,
        costTotal: 0,
        eventCount: 0,
      };
    }

    current.endTimestamp = ts;
    current.eventCount += 1;
    current.costTotal += cost;

    if (role === "assistant") {
      current.model = msg.model ?? current.model;

      // Collect tool names from this message
      const tools = collectToolNames(msg.content);
      current.toolNames.push(...tools);

      // Check for error
      if (msg.stopReason === "error" || msg.errorMessage) {
        current.errorMessage = msg.errorMessage ?? extractText(msg.content, errorTextMaxChars);
      }

      // Collect text response
      const text = extractText(msg.content, assistantTextMaxChars);
      if (text && !text.startsWith("[tool:")) {
        current.assistantTexts.push(text);
      }

      // A completed assistant response (stop/end_turn) finalizes the turn
      if (msg.stopReason === "stop" || msg.stopReason === "end_turn") {
        finalizeTurn();
      }
    }

    // Tool results just accumulate into the current turn
    if (role === "toolResult" || role === "tool") {
      // Nothing special — they're part of the current turn
    }
  }

  // Finalize any in-progress turn
  finalizeTurn();

  return turns;
}

// ---------------------------------------------------------------------------
// Rule-based turn summarization (fallback — LLM digest in Phase 1B)
// ---------------------------------------------------------------------------

function summarizeTurn(turn: SessionTurn, _agentLabel?: string): string {
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

  if (turn.errorMessage) {
    return `Error: ${normalize(turn.errorMessage)}`;
  }

  // If there are tool calls, describe what was done
  if (turn.toolNames.length > 0) {
    const uniqueTools = [...new Set(turn.toolNames)];
    const toolStr = uniqueTools.length <= 3
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2} more`;

    if (turn.assistantResponse) {
      // Keep full text so detail modals can show complete context.
      return normalize(turn.assistantResponse);
    }
    return `Used ${toolStr}`;
  }

  // Text-only response
  if (turn.assistantResponse) {
    return normalize(turn.assistantResponse);
  }

  if (turn.userPrompt) {
    return `User: ${normalize(turn.userPrompt)}`;
  }

  return "Activity";
}

function isDigestSummaryStale(cached: string | null, fresh: string): boolean {
  if (!cached) return true;
  const trimmed = cached.trim();
  if (!trimmed) return true;
  if (trimmed.endsWith("…") && fresh.length > trimmed.length) return true;
  const deEllipsized = trimmed.replace(/…$/, "");
  if (
    deEllipsized.length > 0 &&
    fresh.length > deEllipsized.length + 24 &&
    fresh.startsWith(deEllipsized)
  ) {
    return true;
  }
  if (trimmed.startsWith("[tool:") && !fresh.startsWith("[tool:")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Digest cache — stores summarized turn titles alongside JSONL
// ---------------------------------------------------------------------------

async function readDigestCache(
  baseDir: string,
  agentId: string,
  sessionId: string
): Promise<DigestCache | null> {
  if (!isSafePathSegment(agentId) || !isSafePathSegment(sessionId)) {
    return null;
  }
  const cachePath = join(baseDir, "agents", agentId, "sessions", `${sessionId}.digest.json`);
  try {
    const raw = await readFile(cachePath, "utf8");
    return JSON.parse(raw) as DigestCache;
  } catch {
    return null;
  }
}

async function writeDigestCache(
  baseDir: string,
  agentId: string,
  sessionId: string,
  cache: DigestCache
): Promise<void> {
  if (!isSafePathSegment(agentId) || !isSafePathSegment(sessionId)) {
    return;
  }
  const cachePath = join(baseDir, "agents", agentId, "sessions", `${sessionId}.digest.json`);
  try {
    await writeFile(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // Non-critical — cache miss next time is fine
  }
}

// ---------------------------------------------------------------------------
// Turn → LiveActivityItem mapping
// ---------------------------------------------------------------------------

function turnToActivity(
  turn: SessionTurn,
  session: LocalSession,
  cachedSummary: string | null,
  index: number
): LiveActivityItem {
  const agentLabel = session.agentName ?? session.agentId ?? "OpenClaw";
  const summary = cachedSummary ?? summarizeTurn(turn, agentLabel);

  // Determine activity type
  let type: LiveActivityItem["type"] = "delegation";
  if (turn.errorMessage) {
    type = "run_failed";
  } else if (turn.toolNames.length > 0) {
    type = "artifact_created";
  }

  // Build title
  let title: string;
  if (turn.userPrompt && turn.toolNames.length === 0 && !turn.assistantResponse) {
    // Standalone user prompt
    title = summary;
  } else {
    title = summary;
  }

  const modelAlias = humanizeModelShort(turn.model ?? session.model ?? null);

  return {
    id: `local:turn:${turn.id}:${index}`,
    type,
    title,
    description: modelAlias,
    agentId: session.agentId,
    agentName: session.agentName,
    runId: session.sessionId ?? session.key,
    initiativeId: session.agentId ? `agent:${session.agentId}` : null,
    timestamp: turn.timestamp,
    summary: turn.assistantResponse
      ? turn.assistantResponse
      : null,
    metadata: {
      source: "local_openclaw",
      sessionKey: session.key,
      turnId: turn.id,
      toolNames: turn.toolNames.length > 0 ? turn.toolNames : undefined,
      eventCount: turn.eventCount,
      costTotal: turn.costTotal > 0 ? Math.round(turn.costTotal * 10000) / 10000 : undefined,
    },
  };
}

/** Quick model alias for descriptions */
function humanizeModelShort(model: string | null): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";
  if (lower.includes("kimi")) return "Kimi";
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("gpt-4")) return "GPT-4";
  if (lower.includes("qwen")) return "Qwen";
  // Strip provider prefix for others
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

// ---------------------------------------------------------------------------
// Main activity builder (turn-based)
// ---------------------------------------------------------------------------

export async function toLocalLiveActivity(
  snapshot: LocalOpenClawSnapshot,
  limit = 200
): Promise<{ activities: LiveActivityItem[]; total: number }> {
  const baseDir = join(homedir(), ".openclaw");
  const nowMs = Date.now();
  const recentCutoff = nowMs - JSONL_RECENT_WINDOW_MS;
  const totalCap = Math.min(limit, MAX_TOTAL_TURNS);

  const allActivities: LiveActivityItem[] = [];
  const defaultAgentId = coerceSafePathSegment(
    snapshot.sessions.find((s) => s.agentId)?.agentId ?? "main",
    "main"
  );

  for (const session of snapshot.sessions) {
    if (allActivities.length >= totalCap) break;

    const hasSessionFile = Boolean(session.sessionId);
    const isRecent = session.updatedAtMs >= recentCutoff;

    if (hasSessionFile && isRecent) {
      const agentId = coerceSafePathSegment(session.agentId ?? defaultAgentId, defaultAgentId);
      const remaining = totalCap - allActivities.length;
      const perSessionCap = Math.min(MAX_TURNS_PER_SESSION, remaining);

      // Read events and group into turns
      const events = await readSessionEvents(session, baseDir, agentId, MAX_RAW_EVENTS);
      const turns = groupEventsIntoTurns(events, perSessionCap);

      if (turns.length === 0) {
        allActivities.push(makeSessionSummaryItem(session));
        continue;
      }

      // Check digest cache for pre-computed summaries
      let cache = await readDigestCache(baseDir, agentId, session.sessionId!);
      const cachedMap = new Map<string, string>();
      if (cache) {
        for (const entry of cache.entries) {
          cachedMap.set(entry.turnId, entry.summary);
        }
      }

      // Build activity items from turns (most recent first)
      const newCacheEntries: DigestEntry[] = [];
      for (let i = turns.length - 1; i >= 0 && allActivities.length < totalCap; i--) {
        const turn = turns[i];
        const cached = cachedMap.get(turn.id) ?? null;
        const agentLabel = session.agentName ?? session.agentId ?? "OpenClaw";
        const computedSummary = summarizeTurn(turn, agentLabel);
        const fallbackSummary = isDigestSummaryStale(cached, computedSummary)
          ? computedSummary
          : (cached as string);

        allActivities.push(turnToActivity(turn, session, fallbackSummary, i));

        // Track for cache
        if (isDigestSummaryStale(cached, computedSummary)) {
          newCacheEntries.push({ turnId: turn.id, summary: fallbackSummary });
        }
      }

      // Update digest cache if we have new entries
      if (newCacheEntries.length > 0) {
        const byTurn = new Map<string, DigestEntry>();
        for (const entry of cache?.entries ?? []) {
          byTurn.set(entry.turnId, entry);
        }
        for (const entry of newCacheEntries) {
          byTurn.set(entry.turnId, entry);
        }
        const updatedEntries = Array.from(byTurn.values());
        await writeDigestCache(baseDir, agentId, session.sessionId!, {
          sessionId: session.sessionId!,
          updatedAtMs: nowMs,
          entries: updatedEntries,
        });
      }
    } else {
      allActivities.push(makeSessionSummaryItem(session));
    }
  }

  return {
    activities: allActivities,
    total: allActivities.length,
  };
}

export async function loadLocalTurnDetail(input: {
  turnId: string;
  sessionKey?: string | null;
  runId?: string | null;
}): Promise<{
  turnId: string;
  summary: string | null;
  userPrompt: string | null;
  timestamp: string | null;
  model: string | null;
} | null> {
  const turnId = input.turnId.trim();
  if (!turnId) return null;

  const sessionKey = input.sessionKey?.trim() || null;
  const runId = input.runId?.trim() || null;

  const snapshot = await loadLocalOpenClawSnapshot(400);
  const session = snapshot.sessions.find((candidate) => {
    if (sessionKey && candidate.key === sessionKey) return true;
    if (!runId) return false;
    return candidate.sessionId === runId || candidate.key === runId;
  });
  if (!session || !session.sessionId) return null;

  const baseDir = join(homedir(), ".openclaw");
  const defaultAgentId = coerceSafePathSegment(
    snapshot.sessions.find((s) => s.agentId)?.agentId ?? "main",
    "main"
  );
  const agentId = coerceSafePathSegment(session.agentId ?? defaultAgentId, defaultAgentId);

  const events = await readSessionEvents(
    session,
    baseDir,
    agentId,
    MAX_RAW_EVENTS_DETAIL
  );
  const turns = groupEventsIntoTurns(events, Math.max(MAX_TURNS_PER_SESSION * 10, 400), {
    assistantTextMaxChars: 0,
  });
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn) return null;

  return {
    turnId: turn.id,
    summary: turn.assistantResponse,
    userPrompt: turn.userPrompt,
    timestamp: turn.timestamp ?? null,
    model: turn.model,
  };
}

function makeSessionSummaryItem(session: LocalSession): LiveActivityItem {
  const type: LiveActivityItem["type"] = session.abortedLastRun
    ? "run_failed"
    : deriveSessionStatus(session) === "running"
      ? "run_started"
      : "delegation";

  const modelAlias = humanizeModelShort(
    [session.modelProvider, session.model].filter(Boolean).join("/") || null
  );

  return {
    id: `local:${session.key}:${session.updatedAtMs}`,
    type,
    title:
      type === "run_failed"
        ? `Session failed: ${session.displayName}`
        : type === "run_started"
          ? `Session active: ${session.displayName}`
          : `Session update: ${session.displayName}`,
    description: modelAlias ? `Local session (${modelAlias})` : "Local session",
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
