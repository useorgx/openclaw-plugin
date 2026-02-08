/**
 * Local event outbox for offline/disconnected mode.
 * Buffers structured OrgX events when cloud API is unreachable.
 * Events are flushed on next successful sync.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import type { LiveActivityItem } from "./types.js";

const OUTBOX_DIR = join(homedir(), ".openclaw", "orgx-outbox");

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
  type: "progress" | "decision" | "artifact" | "changeset";
  timestamp: string;
  payload: Record<string, unknown>;
  /** Converted to a LiveActivityItem for dashboard display. */
  activityItem: LiveActivityItem;
}

export interface OutboxSummary {
  pendingTotal: number;
  pendingByQueue: Record<string, number>;
  oldestEventAt: string | null;
  newestEventAt: string | null;
}

async function ensureDir(): Promise<void> {
  try {
    await mkdir(OUTBOX_DIR, { recursive: true, mode: 0o700 });
    await hardenPath(OUTBOX_DIR, 0o700);
  } catch {
    // Directory may already exist
  }
}

function outboxPath(sessionId: string): string {
  return join(OUTBOX_DIR, `${normalizeSessionId(sessionId)}.json`);
}

export async function readOutbox(sessionId: string): Promise<OutboxEvent[]> {
  try {
    const raw = await readFile(outboxPath(sessionId), "utf8");
    return JSON.parse(raw) as OutboxEvent[];
  } catch {
    return [];
  }
}

export async function appendToOutbox(
  sessionId: string,
  event: OutboxEvent
): Promise<void> {
  await ensureDir();
  const targetPath = outboxPath(sessionId);
  const existing = await readOutbox(sessionId);
  existing.push(event);
  await writeFile(targetPath, JSON.stringify(existing, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await hardenPath(targetPath, 0o600);
}

export async function replaceOutbox(
  sessionId: string,
  events: OutboxEvent[]
): Promise<void> {
  await ensureDir();
  const targetPath = outboxPath(sessionId);
  if (events.length === 0) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(targetPath);
      return;
    } catch {
      // File may not exist
      return;
    }
  }
  await writeFile(targetPath, JSON.stringify(events, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await hardenPath(targetPath, 0o600);
}

export async function readAllOutboxItems(): Promise<LiveActivityItem[]> {
  try {
    await ensureDir();
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(OUTBOX_DIR);
    const items: LiveActivityItem[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(OUTBOX_DIR, file), "utf8");
        const events = JSON.parse(raw) as OutboxEvent[];
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
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(OUTBOX_DIR);
    const pendingByQueue: Record<string, number> = {};
    let pendingTotal = 0;
    let oldestEpoch = Number.POSITIVE_INFINITY;
    let newestEpoch = Number.NEGATIVE_INFINITY;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const queueId = file.slice(0, -5);
      try {
        const raw = await readFile(join(OUTBOX_DIR, file), "utf8");
        const events = JSON.parse(raw) as OutboxEvent[];
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
    const { unlink } = await import("node:fs/promises");
    await unlink(outboxPath(sessionId));
  } catch {
    // File may not exist
  }
}
