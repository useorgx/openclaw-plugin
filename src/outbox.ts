/**
 * Local event outbox for offline/disconnected mode.
 * Buffers structured OrgX events when cloud API is unreachable.
 * Events are flushed on next successful sync.
 */

import { join } from "node:path";
import {
  readFile,
  mkdir,
  chmod,
  rename,
  unlink,
  readdir,
  appendFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { LiveActivityItem } from "./types.js";
import { classifyOutboxReplaySkip } from "./event-sanitization.js";

import { getOrgxOutboxDir } from "./paths.js";
import {
  getStateDb,
  readStateMeta,
  writeStateMeta,
} from "./stores/sqlite-state.js";

function outboxDir(): string {
  return getOrgxOutboxDir();
}

function isSafeOutboxSessionId(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === "..") return false;
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    return false;
  }
  if (normalized.includes("..")) return false;
  return true;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!isSafeOutboxSessionId(normalized)) {
    throw new Error("Invalid outbox session identifier");
  }
  return normalized;
}

async function hardenPath(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // best effort
  }
}

export interface OutboxEvent {
  id: string;
  type: "progress" | "decision" | "artifact" | "changeset" | "retro" | "outcome";
  timestamp: string;
  payload: Record<string, unknown>;
  activityItem: LiveActivityItem;
  replayFailures?: number;
  lastReplayError?: string | null;
  lastReplayAt?: string | null;
}

export interface OutboxSummary {
  pendingTotal: number;
  pendingByQueue: Record<string, number>;
  oldestEventAt: string | null;
  newestEventAt: string | null;
}

type OutboxRow = {
  queue_id: string;
  event_id: string;
  event_type: OutboxEvent["type"];
  timestamp: string;
  payload_json: string;
  activity_item_json: string;
  replay_failures: number | null;
  last_replay_error: string | null;
  last_replay_at: string | null;
};

/** Events older than 7 days are stale — sync will never recover them. */
const OUTBOX_EVENT_TTL_MS = 7 * 24 * 60 * 60_000;
/** Hard cap per session to prevent unbounded growth if sync repeatedly fails. */
const OUTBOX_MAX_EVENTS_PER_SESSION = 500;
const DEAD_LETTER_DIRNAME = "_dead-letter";
const OUTBOX_IMPORT_META_KEY = "outbox_events_imported_v1";

async function ensureDir(): Promise<void> {
  const dir = outboxDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await hardenPath(dir, 0o700);
  } catch {
    // Directory may already exist
  }
}

function deadLetterDir(): string {
  return join(outboxDir(), DEAD_LETTER_DIRNAME);
}

function deadLetterPath(sessionId: string): string {
  return join(deadLetterDir(), `${normalizeSessionId(sessionId)}.jsonl`);
}

function outboxPath(sessionId: string): string {
  return join(outboxDir(), `${normalizeSessionId(sessionId)}.json`);
}

async function backupCorruptOutboxFile(targetPath: string): Promise<void> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const backupPath = `${targetPath}.corrupt.${suffix}`;
  try {
    await rename(targetPath, backupPath);
    await hardenPath(backupPath, 0o600);
  } catch {
    // best effort
  }
}

