import {
  existsSync,
  readFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";

import type { LiveActivityItem } from "./contracts/types.js";
import { enrichActivityActorFieldsList } from "./activity-actor-fields.js";
import { shouldHideActivityItem } from "./event-sanitization.js";
import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeFileAtomicSync } from "./fs-utils.js";
import { ensureStoreDirSync, parseJsonSafe } from "./stores/json-store.js";

type PersistedActivityStore = {
  version: 1;
  updatedAt: string;
  items: LiveActivityItem[];
};

export type ActivityPageCursor = {
  beforeEpoch: number;
  beforeId: string;
};

export type ListActivityPageParams = {
  limit: number;
  runId?: string | null;
  since?: string | null;
  until?: string | null;
  cursor?: string | null;
};

export type ListActivityPageResult = {
  activities: LiveActivityItem[];
  nextCursor: string | null;
  total: number;
  storeUpdatedAt: string;
};

const STORE_VERSION = 1 as const;
const STORE_FILENAME = "activity-store.json";
const MAX_ITEMS = 10_000;
const RETENTION_DAYS = 14;
const FLUSH_DEBOUNCE_MS = 3_000;

let cached: {
  storeUpdatedAt: string;
  items: LiveActivityItem[];
  byId: Map<string, LiveActivityItem>;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
} | null = null;

function ensureDir(): void {
  ensureStoreDirSync(getOrgxPluginConfigDir());
}

function storePath(): string {
  return getOrgxPluginConfigPath(STORE_FILENAME);
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shallowMetadataEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function compareActivity(a: LiveActivityItem, b: LiveActivityItem): number {
  const delta = toEpoch(b.timestamp) - toEpoch(a.timestamp);
  if (delta !== 0) return delta;
  // Deterministic tie-breaker for cursor paging.
  return String(b.id).localeCompare(String(a.id));
}

function activityString(meta: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function activityStringArray(meta: Record<string, unknown> | null | undefined, keys: string[]): string[] {
  if (!meta) return [];
  for (const key of keys) {
    const raw = meta[key];
    if (!Array.isArray(raw)) continue;
    const values = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return [];
}

function activitySemanticKey(item: LiveActivityItem): string {
  const meta =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : null;
  const bucket = Math.floor(toEpoch(item.timestamp) / 60_000);
  const event =
    activityString(meta, ["event", "event_name", "eventName"]) ??
    item.type ??
    "activity";
  const initiativeId =
    (typeof item.initiativeId === "string" && item.initiativeId.trim().length > 0
      ? item.initiativeId.trim()
      : null) ?? activityString(meta, ["initiative_id", "initiativeId"]);
  const workstreamId = activityString(meta, ["workstream_id", "workstreamId", "source_stream_id"]);
  const runId =
    (typeof item.runId === "string" && item.runId.trim().length > 0 ? item.runId.trim() : null) ??
    activityString(meta, ["run_id", "runId", "source_run_id", "session_id", "sessionId"]);
  const decisionIds = activityStringArray(meta, ["decision_ids", "decisionIds"]).slice(0, 3).join(",");
  const title =
    activityString(meta, ["decision_title", "task_title", "artifact_title", "title"]) ??
    (typeof item.title === "string" ? item.title.trim() : "");
  return [
    event.toLowerCase(),
    initiativeId ?? "",
    workstreamId ?? "",
    runId ?? "",
    decisionIds,
    title.toLowerCase(),
    String(bucket),
  ].join("|");
}

function normalizeItems(source: LiveActivityItem[]): LiveActivityItem[] {
  const now = Date.now();
  const cutoffEpoch = now - RETENTION_DAYS * 24 * 60 * 60_000;

  const byId = new Map<string, LiveActivityItem>();
  const bySemantic = new Map<string, LiveActivityItem>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    if (typeof (item as any).id !== "string") continue;
    const id = (item as any).id.trim();
    if (!id) continue;
    const ts = typeof (item as any).timestamp === "string" ? (item as any).timestamp : null;
    const epoch = toEpoch(ts);
    if (!epoch) continue;
    if (epoch < cutoffEpoch) continue;
    if (shouldHideActivityItem(item)) continue;
    const semanticKey = activitySemanticKey(item);
    const existingSemantic = bySemantic.get(semanticKey);
    if (existingSemantic) {
      if (compareActivity(item, existingSemantic) >= 0) {
        continue;
      }
      byId.delete(existingSemantic.id);
    }
    bySemantic.set(semanticKey, item);
    byId.set(id, item);
  }

  return enrichActivityActorFieldsList(Array.from(byId.values()))
    .sort(compareActivity)
    .slice(0, MAX_ITEMS);
}

function readPersistedStore(): PersistedActivityStore {
  ensureDir();
  const file = storePath();
  if (!existsSync(file)) {
    return { version: STORE_VERSION, updatedAt: new Date().toISOString(), items: [] };
  }

  try {
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedActivityStore>(raw);
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.items)) {
      backupCorruptFileSync(file);
      return { version: STORE_VERSION, updatedAt: new Date().toISOString(), items: [] };
    }
    return {
      version: STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      items: normalizeItems(parsed.items),
    };
  } catch {
    return { version: STORE_VERSION, updatedAt: new Date().toISOString(), items: [] };
  }
}

