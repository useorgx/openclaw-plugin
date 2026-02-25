import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveActivityItem } from '@/types';
import type { ActivityTimeFilterId } from '@/lib/activityTimeFilters';
import { cutoffEpochForActivityFilter, sinceIsoForActivityFilter } from '@/lib/activityTimeFilters';
import { buildOrgxHeaders } from '@/lib/http';
import { humanizeWarning } from '@/lib/humanize';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { appendWorkspaceScopeParams } from '@/lib/workspaceScope';

type ActivityPageResponse = {
  activities: LiveActivityItem[];
  nextCursor: string | null;
  total: number;
  storeUpdatedAt: string;
  error?: string;
  message?: string;
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

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!areJsonValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index]) return false;
    if (!areJsonValuesEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

const FEED_DEBUG = typeof window !== 'undefined' && /[?&]debug_feed/.test(window.location.search);

function feedLog(tag: string, ...args: unknown[]) {
  if (!FEED_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`%c[activity-feed] ${tag}`, 'color:#7dd3c0;font-weight:600', ...args);
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
  let skippedRun = 0;
  let skippedInitiative = 0;
  let skippedTime = 0;
  for (const item of items ?? []) {
    if (!item || typeof item.id !== 'string') continue;
    if (runId && item.runId !== runId) { skippedRun++; continue; }
    if (initiativeId && resolveInitiativeId(item) !== initiativeId) { skippedInitiative++; continue; }
    const epoch = toEpoch(item.timestamp);
    if (!epoch) continue;
    if (sinceEpoch !== null && epoch < sinceEpoch) { skippedTime++; continue; }
    if (untilEpoch !== null && epoch > untilEpoch) { skippedTime++; continue; }
    byId.set(item.id, item);
  }
  feedLog('normalizeSeed', {
    inputCount: items?.length ?? 0,
    outputCount: byId.size,
    runId,
    initiativeId,
    skippedRun,
    skippedInitiative,
    skippedTime,
    sinceEpoch: sinceEpoch ? new Date(sinceEpoch).toISOString() : null,
    untilEpoch: untilEpoch ? new Date(untilEpoch).toISOString() : null,
  });
  return Array.from(byId.values()).sort(compareActivity);
}

function mergeById(current: LiveActivityItem[], incoming: LiveActivityItem[]): LiveActivityItem[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, LiveActivityItem>();
  for (const item of current) byId.set(item.id, item);
  let added = 0;
  let updated = 0;
  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      changed = true;
      added++;
      continue;
    }
    if (
      existing.timestamp !== item.timestamp ||
      existing.type !== item.type ||
      existing.title !== item.title ||
      existing.description !== item.description ||
      existing.summary !== item.summary ||
      !areJsonValuesEqual(existing.metadata ?? null, item.metadata ?? null)
    ) {
      byId.set(item.id, item);
      changed = true;
      updated++;
    }
  }
  feedLog('mergeById', {
    currentCount: current.length,
    incomingCount: incoming.length,
    added,
    updated,
    changed,
    resultCount: byId.size,
  });
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

  // Keep a ref to the latest seed so the reset effect can read it without
  // depending on it — preventing the "wipe paged data on every SSE push" bug.
  const normalizedSeedRef = useRef(normalizedSeed);
  normalizedSeedRef.current = normalizedSeed;

  // Composite key of the filter parameters that should cause a full reset.
  // When only the SSE seed changes the key stays stable → no reset.
  const filterIdentity = useMemo(
    () => `${runId ?? ''}|${initiativeId ?? ''}|${timeFilterId}|${sinceIso ?? ''}|${untilIso ?? ''}|${projectId ?? ''}`,
    [runId, initiativeId, timeFilterId, sinceIso, untilIso, projectId]
  );
  const prevFilterIdentityRef = useRef(filterIdentity);

  // Reset when actual filter/run parameters change — NOT on seed data changes.
  // The old dependency on `normalizedSeed` caused a full wipe + re-bootstrap
  // on every SSE push, flickering from ~57 paged items down to ~11 seed items.
  useEffect(() => {
    // Skip the initial mount — useState already initialized with the seed.
    if (prevFilterIdentityRef.current === filterIdentity) return;
    prevFilterIdentityRef.current = filterIdentity;

    feedLog('RESET', {
      reason: 'filter/run change',
      runId,
      initiativeId,
      projectId,
      timeFilterId,
      sinceIso,
      untilIso,
      seedCount: normalizedSeedRef.current.length,
    });
    setItems(normalizedSeedRef.current);
    setCursor(initialCursor);
    setError(null);
    setStoreUpdatedAt(null);
    bootstrapAttemptedRef.current = false;
  }, [filterIdentity, initialCursor, runId, initiativeId, projectId, timeFilterId, sinceIso, untilIso]);

  // Merge in new seed items (SSE tail) without disturbing the paging cursor.
  // This is the ONLY path for SSE data to enter the items array after mount.
  useEffect(() => {
    setItems((prev) => {
      const next = mergeById(prev, normalizedSeed);
      if (next !== prev) {
        feedLog('SSE_MERGE', {
          prevCount: prev.length,
          seedCount: normalizedSeed.length,
          nextCount: next.length,
          delta: next.length - prev.length,
        });
      }
      return next;
    });
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
          appendWorkspaceScopeParams(search, projectId);
        }

        const resp = await fetch(`/orgx/api/live/activity/page?${search.toString()}`, {
          headers: buildOrgxHeaders({ workspaceId: projectId }),
        });
        const payload = (await resp.json().catch(() => null)) as ActivityPageResponse | null;
        if (!resp.ok || !payload) {
          const detail =
            (typeof payload?.error === 'string' && payload.error.trim()) ||
            (typeof payload?.message === 'string' && payload.message.trim()) ||
            `Activity paging failed (${resp.status})`;
          throw new Error(detail);
        }

        const rawPageItems = Array.isArray(payload.activities) ? payload.activities : [];
        const nextItems = rawPageItems.filter(
          (item) => !initiativeId || resolveInitiativeId(item) === initiativeId
        );
        feedLog('PAGE_FETCH', {
          cursor,
          rawCount: rawPageItems.length,
          afterFilter: nextItems.length,
          filteredOut: rawPageItems.length - nextItems.length,
          initiativeId,
          runId,
          nextCursor: payload.nextCursor ?? null,
        });
        setItems((prev) => {
          const next = mergeById(prev, nextItems);
          feedLog('PAGE_MERGE', {
            prevCount: prev.length,
            pageCount: nextItems.length,
            nextCount: next.length,
            added: next.length - prev.length,
          });
          return next;
        });
        setCursor(payload.nextCursor ?? null);
        setStoreUpdatedAt(payload.storeUpdatedAt ?? null);
        setError(null);
      } catch (err) {
        const raw = err instanceof Error ? err.message : '';
        setError(raw ? humanizeWarning(raw) : 'Activity paging failed');
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