async function appendOutboxDeadLetterRecord(
  sessionId: string,
  record: Record<string, unknown>
): Promise<void> {
  await ensureDir();
  const dir = deadLetterDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await hardenPath(dir, 0o700);
  const targetPath = deadLetterPath(sessionId);
  await appendFile(targetPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await hardenPath(targetPath, 0o600);
}

export async function appendOutboxDeadLetter(
  sessionId: string,
  event: OutboxEvent,
  reason: string,
  error?: string | null
): Promise<void> {
  let normalizedSessionId: string;
  try {
    normalizedSessionId = normalizeSessionId(sessionId);
  } catch {
    return;
  }
  const droppedAt = new Date().toISOString();
  await appendOutboxDeadLetterRecord(normalizedSessionId, {
    droppedAt,
    queueId: normalizedSessionId,
    reason,
    error: error ?? null,
    event,
  });
}

function normalizeOutboxEvent(input: OutboxEvent): OutboxEvent {
  const timestamp =
    typeof input.timestamp === "string" && Number.isFinite(Date.parse(input.timestamp))
      ? new Date(Date.parse(input.timestamp)).toISOString()
      : new Date().toISOString();
  return {
    id: input.id.trim(),
    type: input.type,
    timestamp,
    payload:
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? input.payload
        : {},
    activityItem: input.activityItem,
    replayFailures:
      typeof input.replayFailures === "number" && Number.isFinite(input.replayFailures)
        ? Math.max(0, Math.floor(input.replayFailures))
        : undefined,
    lastReplayError:
      typeof input.lastReplayError === "string" ? input.lastReplayError : input.lastReplayError ?? null,
    lastReplayAt:
      typeof input.lastReplayAt === "string" && Number.isFinite(Date.parse(input.lastReplayAt))
        ? new Date(Date.parse(input.lastReplayAt)).toISOString()
        : input.lastReplayAt ?? null,
  };
}

/** Drop stale events and enforce per-session cap. Returns true if any were removed. */
function pruneOutboxEvents(events: OutboxEvent[]): { pruned: OutboxEvent[]; changed: boolean } {
  const cutoff = Date.now() - OUTBOX_EVENT_TTL_MS;
  const fresh = events.filter((e) => {
    const epoch = Date.parse(e.timestamp);
    return Number.isFinite(epoch) && epoch >= cutoff;
  });
  const capped =
    fresh.length > OUTBOX_MAX_EVENTS_PER_SESSION
      ? fresh.slice(fresh.length - OUTBOX_MAX_EVENTS_PER_SESSION)
      : fresh;
  return { pruned: capped, changed: capped.length !== events.length };
}

function rowToEvent(row: OutboxRow): OutboxEvent | null {
  const payload =
    row.payload_json && typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json)
      : {};
  const activityItem =
    row.activity_item_json && typeof row.activity_item_json === "string"
      ? JSON.parse(row.activity_item_json)
      : null;
  if (!activityItem || typeof activityItem !== "object") return null;
  return normalizeOutboxEvent({
    id: row.event_id,
    type: row.event_type,
    timestamp: row.timestamp,
    payload:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
    activityItem: activityItem as LiveActivityItem,
    replayFailures: typeof row.replay_failures === "number" ? row.replay_failures : undefined,
    lastReplayError: row.last_replay_error,
    lastReplayAt: row.last_replay_at,
  });
}

