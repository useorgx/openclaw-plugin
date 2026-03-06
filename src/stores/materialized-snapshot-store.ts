import { parseJsonSafe } from "./json-store.js";
import { getStateDb } from "./sqlite-state.js";

export type MaterializedSnapshotEntry = {
  cacheKey: string;
  generation: number;
  expiresAt: number;
  updatedAt: string;
  payload: Record<string, unknown>;
};

const MEMORY_CACHE_MAX = 160;

const memoryCache = new Map<string, MaterializedSnapshotEntry>();

function setMemoryEntry(entry: MaterializedSnapshotEntry): void {
  memoryCache.set(entry.cacheKey, entry);
  if (memoryCache.size <= MEMORY_CACHE_MAX) return;
  const oldestKey = memoryCache.keys().next().value as string | undefined;
  if (oldestKey) memoryCache.delete(oldestKey);
}

function rowToEntry(row: {
  cache_key: string;
  generation: number;
  expires_at: number;
  updated_at: string;
  payload_json: string;
} | null | undefined): MaterializedSnapshotEntry | null {
  if (!row) return null;
  const payload = parseJsonSafe<Record<string, unknown>>(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return {
    cacheKey: row.cache_key,
    generation: Number(row.generation) || 0,
    expiresAt: Number(row.expires_at) || 0,
    updatedAt: row.updated_at,
    payload,
  };
}

export function readMaterializedSnapshot(
  cacheKey: string,
  input?: {
    allowStale?: boolean;
    generation?: number;
    nowMs?: number;
  }
): Record<string, unknown> | null {
  const normalizedKey = cacheKey.trim();
  if (!normalizedKey) return null;
  const allowStale = Boolean(input?.allowStale);
  const generation = input?.generation ?? 0;
  const nowMs = input?.nowMs ?? Date.now();

  const cached = memoryCache.get(normalizedKey) ?? null;
  if (cached) {
    if (
      allowStale ||
      (cached.generation === generation && cached.expiresAt > nowMs)
    ) {
      return cached.payload;
    }
    memoryCache.delete(normalizedKey);
  }

  const row = getStateDb()
    .prepare<
      [string],
      {
        cache_key: string;
        generation: number;
        expires_at: number;
        updated_at: string;
        payload_json: string;
      }
    >(
      `SELECT cache_key, generation, expires_at, updated_at, payload_json
       FROM materialized_snapshots
       WHERE cache_key = ?`
    )
    .get(normalizedKey);
  const entry = rowToEntry(row);
  if (!entry) return null;
  if (!allowStale && (entry.generation !== generation || entry.expiresAt <= nowMs)) {
    return null;
  }
  setMemoryEntry(entry);
  return entry.payload;
}

export function writeMaterializedSnapshot(
  cacheKey: string,
  payload: Record<string, unknown>,
  input: {
    generation: number;
    ttlMs: number;
    nowMs?: number;
  }
): void {
  const normalizedKey = cacheKey.trim();
  if (!normalizedKey) return;
  const nowMs = input.nowMs ?? Date.now();
  const updatedAt = new Date(nowMs).toISOString();
  const expiresAt = nowMs + Math.max(250, input.ttlMs);
  const entry: MaterializedSnapshotEntry = {
    cacheKey: normalizedKey,
    generation: input.generation,
    expiresAt,
    updatedAt,
    payload,
  };

  getStateDb()
    .prepare<[string, number, number, string, string]>(
      `INSERT INTO materialized_snapshots (
         cache_key,
         generation,
         expires_at,
         updated_at,
         payload_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         generation = excluded.generation,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at,
         payload_json = excluded.payload_json`
    )
    .run(
      normalizedKey,
      entry.generation,
      entry.expiresAt,
      entry.updatedAt,
      JSON.stringify(payload)
    );

  getStateDb()
    .prepare<[number]>(
      "DELETE FROM materialized_snapshots WHERE expires_at <= ?"
    )
    .run(nowMs - 1);
  setMemoryEntry(entry);
}

export function clearMaterializedSnapshotMemory(): void {
  memoryCache.clear();
}
