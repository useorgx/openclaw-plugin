import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  LiveData,
  LiveActivityItem,
  LiveDecision,
  SessionTreeResponse,
  HandoffSummary,
} from '@/types';
import { createMockData } from '@/data/mockData';
import { formatRelativeTime } from '@/lib/time';

interface UseLiveDataOptions {
  pollInterval?: number;
  useMock?: boolean;
  maxSessions?: number;
  maxActivityItems?: number;
  maxHandoffs?: number;
  maxDecisions?: number;
  batchWindowMs?: number;
}

interface LiveAgentsResponse {
  agents?: Array<{
    id: string;
    name: string | null;
    status: string;
    currentTask: string | null;
    runId: string | null;
    initiativeId: string | null;
    startedAt: string | null;
    blockers?: unknown;
  }>;
}

interface LiveActivityResponse {
  activities?: LiveActivityItem[];
}

interface LiveHandoffsResponse {
  handoffs?: HandoffSummary[];
}

interface LiveDecisionsResponse {
  decisions?: LiveDecision[];
}

interface JsonFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

interface DecisionMutationResult {
  id: string;
  ok: boolean;
  error?: string;
}

interface DecisionMutationResponse {
  results?: DecisionMutationResult[];
  updated?: number;
  failed?: number;
}

const DEFAULT_POLL_INTERVAL = 8000;
const DEFAULT_MAX_SESSIONS = 320;
const DEFAULT_MAX_ACTIVITY_ITEMS = 360;
const DEFAULT_MAX_HANDOFFS = 120;
const DEFAULT_MAX_DECISIONS = 120;
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

function compareSessionsByPriority(
  a: SessionTreeResponse['nodes'][number],
  b: SessionTreeResponse['nodes'][number]
): number {
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

function normalizeDecision(decision: LiveDecision): LiveDecision {
  const requestedAt = decision.requestedAt ?? decision.updatedAt ?? null;
  const updatedAt = decision.updatedAt ?? requestedAt;
  const waitingMinutes = Number.isFinite(decision.waitingMinutes)
    ? Math.max(0, Math.floor(decision.waitingMinutes))
    : requestedAt
      ? Math.max(0, Math.floor((Date.now() - toEpoch(requestedAt)) / 60_000))
      : 0;

  return {
    id: decision.id,
    title: decision.title,
    context: decision.context ?? null,
    status: decision.status ?? 'pending',
    agentName: decision.agentName ?? null,
    requestedAt,
    updatedAt,
    waitingMinutes,
    metadata: decision.metadata,
  };
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

function sameDecisionShape(a: LiveDecision[], b: LiveDecision[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].status !== b[i].status ||
      a[i].updatedAt !== b[i].updatedAt ||
      a[i].waitingMinutes !== b[i].waitingMinutes
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

function normalizeDecisions(source: LiveDecision[], maxDecisions: number): LiveDecision[] {
  const normalized = source
    .filter((decision) => !!decision && typeof decision.id === 'string' && decision.id.length > 0)
    .map(normalizeDecision)
    .sort((a, b) => {
      if (a.waitingMinutes !== b.waitingMinutes) {
        return b.waitingMinutes - a.waitingMinutes;
      }
      return toEpoch(b.requestedAt ?? b.updatedAt) - toEpoch(a.requestedAt ?? a.updatedAt);
    })
    .slice(0, maxDecisions);

  const seen = new Set<string>();
  const deduped: LiveDecision[] = [];
  for (const decision of normalized) {
    if (seen.has(decision.id)) continue;
    seen.add(decision.id);
    deduped.push(decision);
  }

  return deduped;
}

function statusFromActivityType(type: LiveActivityItem['type']): string {
  if (type === 'run_failed' || type === 'blocker_created') return 'blocked';
  if (type === 'run_completed' || type === 'milestone_completed') return 'completed';
  if (type === 'decision_requested' || type === 'handoff_requested') return 'pending';
  if (type === 'decision_resolved' || type === 'handoff_fulfilled') return 'completed';
  if (type === 'handoff_claimed' || type === 'delegation') return 'running';
  return 'running';
}

function statusFromAgentStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'running' || normalized === 'active') return 'running';
  if (normalized === 'queued' || normalized === 'pending') return 'queued';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  return 'archived';
}

function initiativeLabelFromId(initiativeId: string | null): string {
  if (!initiativeId) return 'Unscoped';
  const compact = initiativeId.length > 16 ? `${initiativeId.slice(0, 8)}…` : initiativeId;
  return `Initiative ${compact}`;
}

function coerceBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const blockers: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      blockers.push(entry.trim());
    }
  }
  return blockers;
}