function ensureCache(): NonNullable<typeof cached> {
  if (cached) return cached;
  const persisted = readPersistedStore();
  const byId = new Map<string, LiveActivityItem>();
  for (const item of persisted.items) {
    byId.set(item.id, item);
  }
  cached = {
    storeUpdatedAt: persisted.updatedAt,
    items: persisted.items,
    byId,
    dirty: false,
    flushTimer: null,
  };
  return cached;
}

function encodeCursor(cursor: ActivityPageCursor): string {
  const payload = JSON.stringify(cursor);
  return Buffer.from(payload, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(raw: string | null | undefined): ActivityPageCursor | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as ActivityPageCursor;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Number.isFinite(parsed.beforeEpoch)) return null;
    if (typeof parsed.beforeId !== "string" || !parsed.beforeId.trim()) return null;
    return { beforeEpoch: parsed.beforeEpoch, beforeId: parsed.beforeId.trim() };
  } catch {
    return null;
  }
}

function scheduleFlush(state: NonNullable<typeof cached>): void {
  if (!state.dirty) return;
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    if (!state.dirty) return;
    state.dirty = false;
    state.storeUpdatedAt = new Date().toISOString();
    const payload: PersistedActivityStore = {
      version: STORE_VERSION,
      updatedAt: state.storeUpdatedAt,
      items: state.items,
    };
    writeFileAtomicSync(storePath(), JSON.stringify(payload), { mode: 0o600 });
  }, FLUSH_DEBOUNCE_MS);
  state.flushTimer.unref?.();
}

export function appendActivityItems(items: LiveActivityItem[]): { appended: number; updated: number; total: number } {
  if (!Array.isArray(items) || items.length === 0) {
    const state = ensureCache();
    return { appended: 0, updated: 0, total: state.items.length };
  }

  const state = ensureCache();
  let appended = 0;
  let updated = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id !== "string" || !item.id.trim()) continue;
    if (typeof item.timestamp !== "string" || !item.timestamp.trim()) continue;
    if (!Number.isFinite(Date.parse(item.timestamp))) continue;
    if (shouldHideActivityItem(item)) continue;

    const id = item.id.trim();
    const existing = state.byId.get(id);
    if (!existing) {
      state.byId.set(id, item);
      appended += 1;
      continue;
    }

    // Replace if any key fields differ; metadata/summary changes are real updates.
    if (
      existing.timestamp !== item.timestamp ||
      existing.type !== item.type ||
      existing.title !== item.title ||
      existing.description !== item.description ||
      (existing.requesterAgentId ?? null) !== (item.requesterAgentId ?? null) ||
      (existing.requesterAgentName ?? null) !== (item.requesterAgentName ?? null) ||
      (existing.executorAgentId ?? null) !== (item.executorAgentId ?? null) ||
      (existing.executorAgentName ?? null) !== (item.executorAgentName ?? null) ||
      (existing as any).summary !== (item as any).summary ||
      !shallowMetadataEqual((existing as any).metadata, (item as any).metadata)
    ) {
      state.byId.set(id, item);
      updated += 1;
    }
  }

  if (appended === 0 && updated === 0) {
    return { appended: 0, updated: 0, total: state.items.length };
  }

  // Rebuild via normalizeItems every time so semantic dedupe stays consistent.
  state.items = normalizeItems(Array.from(state.byId.values()));
  state.byId = new Map(state.items.map((item) => [item.id, item]));
  state.dirty = true;
  scheduleFlush(state);

  return { appended, updated, total: state.items.length };
}

export function listActivityPage(params: ListActivityPageParams): ListActivityPageResult {
  const state = ensureCache();
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit || 100)));

  const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : null;
  const sinceEpoch = params.since ? toEpoch(params.since) : 0;
  const untilEpoch = params.until ? toEpoch(params.until) : 0;
  const cursor = decodeCursor(params.cursor ?? null);

  const filtered: LiveActivityItem[] = [];
  for (const item of state.items) {
    const epoch = toEpoch(item.timestamp);
    if (!epoch) continue;
    if (sinceEpoch && epoch < sinceEpoch) continue;
    if (untilEpoch && epoch > untilEpoch) continue;

    if (runId) {
      const matchRunId = item.runId ?? ((item as any).metadata?.runId as string | undefined) ?? null;
      if (matchRunId !== runId) continue;
    }

    if (cursor) {
      if (epoch > cursor.beforeEpoch) continue;
      if (epoch === cursor.beforeEpoch && String(item.id) >= cursor.beforeId) continue;
    }

    filtered.push(item);
    if (filtered.length >= limit) break;
  }

  // Determine next cursor by checking if there is at least one more matching item after the last.
  let nextCursor: string | null = null;
  if (filtered.length === limit) {
    const last = filtered[filtered.length - 1];
    const beforeEpoch = toEpoch(last.timestamp);
    if (beforeEpoch) {
      nextCursor = encodeCursor({ beforeEpoch, beforeId: String(last.id) });
    }
  }

  return {
    activities: filtered,
    nextCursor,
    total: state.items.length,
    storeUpdatedAt: state.storeUpdatedAt,
  };
}

export function getActivityStoreStats(): { total: number; updatedAt: string } {
  const state = ensureCache();
  return { total: state.items.length, updatedAt: state.storeUpdatedAt };
}
