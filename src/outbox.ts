/**
 * Local event outbox for offline/disconnected mode.
 * Buffers structured OrgX events when cloud API is unreachable.
 * Events are flushed on next successful sync.
 */

import { join } from "node:path";
import {
  readFile,
  writeFile,
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
  // Stored as JSON for offline replay. Keep stable and additive.
  type: "progress" | "decision" | "artifact" | "changeset" | "retro" | "outcome";
  timestamp: string;
  payload: Record<string, unknown>;
  /** Converted to a LiveActivityItem for dashboard display. */
  activityItem: LiveActivityItem;
  /** Internal replay diagnostics for bounded retry/dead-letter handling. */
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

/** Events older than 7 days are stale — sync will never recover them. */
const OUTBOX_EVENT_TTL_MS = 7 * 24 * 60 * 60_000;
/** Hard cap per session to prevent unbounded growth if sync repeatedly fails. */
const OUTBOX_MAX_EVENTS_PER_SESSION = 500;
const DEAD_LETTER_DIRNAME = "_dead-letter";

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
  // Preserve the corrupted file for debugging, but move it out of the hot path.
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const backupPath = `${targetPath}.corrupt.${suffix}`;
  try {
    await rename(targetPath, backupPath);
    await hardenPath(backupPath, 0o600);
  } catch {
    // best effort
  }
}

async function writeFileAtomic(
  targetPath: string,
  content: string,
  mode: number
): Promise<void> {
  // Atomic write to avoid partial JSON files if we crash mid-write.
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID().slice(
    0,
    8
  )}`;
  await writeFile(tmpPath, content, { encoding: "utf8", mode });
  await hardenPath(tmpPath, mode);
  try {
    await rename(tmpPath, targetPath);
  } catch (err: unknown) {
    // On Windows, rename can fail if the destination exists. Best-effort fallback:
    // remove the destination and retry. This is not strictly atomic, but avoids
    // leaving the outbox unreadable.
    const code = err && typeof err === "object" ? (err as any).code : null;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      try {
        await unlink(targetPath);
      } catch {
        // ignore
      }
      await rename(tmpPath, targetPath);
    } else {
      throw err;
    }
  }
  await hardenPath(targetPath, mode);
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
  const droppedAt = new Date().toISOString();
  await appendOutboxDeadLetterRecord(sessionId, {
    droppedAt,
    queueId: normalizeSessionId(sessionId),
    reason,
    error: error ?? null,
    event,
  });
}

/** Drop stale events and enforce per-session cap. Returns true if any were removed. */
function pruneOutboxEvents(events: OutboxEvent[]): { pruned: OutboxEvent[]; changed: boolean } {
  const cutoff = Date.now() - OUTBOX_EVENT_TTL_MS;
  const fresh = events.filter((e) => {
    const epoch = Date.parse(e.timestamp);
    return Number.isFinite(epoch) && epoch >= cutoff;
  });
  // Keep newest events if over cap.
  const capped = fresh.length > OUTBOX_MAX_EVENTS_PER_SESSION
    ? fresh.slice(fresh.length - OUTBOX_MAX_EVENTS_PER_SESSION)
    : fresh;
  return { pruned: capped, changed: capped.length !== events.length };
}

export async function readOutbox(sessionId: string): Promise<OutboxEvent[]> {
  const targetPath = outboxPath(sessionId);
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const events = Array.isArray(parsed) ? (parsed as OutboxEvent[]) : [];
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
          sessionId,
          event,
          `pruned_on_read:${skipReason}`,
          null
        );
      }
      // Write back if stale events were dropped.
      if (filteredChanged) {
        if (filtered.length === 0) {
          try { await unlink(targetPath); } catch { /* ok */ }
        } else {
          await writeFileAtomic(targetPath, JSON.stringify(filtered), 0o600);
        }
      }
      return filtered;
    } catch {
      await backupCorruptOutboxFile(targetPath);
      return [];
    }
  } catch {
    return [];
  }
}

export async function appendToOutbox(
  sessionId: string,
  event: OutboxEvent
): Promise<void> {
  const skipReason = classifyOutboxReplaySkip(event);
  if (skipReason) {
    await appendOutboxDeadLetter(
      sessionId,
      event,
      `suppressed_on_append:${skipReason}`,
      null
    );
    return;
  }

  await ensureDir();
  const targetPath = outboxPath(sessionId);
  const existing = await readOutbox(sessionId);
  const idx = existing.findIndex((item) => item.id === event.id);
  if (idx >= 0) {
    existing[idx] = event;
  } else {
    existing.push(event);
  }
  await writeFileAtomic(targetPath, JSON.stringify(existing), 0o600);
}

export async function replaceOutbox(
  sessionId: string,
  events: OutboxEvent[]
): Promise<void> {
  await ensureDir();
  const targetPath = outboxPath(sessionId);
  if (events.length === 0) {
    try {
      await unlink(targetPath);
      return;
    } catch {
      // File may not exist
      return;
    }
  }
  await writeFileAtomic(targetPath, JSON.stringify(events), 0o600);
}

export async function readAllOutboxItems(): Promise<LiveActivityItem[]> {
  try {
    await ensureDir();
    const files = await readdir(outboxDir());
    const items: LiveActivityItem[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = file.slice(0, -5);
      try {
        const events = await readOutbox(sessionId);
        for (const evt of events) {
          items.push(evt.activityItem);
        }
      } catch {
        // skip malformed files
      }
    }
    return items.sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
    );
  } catch {
    return [];
  }
}

export async function readOutboxSummary(): Promise<OutboxSummary> {
  try {
    await ensureDir();
    const files = await readdir(outboxDir());
    const pendingByQueue: Record<string, number> = {};
    let pendingTotal = 0;
    let oldestEpoch = Number.POSITIVE_INFINITY;
    let newestEpoch = Number.NEGATIVE_INFINITY;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const queueId = file.slice(0, -5);
      try {
        const events = await readOutbox(queueId);
        const count = Array.isArray(events) ? events.length : 0;
        pendingByQueue[queueId] = count;
        pendingTotal += count;
        for (const event of events) {
          const epoch = Date.parse(event.timestamp);
          if (!Number.isFinite(epoch)) continue;
          oldestEpoch = Math.min(oldestEpoch, epoch);
          newestEpoch = Math.max(newestEpoch, epoch);
        }
      } catch {
        pendingByQueue[queueId] = pendingByQueue[queueId] ?? 0;
      }
    }

    return {
      pendingTotal,
      pendingByQueue,
      oldestEventAt: Number.isFinite(oldestEpoch)
        ? new Date(oldestEpoch).toISOString()
        : null,
      newestEventAt: Number.isFinite(newestEpoch)
        ? new Date(newestEpoch).toISOString()
        : null,
    };
  } catch {
    return {
      pendingTotal: 0,
      pendingByQueue: {},
      oldestEventAt: null,
      newestEventAt: null,
    };
  }
}

export async function clearOutbox(sessionId: string): Promise<void> {
  try {
    await unlink(outboxPath(sessionId));
  } catch {
    // File may not exist
  }
}