function deriveSessionsFromFallbacks(
  activity: LiveActivityItem[],
  agents: LiveAgentsResponse['agents'],
  maxSessions: number
): SessionTreeResponse {
  const byRunId = new Map<string, SessionTreeResponse['nodes'][number]>();

  const sortedActivity = [...activity].sort(
    (a, b) => toEpoch(b.timestamp) - toEpoch(a.timestamp)
  );

  for (const event of sortedActivity) {
    if (!event.runId) continue;

    const runId = event.runId;
    const existing = byRunId.get(runId);
    const eventTimestamp = event.timestamp;

    if (!existing) {
      const initiativeId = event.initiativeId ?? null;
      byRunId.set(runId, {
        id: runId,
        parentId: null,
        runId,
        title: event.title,
        agentId: event.agentId ?? null,
        agentName: event.agentName ?? null,
        status: statusFromActivityType(event.type),
        progress: null,
        initiativeId,
        workstreamId: null,
        groupId: initiativeId ?? 'unscoped',
        groupLabel: initiativeLabelFromId(initiativeId),
        startedAt: eventTimestamp,
        updatedAt: eventTimestamp,
        lastEventAt: eventTimestamp,
        lastEventSummary: event.title,
        blockers:
          event.type === 'blocker_created' && event.description
            ? [event.description]
            : [],
      });
      continue;
    }

    if (!existing.startedAt || toEpoch(eventTimestamp) < toEpoch(existing.startedAt)) {
      existing.startedAt = eventTimestamp;
    }

    if (toEpoch(eventTimestamp) >= toEpoch(existing.updatedAt ?? existing.lastEventAt)) {
      existing.updatedAt = eventTimestamp;
      existing.lastEventAt = eventTimestamp;
      existing.lastEventSummary = event.title;
      existing.status = statusFromActivityType(event.type);
      if (event.agentName) existing.agentName = event.agentName;
      if (event.agentId) existing.agentId = event.agentId;
      if (event.initiativeId) {
        existing.initiativeId = event.initiativeId;
        existing.groupId = event.initiativeId;
        existing.groupLabel = initiativeLabelFromId(event.initiativeId);
      }
      if (!existing.title || existing.title.length < 4) {
        existing.title = event.title;
      }
    }

    if (event.type === 'blocker_created' && event.description) {
      if (!existing.blockers.includes(event.description)) {
        existing.blockers.push(event.description);
      }
    }
  }

  for (const agent of agents ?? []) {
    const runId = agent.runId ?? `agent:${agent.id}`;
    const existing = byRunId.get(runId);
    const status = statusFromAgentStatus(agent.status);
    const initiativeId = agent.initiativeId ?? null;
    const title =
      agent.currentTask && agent.currentTask.trim().length > 0
        ? agent.currentTask.trim()
        : `${agent.name ?? agent.id} ${status === 'archived' ? 'idle' : status}`;

    if (!existing) {
      byRunId.set(runId, {
        id: runId,
        parentId: null,
        runId,
        title,
        agentId: agent.id,
        agentName: agent.name ?? agent.id,
        status,
        progress: null,
        initiativeId,
        workstreamId: null,
        groupId: initiativeId ?? 'unscoped',
        groupLabel: initiativeLabelFromId(initiativeId),
        startedAt: agent.startedAt ?? null,
        updatedAt: agent.startedAt ?? null,
        lastEventAt: agent.startedAt ?? null,
        lastEventSummary: agent.currentTask,
        blockers: coerceBlockers(agent.blockers),
      });
      continue;
    }

    if (!existing.agentName && agent.name) existing.agentName = agent.name;
    if (!existing.agentId) existing.agentId = agent.id;
    if (!existing.title || existing.title === existing.runId) existing.title = title;
    if (existing.status === 'archived' && status !== 'archived') {
      existing.status = status;
    }
    if (coerceBlockers(agent.blockers).length > 0) {
      existing.blockers = coerceBlockers(agent.blockers);
    }

    if (initiativeId && !existing.initiativeId) {
      existing.initiativeId = initiativeId;
      existing.groupId = initiativeId;
      existing.groupLabel = initiativeLabelFromId(initiativeId);
    }
  }

  const nodes = Array.from(byRunId.values()).sort(compareSessionsByPriority).slice(0, maxSessions);
  const groupMap = new Map<string, SessionTreeResponse['groups'][number]>();
  for (const node of nodes) {
    if (!groupMap.has(node.groupId)) {
      groupMap.set(node.groupId, {
        id: node.groupId,
        label: node.groupLabel,
        status: node.status,
      });
    }
  }

  return {
    nodes,
    edges: [],
    groups: Array.from(groupMap.values()),
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<JsonFetchResult<T>> {
  try {
    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const isJson = contentType.includes('application/json');

    if (!response.ok) {
      let error = `${response.status} ${response.statusText}`;
      if (isJson) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        if (payload?.error) {
          error = `${response.status} ${payload.error}`;
        }
      } else {
        const bodyPreview = (await response.text().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        if (bodyPreview.length > 0) {
          error = `${response.status} ${bodyPreview}`;
        }
      }

      return {
        ok: false,
        status: response.status,
        data: null,
        error,
      };
    }

    if (!isJson) {
      const bodyPreview = (await response.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 80);
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `Unexpected content type for ${url}${bodyPreview ? `: ${bodyPreview}` : ''}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: (await response.json()) as T,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

function buildLiveData(
  sessions: SessionTreeResponse,
  activity: LiveActivityItem[],
  handoffs: HandoffSummary[],
  decisions: LiveDecision[]
): LiveData {
  const latestActivityAt = activity[0]?.timestamp ?? null;
  const latestDecisionAt = decisions[0]?.requestedAt ?? decisions[0]?.updatedAt ?? null;
  const latestTimestamp =
    toEpoch(latestActivityAt) >= toEpoch(latestDecisionAt)
      ? latestActivityAt
      : latestDecisionAt;

  return {
    connection: 'connected',
    lastActivity: latestTimestamp ? formatRelativeTime(latestTimestamp) : null,
    sessions,
    activity,
    handoffs,
    decisions,
  };
}

export function useLiveData(options: UseLiveDataOptions = {}) {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    useMock = false,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxActivityItems = DEFAULT_MAX_ACTIVITY_ITEMS,
    maxHandoffs = DEFAULT_MAX_HANDOFFS,
    maxDecisions = DEFAULT_MAX_DECISIONS,
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
      handoffInput: HandoffSummary[],
      decisionInput: LiveDecision[] | null = null
    ) => {
      const sessions = trimSessions(sessionsInput, maxSessions);
      const activity = normalizeActivity(activityInput, maxActivityItems);
      const handoffs = trimHandoffs(handoffInput, maxHandoffs);

      setData((prev) => {
        const decisions =
          decisionInput === null
            ? prev.decisions
            : normalizeDecisions(decisionInput, maxDecisions);

        if (
          sameSessionsShape(prev.sessions, sessions) &&
          sameActivityShape(prev.activity, activity) &&
          sameHandoffShape(prev.handoffs, handoffs) &&
          sameDecisionShape(prev.decisions, decisions) &&
          prev.connection === 'connected'
        ) {
          return prev;
        }

        return buildLiveData(sessions, activity, handoffs, decisions);
      });

      setIsLoading(false);
    },
    [maxActivityItems, maxDecisions, maxHandoffs, maxSessions]
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
        const [sessionsRes, activityRes, handoffsRes, decisionsRes, agentsRes] = await Promise.all([
          fetchJson<SessionTreeResponse>(`/orgx/api/live/sessions?limit=${maxSessions}`),
          fetchJson<LiveActivityResponse>(`/orgx/api/live/activity?limit=${maxActivityItems}`),
          fetchJson<LiveHandoffsResponse>('/orgx/api/handoffs'),
          fetchJson<LiveDecisionsResponse>(`/orgx/api/live/decisions?status=pending&limit=${maxDecisions}`),
          fetchJson<LiveAgentsResponse>('/orgx/api/live/agents?include_idle=true'),
        ]);

        const activity = normalizeActivity(
          (activityRes.data?.activities ?? []) as LiveActivityItem[],
          maxActivityItems
        );
        const handoffs = trimHandoffs(
          (handoffsRes.data?.handoffs ?? []) as HandoffSummary[],
          maxHandoffs
        );
        const decisions = normalizeDecisions(
          (decisionsRes.data?.decisions ?? []) as LiveDecision[],
          maxDecisions
        );
        const sessions = sessionsRes.ok && sessionsRes.data
          ? trimSessions(sessionsRes.data, maxSessions)
          : deriveSessionsFromFallbacks(
              activity,
              agentsRes.data?.agents,
              maxSessions
            );

        applySnapshot(sessions, activity, handoffs, decisions);

        const degradedReasons: string[] = [];
        if (!sessionsRes.ok) degradedReasons.push(`sessions unavailable (${sessionsRes.error})`);
        if (!handoffsRes.ok) degradedReasons.push(`handoffs unavailable (${handoffsRes.error})`);
        if (!decisionsRes.ok) degradedReasons.push(`decisions unavailable (${decisionsRes.error})`);
        if (!agentsRes.ok) degradedReasons.push(`agent fallback unavailable (${agentsRes.error})`);

        if (degradedReasons.length > 0) {
          setError(`Partial live data: ${degradedReasons.join('; ')}`);
          setData((prev) =>
            prev.connection === 'reconnecting'
              ? prev
              : { ...prev, connection: 'reconnecting' }
          );
          setPollingEnabled(true);
        } else {
          setError(null);
          setData((prev) =>
            prev.connection === 'connected'
              ? prev
              : { ...prev, connection: 'connected' }
          );
        }
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
  }, [
    applySnapshot,
    maxActivityItems,
    maxDecisions,
    maxHandoffs,
    maxSessions,
    useMock,
  ]);

  const applyDecisionMutation = useCallback(
    async (decisionIds: string[], action: 'approve' | 'reject') => {
      const ids = Array.from(new Set(decisionIds.filter(Boolean)));
      if (ids.length === 0) {
        return { updated: 0, failed: 0 };
      }

      const response = await fetch('/orgx/api/live/decisions/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ids,
          action,
        }),
      });

      const payload = (await response.json().catch(() => null)) as DecisionMutationResponse | null;
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const resolvedIds = new Set(
        results.filter((result) => result.ok).map((result) => result.id)
      );

      if (!response.ok && response.status !== 207) {
        const serverMessage = typeof (payload as { error?: string } | null)?.error === 'string'
          ? (payload as { error: string }).error
          : `Decision action failed (${response.status})`;
        throw new Error(serverMessage);
      }

      if (resolvedIds.size === 0 && response.ok && (payload?.failed ?? 0) === 0) {
        for (const id of ids) {
          resolvedIds.add(id);
        }
      }

      if (resolvedIds.size > 0) {
        setData((prev) => {
          const approvedDecisions = prev.decisions.filter((decision) =>
            resolvedIds.has(decision.id)
          );
          if (approvedDecisions.length === 0) {
            return prev;
          }

          const now = new Date().toISOString();
          const decisionEvents: LiveActivityItem[] = approvedDecisions.map((decision) => ({
            id: `decision:${action}:${decision.id}:${Date.now()}`,
            type: 'decision_resolved',
            title:
              action === 'approve'
                ? `Approved: ${decision.title}`
                : `Rejected: ${decision.title}`,
            description: decision.context,
            agentId: null,
            agentName: decision.agentName,
            runId: null,
            initiativeId: null,
            timestamp: now,
            metadata: {
              decisionId: decision.id,
              action,
            },
          }));

          const mergedActivity = normalizeActivity(
            decisionEvents.concat(prev.activity),
            maxActivityItems
          );
          const next = {
            ...prev,
            decisions: prev.decisions.filter((decision) => !resolvedIds.has(decision.id)),
            activity: mergedActivity,
            lastActivity: formatRelativeTime(now),
          };

          return next;
        });
      }

      const updated = payload?.updated ?? resolvedIds.size;
      const failed = payload?.failed ?? Math.max(0, ids.length - resolvedIds.size);
      return { updated, failed };
    },
    [maxActivityItems]
  );

  const approveDecision = useCallback(
    async (decisionId: string) => {
      return applyDecisionMutation([decisionId], 'approve');
    },
    [applyDecisionMutation]
  );

  const approveAllDecisions = useCallback(async () => {
    const allDecisionIds = data.decisions.map((decision) => decision.id);
    return applyDecisionMutation(allDecisionIds, 'approve');
  }, [applyDecisionMutation, data.decisions]);

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
          decisions: LiveDecision[] | null;
        }
      | null = null;
    let pendingSessions: SessionTreeResponse | null = null;
    let pendingHandoffs: HandoffSummary[] | null = null;
    let pendingActivity: LiveActivityItem[] = [];
    let pendingDecisions: LiveDecision[] | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flushPending = () => {
      flushTimer = undefined;

      if (pendingSnapshot) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        pendingSessions = null;
        pendingHandoffs = null;
        pendingActivity = [];
        pendingDecisions = null;
        applySnapshot(
          snapshot.sessions,
          snapshot.activity,
          snapshot.handoffs,
          snapshot.decisions
        );
        return;
      }

      if (
        !pendingSessions &&
        !pendingHandoffs &&
        !pendingDecisions &&
        pendingActivity.length === 0
      ) {
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

        if (pendingDecisions) {
          const normalizedDecisions = normalizeDecisions(pendingDecisions, maxDecisions);
          pendingDecisions = null;

          if (!sameDecisionShape(next.decisions, normalizedDecisions)) {
            next = { ...next, decisions: normalizedDecisions };
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
          decisions?: LiveDecision[];
        };

        pendingSnapshot = {
          sessions: payload.sessions,
          activity: payload.activity ?? [],
          handoffs: payload.handoffs ?? [],
          decisions: payload.decisions ?? null,
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

    eventSource.addEventListener('decision.updated', (event) => {
      try {
        pendingDecisions = JSON.parse((event as MessageEvent).data) as LiveDecision[];
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
    maxDecisions,
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

  return {
    data,
    isLoading,
    error,
    refetch: fetchSnapshot,
    approveDecision,
    approveAllDecisions,
  };
}
