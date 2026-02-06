import { useState, useEffect, useCallback, useRef } from 'react';
import type { LiveData, LiveActivityItem, SessionTreeResponse, HandoffSummary } from '@/types';
import { createMockData } from '@/data/mockData';
import { formatRelativeTime } from '@/lib/time';

interface UseLiveDataOptions {
  pollInterval?: number;
  useMock?: boolean;
  maxSessions?: number;
  maxActivityItems?: number;
  maxHandoffs?: number;
  batchWindowMs?: number;
}

const DEFAULT_POLL_INTERVAL = 8000;
const DEFAULT_MAX_SESSIONS = 320;
const DEFAULT_MAX_ACTIVITY_ITEMS = 360;
const DEFAULT_MAX_HANDOFFS = 120;
const DEFAULT_BATCH_WINDOW_MS = 90;

const SESSION_STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  queued: 1,
  pending: 2,
  blocked: 3,
  failed: 4,
  cancelled: 5,
  completed: 6,
  archived: 7,
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareSessionsByPriority(a: SessionTreeResponse['nodes'][number], b: SessionTreeResponse['nodes'][number]): number {
  const aPriority = SESSION_STATUS_PRIORITY[a.status] ?? 99;
  const bPriority = SESSION_STATUS_PRIORITY[b.status] ?? 99;
  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }

  const aUpdated = toEpoch(a.updatedAt ?? a.lastEventAt ?? a.startedAt);
  const bUpdated = toEpoch(b.updatedAt ?? b.lastEventAt ?? b.startedAt);
  if (aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }

  return a.id.localeCompare(b.id);
}

function trimSessions(source: SessionTreeResponse, maxSessions: number): SessionTreeResponse {
  if (source.nodes.length <= maxSessions) {
    return source;
  }

  const nodes = [...source.nodes].sort(compareSessionsByPriority).slice(0, maxSessions);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const groupIds = new Set(nodes.map((node) => node.groupId));

  return {
    nodes,
    edges: source.edges.filter(
      (edge) => nodeIds.has(edge.parentId) && nodeIds.has(edge.childId)
    ),
    groups: source.groups.filter((group) => groupIds.has(group.id)),
  };
}

function trimHandoffs(source: HandoffSummary[], maxHandoffs: number): HandoffSummary[] {
  if (source.length <= maxHandoffs) {
    return source;
  }

  return [...source]
    .sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt))
    .slice(0, maxHandoffs);
}

function sameActivityShape(a: LiveActivityItem[], b: LiveActivityItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].timestamp !== b[i].timestamp ||
      a[i].type !== b[i].type ||
      a[i].title !== b[i].title
    ) {
      return false;
    }
  }
  return true;
}

function sameSessionsShape(a: SessionTreeResponse, b: SessionTreeResponse): boolean {
  if (
    a.nodes.length !== b.nodes.length ||
    a.edges.length !== b.edges.length ||
    a.groups.length !== b.groups.length
  ) {
    return false;
  }

  for (let i = 0; i < a.nodes.length; i += 1) {
    const current = a.nodes[i];
    const next = b.nodes[i];
    if (
      current.id !== next.id ||
      current.status !== next.status ||
      current.title !== next.title ||
      current.progress !== next.progress ||
      current.updatedAt !== next.updatedAt ||
      current.lastEventAt !== next.lastEventAt
    ) {
      return false;
    }
  }

  for (let i = 0; i < a.edges.length; i += 1) {
    const current = a.edges[i];
    const next = b.edges[i];
    if (current.parentId !== next.parentId || current.childId !== next.childId) {
      return false;
    }
  }

  for (let i = 0; i < a.groups.length; i += 1) {
    const current = a.groups[i];
    const next = b.groups[i];
    if (
      current.id !== next.id ||
      current.label !== next.label ||
      current.status !== next.status
    ) {
      return false;
    }
  }

  return true;
}

function sameHandoffShape(a: HandoffSummary[], b: HandoffSummary[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].updatedAt !== b[i].updatedAt ||
      a[i].status !== b[i].status ||
      a[i].title !== b[i].title
    ) {
      return false;
    }
  }

  return true;
}

