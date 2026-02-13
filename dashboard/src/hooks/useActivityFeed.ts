import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveActivityItem } from '@/types';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { cutoffEpochForActivityFilter, sinceIsoForActivityFilter } from '@/lib/activityTimeFilters';

type ActivityPageResponse = {
  activities: LiveActivityItem[];
  nextCursor: string | null;
  total: number;
  storeUpdatedAt: string;
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareActivity(a: LiveActivityItem, b: LiveActivityItem): number {
  const delta = toEpoch(b.timestamp) - toEpoch(a.timestamp);
  if (delta !== 0) return delta;
  return String(b.id).localeCompare(String(a.id));
}

function encodeCursor(beforeEpoch: number, beforeId: string): string {
  const json = JSON.stringify({ beforeEpoch, beforeId });
  const base64 = btoa(unescape(encodeURIComponent(json)));
  // Avoid String.prototype.replaceAll (tsconfig lib may not include ES2021).
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+/g, '');
}

function seedCursor(items: LiveActivityItem[]): string | null {
  if (!items || items.length === 0) return null;
  const last = items[items.length - 1];
  const epoch = toEpoch(last.timestamp);
  if (!epoch) return null;
  return encodeCursor(epoch, String(last.id));
}

function normalizeSeed(
  items: LiveActivityItem[],
  cutoffEpoch: number | null,
  runId: string | null
): LiveActivityItem[] {
  const byId = new Map<string, LiveActivityItem>();
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string') continue;
    if (runId && item.runId !== runId) continue;
    const epoch = toEpoch(item.timestamp);
    if (!epoch) continue;
    if (cutoffEpoch !== null && epoch < cutoffEpoch) continue;
    byId.set(item.id, item);
  }
  return Array.from(byId.values()).sort(compareActivity);
}

function mergeById(current: LiveActivityItem[], incoming: LiveActivityItem[]): LiveActivityItem[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, LiveActivityItem>();
  for (const item of current) byId.set(item.id, item);
  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      changed = true;
      continue;
    }
    if (
      existing.timestamp !== item.timestamp ||
      existing.type !== item.type ||
      existing.title !== item.title ||
      existing.description !== item.description ||
      existing.summary !== item.summary ||
      JSON.stringify(existing.metadata ?? null) !== JSON.stringify(item.metadata ?? null)
    ) {
      byId.set(item.id, item);
      changed = true;
    }
  }
  if (!changed) return current;
  return Array.from(byId.values()).sort(compareActivity);
}

export function useActivityFeed(options: {
  seed: LiveActivityItem[];
  timeFilterId: ActivityTimeFilterId;
  runId?: string | null;
  pageSize?: number;
}) {
  const { seed, timeFilterId, runId = null, pageSize = 200 } = options;

  const cutoffEpoch = useMemo(() => cutoffEpochForActivityFilter(timeFilterId), [timeFilterId]);
  const sinceIso = useMemo(() => sinceIsoForActivityFilter(timeFilterId), [timeFilterId]);
  const normalizedSeed = useMemo(
    () => normalizeSeed(seed, cutoffEpoch, runId),
    [seed, cutoffEpoch, runId]
  );

  const [items, setItems] = useState<LiveActivityItem[]>(normalizedSeed);
  const [cursor, setCursor] = useState<string | null>(() => seedCursor(normalizedSeed));
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storeUpdatedAt, setStoreUpdatedAt] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  // Reset when filter/run changes.
  useEffect(() => {
    setItems(normalizedSeed);
    setCursor(seedCursor(normalizedSeed));
    setError(null);
    setStoreUpdatedAt(null);
  }, [normalizedSeed, timeFilterId, runId]);

  // Merge in new seed items (SSE tail) without disturbing the paging cursor.
  useEffect(() => {
    setItems((prev) => mergeById(prev, normalizedSeed));
  }, [normalizedSeed]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    if (inFlightRef.current) return inFlightRef.current;
    setIsLoadingMore(true);

    const request = (async () => {
      try {
        const search = new URLSearchParams();
        search.set('limit', String(Math.max(1, Math.min(500, pageSize))));
        search.set('cursor', cursor);
        if (sinceIso) search.set('since', sinceIso);
        if (runId && runId.trim().length > 0) search.set('run', runId.trim());

        const resp = await fetch(`/orgx/api/live/activity/page?${search.toString()}`);
        const payload = (await resp.json().catch(() => null)) as ActivityPageResponse | null;
        if (!resp.ok || !payload) {
          throw new Error(`Activity paging failed (${resp.status})`);
        }

        const nextItems = Array.isArray(payload.activities) ? payload.activities : [];
        setItems((prev) => mergeById(prev, nextItems));
        setCursor(payload.nextCursor ?? null);
        setStoreUpdatedAt(payload.storeUpdatedAt ?? null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Activity paging failed');
      } finally {
        setIsLoadingMore(false);
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = request;
    return request;
  }, [cursor, pageSize, runId, sinceIso]);

  const hasMore = cursor !== null;

  return {
    items,
    hasMore,
    isLoadingMore,
    error,
    storeUpdatedAt,
    loadMore,
    cutoffEpoch,
    sinceIso,
  };
}
