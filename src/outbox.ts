/**
 * Local event outbox for offline/disconnected mode.
 * Buffers structured OrgX events when cloud API is unreachable.
 * Events are flushed on next successful sync.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { LiveActivityItem } from "./types.js";

const OUTBOX_DIR = join(homedir(), ".openclaw", "orgx-outbox");

export interface OutboxEvent {
  id: string;
  type: "progress" | "decision" | "artifact";
  timestamp: string;
  payload: Record<string, unknown>;
  /** Converted to a LiveActivityItem for dashboard display. */
  activityItem: LiveActivityItem;
}

async function ensureDir(): Promise<void> {
  try {
    await mkdir(OUTBOX_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

function outboxPath(sessionId: string): string {
  return join(OUTBOX_DIR, `${sessionId}.json`);
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
  const existing = await readOutbox(sessionId);
  existing.push(event);
  await writeFile(outboxPath(sessionId), JSON.stringify(existing, null, 2), "utf8");
}

export async function replaceOutbox(
  sessionId: string,
  events: OutboxEvent[]
): Promise<void> {
  await ensureDir();
  if (events.length === 0) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(outboxPath(sessionId));
      return;
    } catch {
      // File may not exist
      return;
    }
  }
  await writeFile(outboxPath(sessionId), JSON.stringify(events, null, 2), "utf8");
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

export async function clearOutbox(sessionId: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(outboxPath(sessionId));
  } catch {
    // File may not exist
  }
}