function mergeActivity(
  current: LiveActivityItem[],
  incoming: LiveActivityItem[],
  maxActivityItems: number
): LiveActivityItem[] {
  if (incoming.length === 0) {
    return current;
  }

  const byId = new Map<string, LiveActivityItem>();
  for (const item of current) {
    byId.set(item.id, item);
  }

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
      existing.description !== item.description
    ) {
      byId.set(item.id, item);
      changed = true;
    }
  }

  if (!changed) {
    return current;
  }

  const merged = Array.from(byId.values())
    .sort((a, b) => toEpoch(b.timestamp) - toEpoch(a.timestamp))
    .slice(0, maxActivityItems);

  return sameActivityShape(current, merged) ? current : merged;
}

function normalizeActivity(source: LiveActivityItem[], maxActivityItems: number): LiveActivityItem[] {
  const sorted = [...source]
    .sort((a, b) => toEpoch(b.timestamp) - toEpoch(a.timestamp))
    .slice(0, maxActivityItems);

  const seen = new Set<string>();
  const deduped: LiveActivityItem[] = [];
  for (const item of sorted) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}

function buildLiveData(
  sessions: SessionTreeResponse,
  activity: LiveActivityItem[],
  handoffs: HandoffSummary[]
): LiveData {
  const lastActivity = activity[0]?.timestamp
    ? formatRelativeTime(activity[0].timestamp)
    : null;

  return {
    connection: 'connected',
    lastActivity,
    sessions,
    activity,
    handoffs,
  };
}

