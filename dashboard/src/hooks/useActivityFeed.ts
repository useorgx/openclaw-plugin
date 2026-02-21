import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveActivityItem } from '@/types';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { cutoffEpochForActivityFilter, sinceIsoForActivityFilter } from '@/lib/activityTimeFilters';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readMetadataString(metadata: Record<string, unknown> | null, keys: string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function resolveInitiativeId(item: LiveActivityItem): string | null {
  const direct = typeof item.initiativeId === 'string' ? item.initiativeId.trim() : '';
  if (direct.length > 0) return direct;
  const metadata = asRecord(item.metadata);
  return readMetadataString(metadata, ['initiative_id', 'initiativeId']);
}

function normalizeSeed(
  items: LiveActivityItem[],
  bounds: { sinceEpoch: number | null; untilEpoch: number | null },
  runId: string | null,
  initiativeId: string | null
): LiveActivityItem[] {
  const byId = new Map<string, LiveActivityItem>();
  const sinceEpoch = bounds.sinceEpoch;
  const untilEpoch = bounds.untilEpoch;
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string') continue;
    if (runId && item.runId !== runId) continue;
    if (initiativeId && resolveInitiativeId(item) !== initiativeId) continue;
    const epoch = toEpoch(item.timestamp);
    if (!epoch) continue;
    if (sinceEpoch !== null && epoch < sinceEpoch) continue;
    if (untilEpoch !== null && epoch > untilEpoch) continue;
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
  customSinceIso?: string | null;
  customUntilIso?: string | null;
  runId?: string | null;
  initiativeId?: string | null;
  projectId?: string | null;
  pageSize?: number;
  demoMode?: boolean;
}) {
  const {
    seed,
    timeFilterId,
    customSinceIso = null,
    customUntilIso = null,
    runId = null,
    initiativeId = null,
    projectId = null,
    pageSize = 50,
    demoMode = isDemoModeEnabled(),
  } = options;

  const presetCutoffEpoch = useMemo(
    () => cutoffEpochForActivityFilter(timeFilterId),
    [timeFilterId]
  );
  const presetSinceIso = useMemo(
    () => sinceIsoForActivityFilter(timeFilterId),
    [timeFilterId]
  );
  const sinceIso = useMemo(() => {
    if (timeFilterId === 'custom') {
      const trimmed = customSinceIso?.trim() ?? '';
      return trimmed.length > 0 ? trimmed : null;
    }
    return presetSinceIso;
  }, [customSinceIso, presetSinceIso, timeFilterId]);
  const untilIso = useMemo(() => {
    if (timeFilterId !== 'custom') return null;
    const trimmed = customUntilIso?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  }, [customUntilIso, timeFilterId]);
  const sinceEpoch = useMemo(() => {
    if (sinceIso) {
      const parsed = Date.parse(sinceIso);
      if (Number.isFinite(parsed)) return parsed;
    }
    return presetCutoffEpoch;
  }, [presetCutoffEpoch, sinceIso]);
  const untilEpoch = useMemo(() => {
    if (!untilIso) return null;
    const parsed = Date.parse(untilIso);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }, [untilIso]);
  const normalizedSeed = useMemo(
    () =>
      normalizeSeed(
        seed,
        {
          sinceEpoch,
          untilEpoch,
        },
        runId,
        initiativeId
      ),
    [seed, sinceEpoch, untilEpoch, runId, initiativeId]
  );
  // Always bootstrap one page fetch on filter/run changes so wider windows
  // (e.g. Last hour -> Today) populate immediately without requiring scroll.
  const initialCursor: string | null = demoMode ? null : '';

  const [items, setItems] = useState<LiveActivityItem[]>(normalizedSeed);
  const [cursor, setCursor] = useState<string | null>(() => initialCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storeUpdatedAt, setStoreUpdatedAt] = useState<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const bootstrapAttemptedRef = useRef(false);

  // Reset when filter/run changes.
  useEffect(() => {
    setItems(normalizedSeed);
    setCursor(initialCursor);
    setError(null);
    setStoreUpdatedAt(null);
    bootstrapAttemptedRef.current = false;
  }, [initialCursor, initiativeId, normalizedSeed, projectId, runId, sinceIso, timeFilterId, untilIso]);

  // Merge in new seed items (SSE tail) without disturbing the paging cursor.
  useEffect(() => {
    setItems((prev) => mergeById(prev, normalizedSeed));
  }, [normalizedSeed]);

  const loadMore = useCallback(async () => {
    if (demoMode) {
      setCursor(null);
      setError(null);
      return;
    }
    if (cursor === null) return;
    if (inFlightRef.current) return inFlightRef.current;
    setIsLoadingMore(true);

    const request = (async () => {
      try {
        const search = new URLSearchParams();
        search.set('limit', String(Math.max(1, Math.min(500, pageSize))));
        if (cursor.trim().length > 0) search.set('cursor', cursor);
        if (sinceIso) search.set('since', sinceIso);
        if (untilIso) search.set('until', untilIso);
        if (runId && runId.trim().length > 0) search.set('run', runId.trim());
        if (initiativeId && initiativeId.trim().length > 0) {
          search.set('initiative', initiativeId.trim());
        }
        if (projectId && projectId.trim().length > 0) {
          search.set('project_id', projectId.trim());
        }

        const resp = await fetch(`/orgx/api/live/activity/page?${search.toString()}`);
        const payload = (await resp.json().catch(() => null)) as ActivityPageResponse | null;
        if (!resp.ok || !payload) {
          throw new Error(`Activity paging failed (${resp.status})`);
        }

        const nextItems = (Array.isArray(payload.activities) ? payload.activities : []).filter(
          (item) => !initiativeId || resolveInitiativeId(item) === initiativeId
        );
        setItems((prev) => mergeById(prev, nextItems));
        setCursor(payload.nextCursor ?? null);
        setStoreUpdatedAt(payload.storeUpdatedAt ?? null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Activity paging failed');
        // Prevent repeated bootstrap retries on hard failures.
        setCursor((prev) => (prev === '' ? null : prev));
      } finally {
        setIsLoadingMore(false);
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = request;
    return request;
  }, [cursor, demoMode, initiativeId, pageSize, projectId, runId, sinceIso, untilIso]);

  useEffect(() => {
    if (cursor !== '') return;
    if (bootstrapAttemptedRef.current) return;
    bootstrapAttemptedRef.current = true;
    void loadMore();
  }, [cursor, loadMore]);

  const hasMore = cursor !== null;

  return {
    items,
    hasMore,
    isLoadingMore,
    error,
    storeUpdatedAt,
    loadMore,
    cutoffEpoch: sinceEpoch,
    sinceIso,
    untilIso,
  };
}
