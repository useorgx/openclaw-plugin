import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import type {
  LiveTriageItem,
  TriageActionRequest,
  TriageActionResponse,
  TriageListResponse,
  TriageSeverity,
} from '@/types';

// ---------------------------------------------------------------------------
// Noise threshold
// ---------------------------------------------------------------------------

/** Controls which triage items pass the noise filter. */
export type NoiseThreshold = 'all' | 'low' | 'medium' | 'high';

const SEVERITY_ORDER: Record<TriageSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Kinds considered routine noise when noise threshold is 'medium'. */
const ROUTINE_NOISE_KINDS = new Set(['review_required']);

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

interface UseTriageQueueOptions {
  enabled?: boolean;
  workspaceId?: string | null;
  status?: string;
  authToken?: string | null;
  embedMode?: boolean;
  /** Filter threshold — suppress low-severity noise items. Default: 'medium'. */
  noiseThreshold?: NoiseThreshold;
  /** Window (ms) for grouping duplicates by title. Default: 60000. */
  dedupWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function buildOrgxHeaders(authToken?: string | null, embedMode?: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (embedMode) headers['X-OrgX-Embed'] = '1';
  return headers;
}

async function fetchTriageQueue(
  workspaceId: string | null,
  status: string,
  authToken?: string | null,
  embedMode?: boolean,
  noiseThreshold?: NoiseThreshold,
  dedupWindowMs?: number
): Promise<TriageListResponse> {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspace_id', workspaceId);
  if (status) params.set('status', status);
  params.set('limit', '100');
  if (noiseThreshold && noiseThreshold !== 'medium') {
    params.set('noise_threshold', noiseThreshold);
  }
  if (dedupWindowMs != null && dedupWindowMs !== 60000) {
    params.set('dedup_window', String(dedupWindowMs));
  }

  const url = `/orgx/api/live/triage?${params.toString()}`;
  const res = await fetch(url, {
    headers: buildOrgxHeaders(authToken, embedMode),
  });

  if (!res.ok) {
    throw new Error(`Triage fetch failed: ${res.status}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Client-side noise filtering and dedup grouping
// ---------------------------------------------------------------------------

export interface DedupedTriageGroup {
  /** The canonical (most recent) item in the group. */
  item: LiveTriageItem;
  /** All items in this group, including the canonical one. */
  members: LiveTriageItem[];
  /** Number of duplicate items collapsed into this group. */
  count: number;
}

function applyNoiseFilter(
  items: LiveTriageItem[],
  threshold: NoiseThreshold
): LiveTriageItem[] {
  if (threshold === 'all' || threshold === 'low') return items;

  if (threshold === 'high') {
    return items.filter(
      (item) => item.severity === 'critical' || item.severity === 'high'
    );
  }

  // threshold === 'medium': suppress low-severity routine items
  return items.filter((item) => {
    if (item.severity === 'low' && ROUTINE_NOISE_KINDS.has(item.kind)) {
      return false;
    }
    return true;
  });
}

function groupByTitle(
  items: LiveTriageItem[],
  windowMs: number
): DedupedTriageGroup[] {
  const groups = new Map<string, DedupedTriageGroup>();

  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { item, members: [item], count: 1 });
      continue;
    }

    // Check time window: compare with the canonical item's lastSeenAt
    const existingTs = new Date(existing.item.lastSeenAt).getTime();
    const itemTs = new Date(item.lastSeenAt).getTime();
    const diff = Math.abs(existingTs - itemTs);

    if (diff <= windowMs) {
      existing.members.push(item);
      existing.count += 1;
      // Keep the most recent item as canonical
      if (itemTs > existingTs) {
        existing.item = item;
      }
    } else {
      // Outside window — treat as separate (use item id as unique key)
      groups.set(`${key}::${item.id}`, { item, members: [item], count: 1 });
    }
  }

  return Array.from(groups.values());
}

function sortBySeverityThenRecency(groups: DedupedTriageGroup[]): DedupedTriageGroup[] {
  return [...groups].sort((a, b) => {
    const sevA = SEVERITY_ORDER[a.item.severity] ?? 3;
    const sevB = SEVERITY_ORDER[b.item.severity] ?? 3;
    if (sevA !== sevB) return sevA - sevB;
    return (
      new Date(b.item.lastSeenAt).getTime() -
      new Date(a.item.lastSeenAt).getTime()
    );
  });
}

async function postTriageAction(
  itemId: string,
  payload: TriageActionRequest,
  authToken?: string | null,
  embedMode?: boolean
): Promise<TriageActionResponse> {
  const params = new URLSearchParams({ id: itemId });
  const url = `/orgx/api/live/triage/action?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildOrgxHeaders(authToken, embedMode),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Action failed: ${res.status}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface TriageQueueModel {
  /** Raw items from the API (post-server-side filtering). */
  items: LiveTriageItem[];
  /** Grouped and noise-filtered items for display. */
  groups: DedupedTriageGroup[];
  total: number;
  /** Total after noise filtering. */
  filteredTotal: number;
  /** How many items were suppressed by the noise filter. */
  suppressedCount: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  degraded: string[];
  refetch: () => void;
}

export interface TriageQueueActions {
  performAction: (
    itemId: string,
    action: string,
    opts?: { note?: string; optionId?: string; snoozeDurationMinutes?: number }
  ) => Promise<TriageActionResponse>;
  isActing: boolean;
  lastActionError: string | null;
}

export function useTriageQueue(options: UseTriageQueueOptions = {}): {
  model: TriageQueueModel;
  actions: TriageQueueActions;
} {
  const {
    enabled = true,
    workspaceId = null,
    status = 'open',
    authToken = null,
    embedMode = false,
    noiseThreshold = 'medium',
    dedupWindowMs = 60_000,
  } = options;

  const queryClient = useQueryClient();

  const queryKey = queryKeys.triageQueue({
    workspaceId,
    status,
    authToken,
    embedMode,
  });

  const query = useQuery({
    queryKey,
    queryFn: () =>
      fetchTriageQueue(workspaceId, status, authToken, embedMode, noiseThreshold, dedupWindowMs),
    enabled,
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const actionMutation = useMutation({
    mutationFn: async ({
      itemId,
      payload,
    }: {
      itemId: string;
      payload: TriageActionRequest;
    }) => postTriageAction(itemId, payload, authToken, embedMode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const performAction = useCallback(
    async (
      itemId: string,
      action: string,
      opts?: { note?: string; optionId?: string; snoozeDurationMinutes?: number }
    ) => {
      return actionMutation.mutateAsync({
        itemId,
        payload: {
          action,
          note: opts?.note,
          optionId: opts?.optionId,
          snoozeDurationMinutes: opts?.snoozeDurationMinutes,
        },
      });
    },
    [actionMutation]
  );

  const rawItems = query.data?.items ?? [];

  const { filteredItems, suppressedCount } = useMemo(() => {
    const filtered = applyNoiseFilter(rawItems, noiseThreshold);
    return {
      filteredItems: filtered,
      suppressedCount: rawItems.length - filtered.length,
    };
  }, [rawItems, noiseThreshold]);

  const groups = useMemo(
    () => sortBySeverityThenRecency(groupByTitle(filteredItems, dedupWindowMs)),
    [filteredItems, dedupWindowMs]
  );

  const model: TriageQueueModel = useMemo(
    () => ({
      items: rawItems,
      groups,
      total: query.data?.total ?? 0,
      filteredTotal: filteredItems.length,
      suppressedCount,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error as Error | null,
      degraded: query.data?.degraded ?? [],
      refetch: query.refetch,
    }),
    [rawItems, groups, filteredItems.length, suppressedCount, query]
  );

  const actions: TriageQueueActions = useMemo(
    () => ({
      performAction,
      isActing: actionMutation.isPending,
      lastActionError: actionMutation.error
        ? (actionMutation.error as Error).message
        : null,
    }),
    [performAction, actionMutation.isPending, actionMutation.error]
  );

  return { model, actions };
}