export function useLiveData(options: UseLiveDataOptions = {}) {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    useMock = false,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxActivityItems = DEFAULT_MAX_ACTIVITY_ITEMS,
    maxHandoffs = DEFAULT_MAX_HANDOFFS,
    batchWindowMs = DEFAULT_BATCH_WINDOW_MS,
  } = options;

  const [data, setData] = useState<LiveData>(createMockData());
  const [isLoading, setIsLoading] = useState(!useMock);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const inFlightSnapshotRef = useRef<Promise<void> | null>(null);
  const [pollingEnabled, setPollingEnabled] = useState(false);

  const applySnapshot = useCallback(
    (
      sessionsInput: SessionTreeResponse,
      activityInput: LiveActivityItem[],
      handoffInput: HandoffSummary[]
    ) => {
      const sessions = trimSessions(sessionsInput, maxSessions);
      const activity = normalizeActivity(activityInput, maxActivityItems);
      const handoffs = trimHandoffs(handoffInput, maxHandoffs);

      setData((prev) => {
        if (
          sameSessionsShape(prev.sessions, sessions) &&
          sameActivityShape(prev.activity, activity) &&
          sameHandoffShape(prev.handoffs, handoffs) &&
          prev.connection === 'connected'
        ) {
          return prev;
        }

        return buildLiveData(sessions, activity, handoffs);
      });

      setError(null);
      setIsLoading(false);
    },
    [maxActivityItems, maxHandoffs, maxSessions]
  );

  const fetchSnapshot = useCallback(async () => {
    if (inFlightSnapshotRef.current) {
      return inFlightSnapshotRef.current;
    }

    if (useMock) {
      setData(createMockData());
      setIsLoading(false);
      return;
    }

    const request = (async () => {
      try {
        const [sessionsRes, activityRes, handoffsRes] = await Promise.all([
          fetch(`/orgx/api/live/sessions?limit=${maxSessions}`),
          fetch(`/orgx/api/live/activity?limit=${maxActivityItems}`),
          fetch('/orgx/api/handoffs'),
        ]);

        if (!sessionsRes.ok) throw new Error('Failed to fetch sessions');

        const sessions = (await sessionsRes.json()) as SessionTreeResponse;
        const activityPayload = activityRes.ok
          ? await activityRes.json()
          : { activities: [] };
        const handoffPayload = handoffsRes.ok
          ? await handoffsRes.json()
          : { handoffs: [] };

        const activity = (activityPayload.activities ?? []) as LiveActivityItem[];
        const handoffs = (handoffPayload.handoffs ?? []) as HandoffSummary[];

        applySnapshot(sessions, activity, handoffs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setData((prev) =>
          prev.connection === 'reconnecting'
            ? prev
            : { ...prev, connection: 'reconnecting' }
        );
        setIsLoading(false);
      } finally {
        inFlightSnapshotRef.current = null;
      }
    })();

    inFlightSnapshotRef.current = request;
    return request;
  }, [applySnapshot, maxActivityItems, maxSessions, useMock]);

  useEffect(() => {
    if (useMock) {
      fetchSnapshot();
      return undefined;
    }

    fetchSnapshot();

    const eventSource = new EventSource('/orgx/api/live/stream');

    let pendingSnapshot:
      | {
          sessions: SessionTreeResponse;
          activity: LiveActivityItem[];
          handoffs: HandoffSummary[];
        }
      | null = null;
    let pendingSessions: SessionTreeResponse | null = null;
    let pendingHandoffs: HandoffSummary[] | null = null;
    let pendingActivity: LiveActivityItem[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flushPending = () => {
      flushTimer = undefined;

      if (pendingSnapshot) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        pendingSessions = null;
        pendingHandoffs = null;
        pendingActivity = [];
        applySnapshot(snapshot.sessions, snapshot.activity, snapshot.handoffs);
        return;
      }

      if (!pendingSessions && !pendingHandoffs && pendingActivity.length === 0) {
        return;
      }

      setData((prev) => {
        let next = prev;

        if (pendingSessions) {
          const trimmedSessions = trimSessions(pendingSessions, maxSessions);
          pendingSessions = null;

          if (!sameSessionsShape(next.sessions, trimmedSessions)) {
            next = { ...next, sessions: trimmedSessions };
          }
        }

        if (pendingHandoffs) {
          const trimmedHandoffs = trimHandoffs(pendingHandoffs, maxHandoffs);
          pendingHandoffs = null;

          if (!sameHandoffShape(next.handoffs, trimmedHandoffs)) {
            next = { ...next, handoffs: trimmedHandoffs };
          }
        }

        if (pendingActivity.length > 0) {
          const mergedActivity = mergeActivity(
            next.activity,
            pendingActivity,
            maxActivityItems
          );
          pendingActivity = [];

          if (mergedActivity !== next.activity) {
            next = {
              ...next,
              activity: mergedActivity,
              lastActivity: mergedActivity[0]?.timestamp
                ? formatRelativeTime(mergedActivity[0].timestamp)
                : next.lastActivity,
            };
          }
        }

        if (next === prev) {
          return prev;
        }

        return next.connection === 'connected' ? next : { ...next, connection: 'connected' };
      });

      setError(null);
      setIsLoading(false);
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushPending, batchWindowMs);
    };

    eventSource.onopen = () => {
      setPollingEnabled(false);
      setData((prev) =>
        prev.connection === 'connected'
          ? prev
          : { ...prev, connection: 'connected' }
      );
      setError(null);
    };

    eventSource.onerror = () => {
      setData((prev) =>
        prev.connection === 'reconnecting'
          ? prev
          : { ...prev, connection: 'reconnecting' }
      );
      setPollingEnabled(true);
    };

    eventSource.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          sessions: SessionTreeResponse;
          activity?: LiveActivityItem[];
          handoffs?: HandoffSummary[];
        };

        pendingSnapshot = {
          sessions: payload.sessions,
          activity: payload.activity ?? [],
          handoffs: payload.handoffs ?? [],
        };
        scheduleFlush();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid snapshot');
      }
    });

    eventSource.addEventListener('activity.appended', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as LiveActivityItem[];
        if (payload.length === 0) return;
        pendingActivity = pendingActivity.concat(payload);
        scheduleFlush();
      } catch {
        // ignore malformed events
      }
    });

    eventSource.addEventListener('session.updated', (event) => {
      try {
        pendingSessions = JSON.parse((event as MessageEvent).data) as SessionTreeResponse;
        scheduleFlush();
      } catch {
        // ignore malformed events
      }
    });

    eventSource.addEventListener('handoff.updated', (event) => {
      try {
        pendingHandoffs = JSON.parse((event as MessageEvent).data) as HandoffSummary[];
        scheduleFlush();
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      eventSource.close();
    };
  }, [
    applySnapshot,
    batchWindowMs,
    fetchSnapshot,
    maxActivityItems,
    maxHandoffs,
    maxSessions,
    useMock,
  ]);

  useEffect(() => {
    if (useMock) return undefined;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!pollingEnabled) return undefined;

    intervalRef.current = setInterval(fetchSnapshot, pollInterval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSnapshot, pollInterval, pollingEnabled, useMock]);

  return { data, isLoading, error, refetch: fetchSnapshot };
}