function writeOutboxEvents(queueId: string, events: OutboxEvent[]): void {
  const normalizedQueueId = normalizeSessionId(queueId);
  const transaction = getStateDb().transaction((items: OutboxEvent[]) => {
    getStateDb()
      .prepare<[string]>("DELETE FROM outbox_events WHERE queue_id = ?")
      .run(normalizedQueueId);
    const insertStatement = getStateDb().prepare<
      [
        string,
        string,
        OutboxEvent["type"],
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string
      ]
    >(
      `INSERT INTO outbox_events (
         event_id,
         queue_id,
         event_type,
         timestamp,
         payload_json,
         activity_item_json,
         replay_failures,
         last_replay_error,
         last_replay_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const nowIso = new Date().toISOString();
    for (const event of items) {
      const normalized = normalizeOutboxEvent(event);
      insertStatement.run(
        normalized.id,
        normalizedQueueId,
        normalized.type,
        normalized.timestamp,
        JSON.stringify(normalized.payload ?? {}),
        JSON.stringify(normalized.activityItem),
        normalized.replayFailures ?? 0,
        normalized.lastReplayError ?? null,
        normalized.lastReplayAt ?? null,
        nowIso
      );
    }
  });
  transaction(events);
}

async function readLegacyOutboxFile(queueId: string): Promise<OutboxEvent[]> {
  const targetPath = outboxPath(queueId);
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const events = Array.isArray(parsed) ? (parsed as OutboxEvent[]) : [];
      return events.map((event) => normalizeOutboxEvent(event));
    } catch {
      await backupCorruptOutboxFile(targetPath);
      return [];
    }
  } catch {
    return [];
  }
}

async function ensureOutboxMigrated(): Promise<void> {
  const migrated = readStateMeta<boolean>(OUTBOX_IMPORT_META_KEY);
  if (migrated) return;

  const countRow = getStateDb()
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM outbox_events")
    .get();
  if ((countRow?.count ?? 0) > 0) {
    writeStateMeta(OUTBOX_IMPORT_META_KEY, true);
    return;
  }

  await ensureDir();
  const files = await readdir(outboxDir()).catch(() => []);
  const queueIds = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter(Boolean);
  for (const queueId of queueIds) {
    const events = await readLegacyOutboxFile(queueId);
    if (events.length === 0) continue;
    writeOutboxEvents(queueId, events);
  }
  writeStateMeta(OUTBOX_IMPORT_META_KEY, true);
}

function pruneQueueRows(queueId: string): void {
  const normalizedQueueId = normalizeSessionId(queueId);
  const cutoffIso = new Date(Date.now() - OUTBOX_EVENT_TTL_MS).toISOString();
  getStateDb()
    .prepare<[string, string]>(
      `DELETE FROM outbox_events
       WHERE queue_id = ?
         AND timestamp < ?`
    )
    .run(normalizedQueueId, cutoffIso);
  getStateDb()
    .prepare<[string, string, number]>(
      `DELETE FROM outbox_events
       WHERE queue_id = ?
         AND event_id NOT IN (
           SELECT event_id
           FROM outbox_events
           WHERE queue_id = ?
           ORDER BY timestamp DESC, updated_at DESC
           LIMIT ?
         )`
    )
    .run(normalizedQueueId, normalizedQueueId, OUTBOX_MAX_EVENTS_PER_SESSION);
}

export async function readOutbox(sessionId: string): Promise<OutboxEvent[]> {
  let normalizedSessionId: string;
  try {
    normalizedSessionId = normalizeSessionId(sessionId);
  } catch {
    return [];
  }

  await ensureOutboxMigrated();
  const rows = getStateDb()
    .prepare<[string], OutboxRow>(
      `SELECT
         queue_id,
         event_id,
         event_type,
         timestamp,
         payload_json,
         activity_item_json,
         replay_failures,
         last_replay_error,
         last_replay_at
       FROM outbox_events
       WHERE queue_id = ?
       ORDER BY timestamp ASC, event_id ASC`
    )
    .all(normalizedSessionId);

  const events: OutboxEvent[] = [];
  for (const row of rows) {
    try {
      const event = rowToEvent(row);
      if (event) events.push(event);
    } catch {
      // skip malformed rows
    }
  }

  const { pruned, changed } = pruneOutboxEvents(events);
  const filtered: OutboxEvent[] = [];
  let filteredChanged = changed;
  for (const event of pruned) {
    const skipReason = classifyOutboxReplaySkip(event);
    if (!skipReason) {
      filtered.push(event);
      continue;
    }
    filteredChanged = true;
    await appendOutboxDeadLetter(
      normalizedSessionId,
      event,
      `pruned_on_read:${skipReason}`,
      null
    );
  }

  if (filteredChanged) {
    await replaceOutbox(normalizedSessionId, filtered);
  }
  return filtered;
}

export async function appendToOutbox(
  sessionId: string,
  event: OutboxEvent
): Promise<void> {
  let normalizedSessionId: string;
  try {
    normalizedSessionId = normalizeSessionId(sessionId);
  } catch {
    return;
  }

  const normalizedEvent = normalizeOutboxEvent(event);
  const skipReason = classifyOutboxReplaySkip(normalizedEvent);
  if (skipReason) {
    await appendOutboxDeadLetter(
      normalizedSessionId,
      normalizedEvent,
      `suppressed_on_append:${skipReason}`,
      null
    );
    return;
  }

  await ensureOutboxMigrated();
  const nowIso = new Date().toISOString();
  getStateDb()
    .prepare<
      [
        string,
        string,
        OutboxEvent["type"],
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string
      ]
    >(
      `INSERT INTO outbox_events (
         event_id,
         queue_id,
         event_type,
         timestamp,
         payload_json,
         activity_item_json,
         replay_failures,
         last_replay_error,
         last_replay_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         queue_id = excluded.queue_id,
         event_type = excluded.event_type,
         timestamp = excluded.timestamp,
         payload_json = excluded.payload_json,
         activity_item_json = excluded.activity_item_json,
         replay_failures = excluded.replay_failures,
         last_replay_error = excluded.last_replay_error,
         last_replay_at = excluded.last_replay_at,
         updated_at = excluded.updated_at`
    )
    .run(
      normalizedEvent.id,
      normalizedSessionId,
      normalizedEvent.type,
      normalizedEvent.timestamp,
      JSON.stringify(normalizedEvent.payload ?? {}),
      JSON.stringify(normalizedEvent.activityItem),
      normalizedEvent.replayFailures ?? 0,
      normalizedEvent.lastReplayError ?? null,
      normalizedEvent.lastReplayAt ?? null,
      nowIso
    );
  pruneQueueRows(normalizedSessionId);
}

export async function replaceOutbox(
  sessionId: string,
  events: OutboxEvent[]
): Promise<void> {
  let normalizedSessionId: string;
  try {
    normalizedSessionId = normalizeSessionId(sessionId);
  } catch {
    return;
  }

  await ensureOutboxMigrated();
  if (events.length === 0) {
    getStateDb()
      .prepare<[string]>("DELETE FROM outbox_events WHERE queue_id = ?")
      .run(normalizedSessionId);
    try {
      await unlink(outboxPath(normalizedSessionId));
    } catch {
      // File may not exist
    }
    return;
  }

  writeOutboxEvents(normalizedSessionId, events);
  pruneQueueRows(normalizedSessionId);
}

export async function readAllOutboxItems(): Promise<LiveActivityItem[]> {
  await ensureOutboxMigrated();
  const rows = getStateDb()
    .prepare<[number], { activity_item_json: string }>(
      `SELECT activity_item_json
       FROM outbox_events
       ORDER BY timestamp DESC, event_id DESC
       LIMIT ?`
    )
    .all(10_000);
  const items: LiveActivityItem[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.activity_item_json) as LiveActivityItem;
      if (parsed && typeof parsed === "object") {
        items.push(parsed);
      }
    } catch {
      // skip malformed rows
    }
  }
  return items;
}

export async function readOutboxSummary(): Promise<OutboxSummary> {
  await ensureOutboxMigrated();
  const rows = getStateDb()
    .prepare<
      [],
      {
        queue_id: string;
        pending_count: number;
        oldest_event_at: string | null;
        newest_event_at: string | null;
      }
    >(
      `SELECT
         queue_id,
         COUNT(*) AS pending_count,
         MIN(timestamp) AS oldest_event_at,
         MAX(timestamp) AS newest_event_at
       FROM outbox_events
       GROUP BY queue_id`
    )
    .all();
  const pendingByQueue: Record<string, number> = {};
  let pendingTotal = 0;
  let oldestEventAt: string | null = null;
  let newestEventAt: string | null = null;
  for (const row of rows) {
    pendingByQueue[row.queue_id] = row.pending_count;
    pendingTotal += row.pending_count;
    if (row.oldest_event_at && (!oldestEventAt || row.oldest_event_at < oldestEventAt)) {
      oldestEventAt = row.oldest_event_at;
    }
    if (row.newest_event_at && (!newestEventAt || row.newest_event_at > newestEventAt)) {
      newestEventAt = row.newest_event_at;
    }
  }
  return {
    pendingTotal,
    pendingByQueue,
    oldestEventAt,
    newestEventAt,
  };
}

export async function clearOutbox(sessionId: string): Promise<void> {
  let normalizedSessionId: string;
  try {
    normalizedSessionId = normalizeSessionId(sessionId);
  } catch {
    return;
  }

  await ensureOutboxMigrated();
  getStateDb()
    .prepare<[string]>("DELETE FROM outbox_events WHERE queue_id = ?")
    .run(normalizedSessionId);

  try {
    await unlink(outboxPath(normalizedSessionId));
  } catch {
    // File may not exist
  }
}
