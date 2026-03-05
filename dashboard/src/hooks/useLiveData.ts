import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  DecisionMutationState,
  LiveData,
  LiveActivityItem,
  LiveDecision,
  LiveSnapshotResponse,
  LiveSnapshotAgent,
  LiveChatSnapshot,
  ChatThreadSummary,
  RuntimeInstance,
  SessionTreeResponse,
  HandoffSummary,
  OutboxStatus,
  SliceRunProjection,
  WorkSliceProjectionV2,
  SliceTimelineNarrativeProjectionV2,
  NextUpInitiativeProjection,
  SliceDataHealthSummary,
} from '@/types';
import { createMockData } from '@/data/mockData';
import { buildOrgxHeaders } from '@/lib/http';
import { humanizeWarning } from '@/lib/humanize';
import { formatRelativeTime } from '@/lib/time';
import { appendWorkspaceScopeParams } from '@/lib/workspaceScope';

interface UseLiveDataOptions {
  enabled?: boolean;
  pollInterval?: number;
  useMock?: boolean;
  enableDecisions?: boolean;
  initiativeId?: string | null;
  projectId?: string | null;
  maxSessions?: number;
  maxActivityItems?: number;
  maxHandoffs?: number;
  maxDecisions?: number;
  batchWindowMs?: number;
}

interface JsonFetchResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

interface FetchJsonOptions {
  timeoutMs?: number;
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
  error?: string;
}

interface DecisionMutationInput {
  note?: string;
  optionId?: string;
}

interface DecisionActionSummary {
  updated: number;
  failed: number;
  firstError?: string;
}

const DEFAULT_POLL_INTERVAL = 8000;
const DEFAULT_MAX_SESSIONS = 320;
const DEFAULT_MAX_ACTIVITY_ITEMS = 300;
const DEFAULT_MAX_HANDOFFS = 80;
const DEFAULT_MAX_DECISIONS = 80;
const DEFAULT_BATCH_WINDOW_MS = 120;
const DISCONNECT_AFTER_MS = 60_000;
const SNAPSHOT_ENDPOINT_TIMEOUT_MS = 1_200;
const SNAPSHOT_FALLBACK_STAGGER_MS = 90;
const METADATA_FINGERPRINT_MAX_DEPTH = 3;
const METADATA_FINGERPRINT_MAX_KEYS = 24;
const METADATA_FINGERPRINT_MAX_ARRAY_ITEMS = 24;
const metadataFingerprintCache = new WeakMap<object, string>();
const EMPTY_OUTBOX_STATUS: OutboxStatus = {
  pendingTotal: 0,
  pendingByQueue: {},
  oldestEventAt: null,
  newestEventAt: null,
  replayStatus: 'idle',
  lastReplayAttemptAt: null,
  lastReplaySuccessAt: null,
  lastReplayFailureAt: null,
  lastReplayError: null,
};

const EMPTY_DECISION_MUTATION: DecisionMutationState = {
  phase: 'idle',
  action: null,
  targetCount: 0,
  message: null,
  startedAt: null,
  completedAt: null,
};
const EMPTY_CHAT_SNAPSHOT: LiveChatSnapshot = {
  threads: [],
  total: 0,
  updatedAt: null,
};

const SESSION_STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  active: 0,
  queued: 1,
  in_progress: 1,
  working: 1,
  planning: 1,
  handoff: 1,
  review: 2,
  pending: 2,
  blocked: 3,
  failed: 4,
  cancelled: 5,
  paused: 6,
  completed: 6,
  archived: 7,
};

const LIVE_SESSION_STATUSES = new Set([
  'running',
  'active',
  'queued',
  'in_progress',
  'working',
  'planning',
  'handoff',
  'review',
  'pending',
  'blocked',
]);

const SESSION_CARRYOVER_WINDOW_MS = 10 * 60_000;

function isAbortLikeMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('aborterror') ||
    normalized.includes('signal is aborted') ||
    normalized.includes('aborted') ||
    normalized.includes('request cancelled') ||
    normalized.includes('request canceled')
  );
}

function summarizeSnapshotFailureMessages(errors: string[]): string {
  const cleaned = errors
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    return 'Live data is unavailable right now. OrgX Live will retry automatically.';
  }

  const lowered = cleaned.map((entry) => entry.toLowerCase());
  const allTimedOut = lowered.every(
    (entry) =>
      entry.includes('timed out') ||
      entry.includes('timeout') ||
      entry.includes('signal is aborted') ||
      entry.includes('request cancelled') ||
      entry.includes('request canceled')
  );
  if (allTimedOut) {
    return 'Live sync is taking longer than expected. OrgX Live is retrying in the background.';
  }

  if (lowered.some((entry) => entry.includes('unknown api endpoint'))) {
    return 'This plugin runtime is missing required live routes. Restart the plugin, then update if needed.';
  }

  if (lowered.some((entry) => entry.includes('unauthorized') || entry.includes('forbidden'))) {
    return 'OrgX authorization needs attention. Reconnect your API key in Settings.';
  }

  const uniqueDetails = Array.from(
    new Set(
      cleaned.map((entry) => {
        const withoutLabel = entry.replace(/^[^:]+:\s*/, '').trim();
        return withoutLabel.length > 0 ? withoutLabel : entry;
      })
    )
  );
  return uniqueDetails
    .slice(0, 2)
    .map((entry) => humanizeWarning(entry))
    .filter((entry) => entry.length > 0)
    .join(' ');
}

function formatDegradedReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return '';
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('request canceled') ||
    normalized.includes('signal is aborted')
  ) {
    return 'Live sync is slower than expected. Some panels may refresh a few seconds late.';
  }
  if (normalized.includes('unauthorized') || normalized.includes('forbidden')) {
    return 'OrgX authorization needs attention. Reconnect your API key in Settings.';
  }
  if (normalized.includes('unknown api endpoint') || normalized.includes('route is unavailable')) {
    return 'This plugin runtime is missing required live routes. Restart the plugin after updating.';
  }
  const compact = reason
    .replace(/^[^:]+:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return humanizeWarning(compact.length > 0 ? compact : reason.trim());
}

function summarizeDegradedReasons(reasons: string[]): string[] {
  const mapped = reasons
    .map((entry) => formatDegradedReason(entry))
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(mapped)).slice(0, 2);
}

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

function normalizeSessionStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toLowerCase();
}

function isLiveSession(node: SessionTreeResponse['nodes'][number]): boolean {
  return LIVE_SESSION_STATUSES.has(normalizeSessionStatus(node.status));
}

function sessionIdentityKeys(
  node: SessionTreeResponse['nodes'][number]
): string[] {
  const keys: string[] = [];
  if (node.id) keys.push(`id:${node.id}`);
  if (node.runId) keys.push(`run:${node.runId}`);
  return keys;
}

function mergeSessionSnapshots(
  previous: SessionTreeResponse,
  incoming: SessionTreeResponse
): SessionTreeResponse {
  if (!previous.nodes.length) return incoming;
  if (!incoming.nodes.length) {
    const now = Date.now();
    const carryNodes = previous.nodes.filter((node) => {
      const lastTouched = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
      if (isLiveSession(node)) return true;
      const isTerminal = ['completed', 'archived', 'failed'].includes(
        (node.status ?? '').toLowerCase()
      );
      const effectiveWindow = isTerminal
        ? SESSION_CARRYOVER_WINDOW_MS / 3
        : SESSION_CARRYOVER_WINDOW_MS;
      return now - lastTouched <= effectiveWindow;
    });
    if (!carryNodes.length) return incoming;

    const nodeIds = new Set(carryNodes.map((node) => node.id));
    const groupIds = new Set(carryNodes.map((node) => node.groupId));
    return {
      nodes: carryNodes.sort(compareSessionsByPriority),
      edges: previous.edges.filter(
        (edge) => nodeIds.has(edge.parentId) && nodeIds.has(edge.childId)
      ),
      groups: previous.groups.filter((group) => groupIds.has(group.id)),
    };
  }

  const incomingIdentity = new Set<string>();
  const nodes = [...incoming.nodes];

  for (const node of incoming.nodes) {
    for (const key of sessionIdentityKeys(node)) {
      incomingIdentity.add(key);
    }
  }

  const now = Date.now();
  const carryoverNodes: SessionTreeResponse['nodes'] = [];
  for (const node of previous.nodes) {
    const hasIdentity = sessionIdentityKeys(node).some((key) =>
      incomingIdentity.has(key)
    );
    if (hasIdentity) continue;

    const lastTouched = toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
    const isTerminal = ['completed', 'archived', 'failed'].includes(
      (node.status ?? '').toLowerCase()
    );
    const effectiveWindow = isTerminal
      ? SESSION_CARRYOVER_WINDOW_MS / 3
      : SESSION_CARRYOVER_WINDOW_MS;
    const withinWindow = now - lastTouched <= effectiveWindow;
    if (isLiveSession(node) || withinWindow) {
      carryoverNodes.push(node);
      nodes.push(node);
      for (const key of sessionIdentityKeys(node)) {
        incomingIdentity.add(key);
      }
    }
  }

  if (!carryoverNodes.length) {
    return incoming;
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const prevGroupById = new Map(previous.groups.map((group) => [group.id, group]));
  const incomingGroupById = new Map(incoming.groups.map((group) => [group.id, group]));
  const groups = [...incoming.groups];

  for (const node of carryoverNodes) {
    if (incomingGroupById.has(node.groupId)) continue;
    const fallbackGroup =
      prevGroupById.get(node.groupId) ??
      {
        id: node.groupId,
        label: node.groupLabel || node.agentName || 'Ungrouped',
        status: null,
      };
    incomingGroupById.set(node.groupId, fallbackGroup);
    groups.push(fallbackGroup);
  }

  const edgeKey = (edge: SessionTreeResponse['edges'][number]) =>
    `${edge.parentId}->${edge.childId}`;
  const seenEdges = new Set<string>();
  const edges: SessionTreeResponse['edges'] = [];

  for (const edge of incoming.edges) {
    if (!nodeIds.has(edge.parentId) || !nodeIds.has(edge.childId)) continue;
    const key = edgeKey(edge);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  for (const edge of previous.edges) {
    if (!nodeIds.has(edge.parentId) || !nodeIds.has(edge.childId)) continue;
    const key = edgeKey(edge);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  return {
    nodes: nodes.sort(compareSessionsByPriority),
    edges,
    groups,
  };
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
      a[i].title !== b[i].title ||
      a[i].requesterAgentId !== b[i].requesterAgentId ||
      a[i].requesterAgentName !== b[i].requesterAgentName ||
      a[i].executorAgentId !== b[i].executorAgentId ||
      a[i].executorAgentName !== b[i].executorAgentName
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

function normalizeOutboxStatus(input: OutboxStatus | null | undefined): OutboxStatus {
  if (!input || typeof input !== 'object') {
    return EMPTY_OUTBOX_STATUS;
  }

  const pendingByQueue =
    input.pendingByQueue && typeof input.pendingByQueue === 'object'
      ? Object.fromEntries(
          Object.entries(input.pendingByQueue)
            .filter(([key]) => typeof key === 'string' && key.length > 0)
            .map(([key, value]) => [key, Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0])
        )
      : {};

  const replayStatus =
    input.replayStatus === 'running' ||
    input.replayStatus === 'success' ||
    input.replayStatus === 'error'
      ? input.replayStatus
      : 'idle';

  return {
    pendingTotal: Number.isFinite(input.pendingTotal)
      ? Math.max(0, Math.floor(input.pendingTotal))
      : Object.values(pendingByQueue).reduce((sum, value) => sum + value, 0),
    pendingByQueue,
    oldestEventAt: input.oldestEventAt ?? null,
    newestEventAt: input.newestEventAt ?? null,
    replayStatus,
    lastReplayAttemptAt: input.lastReplayAttemptAt ?? null,
    lastReplaySuccessAt: input.lastReplaySuccessAt ?? null,
    lastReplayFailureAt: input.lastReplayFailureAt ?? null,
    lastReplayError: input.lastReplayError ?? null,
  };
}

function sameOutboxShape(a: OutboxStatus, b: OutboxStatus): boolean {
  if (
    a.pendingTotal !== b.pendingTotal ||
    a.oldestEventAt !== b.oldestEventAt ||
    a.newestEventAt !== b.newestEventAt ||
    a.replayStatus !== b.replayStatus ||
    a.lastReplayAttemptAt !== b.lastReplayAttemptAt ||
    a.lastReplaySuccessAt !== b.lastReplaySuccessAt ||
    a.lastReplayFailureAt !== b.lastReplayFailureAt ||
    a.lastReplayError !== b.lastReplayError
  ) {
    return false;
  }

  const aKeys = Object.keys(a.pendingByQueue);
  const bKeys = Object.keys(b.pendingByQueue);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a.pendingByQueue[key] !== b.pendingByQueue[key]) {
      return false;
    }
  }
  return true;
}

function metadataFingerprint(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  const valueType = typeof value;
  if (valueType === 'string') return `s:${value}`;
  if (valueType === 'number') return `n:${Number.isFinite(value as number) ? String(value) : 'nan'}`;
  if (valueType === 'boolean') return `b:${value ? '1' : '0'}`;
  if (valueType === 'bigint') return `i:${String(value)}`;
  if (valueType !== 'object') return `${valueType}:${String(value)}`;

  const objectValue = value as object;
  const cached = metadataFingerprintCache.get(objectValue);
  if (cached) return cached;

  if (depth >= METADATA_FINGERPRINT_MAX_DEPTH) {
    const cutoff = Array.isArray(value) ? '[…]' : '{…}';
    metadataFingerprintCache.set(objectValue, cutoff);
    return cutoff;
  }

  metadataFingerprintCache.set(objectValue, Array.isArray(value) ? '[]' : '{}');

  if (Array.isArray(value)) {
    const preview = value
      .slice(0, METADATA_FINGERPRINT_MAX_ARRAY_ITEMS)
      .map((entry) => metadataFingerprint(entry, depth + 1))
      .join(',');
    const suffix =
      value.length > METADATA_FINGERPRINT_MAX_ARRAY_ITEMS ? ',…' : '';
    const fingerprint = `[${preview}${suffix}]`;
    metadataFingerprintCache.set(objectValue, fingerprint);
    return fingerprint;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const limitedKeys = keys.slice(0, METADATA_FINGERPRINT_MAX_KEYS);
  const body = limitedKeys
    .map((key) => `${key}:${metadataFingerprint(record[key], depth + 1)}`)
    .join('|');
  const suffix = keys.length > limitedKeys.length ? '|…' : '';
  const fingerprint = `{${body}${suffix}}`;
  metadataFingerprintCache.set(objectValue, fingerprint);
  return fingerprint;
}

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function semanticActivityKey(item: LiveActivityItem): string | null {
  const metadata = asMetadataRecord(item.metadata);
  const eventRaw = metadata?.event;
  const event = typeof eventRaw === 'string' ? eventRaw.trim().toLowerCase() : '';

  const runLike =
    (typeof item.runId === 'string' && item.runId.trim().length > 0
      ? item.runId.trim()
      : null) ??
    metadataString(metadata, [
      'run_id',
      'runId',
      'slice_run_id',
      'sliceRunId',
      'active_run_id',
      'activeRunId',
      'last_run_id',
      'lastRunId',
    ]);
  const correlationId = metadataString(metadata, ['correlation_id', 'correlationId']);
  const initiativeId =
    (typeof item.initiativeId === 'string' && item.initiativeId.trim().length > 0
      ? item.initiativeId.trim()
      : null) ??
    metadataString(metadata, ['initiative_id', 'initiativeId']);
  const workstreamId = metadataString(metadata, ['workstream_id', 'workstreamId']);
  const taskId = metadataString(metadata, ['task_id', 'taskId']);
  const stopReason = metadataString(metadata, ['stop_reason', 'stopReason']);
  const parsedStatus = metadataString(metadata, ['parsed_status', 'parsedStatus']);
  const title = (item.title ?? '').trim().toLowerCase();

  if (!event && !runLike && !correlationId) return null;
  if (!runLike && !correlationId && !workstreamId && !taskId) return null;

  return [
    event,
    initiativeId ?? '',
    workstreamId ?? '',
    taskId ?? '',
    runLike ?? '',
    correlationId ?? '',
    stopReason ?? '',
    parsedStatus ?? '',
    title,
  ].join('|');
}

function activityRichness(item: LiveActivityItem): number {
  let score = 0;
  const meta = item.metadata as Record<string, unknown> | undefined;
  if (meta) score += Object.keys(meta).length;
  if (item.summary) score += 2;
  if (item.description) score += 2;
  if (item.agentName) score += 1;
  if (item.runtimeLabel) score += 1;
  if (item.runtimeProvider) score += 1;
  if (item.phase) score += 1;
  if (item.state) score += 1;
  return score;
}

function dedupeActivitySemantically(
  source: LiveActivityItem[],
  maxActivityItems: number
): LiveActivityItem[] {
  const seenIds = new Set<string>();
  const seenSemantic = new Set<string>();
  const semanticIdx = new Map<string, number>();
  const deduped: LiveActivityItem[] = [];
  for (const item of source) {
    if (seenIds.has(item.id)) {
      const existingIdx = deduped.findIndex(d => d.id === item.id);
      if (existingIdx >= 0 && activityRichness(item) > activityRichness(deduped[existingIdx])) {
        deduped[existingIdx] = item;
      }
      continue;
    }
    seenIds.add(item.id);
    const semanticKey = semanticActivityKey(item);
    if (semanticKey && seenSemantic.has(semanticKey)) {
      const existingIdx = semanticIdx.get(semanticKey)!;
      if (activityRichness(item) > activityRichness(deduped[existingIdx])) {
        deduped[existingIdx] = item;
      }
      continue;
    }
    if (semanticKey) {
      seenSemantic.add(semanticKey);
      semanticIdx.set(semanticKey, deduped.length);
    }
    deduped.push(item);
    if (deduped.length >= maxActivityItems) break;
  }
  return deduped;
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
  const metadataSignatures = new Map<string, string>();
  for (const item of current) {
    byId.set(item.id, item);
    metadataSignatures.set(item.id, metadataFingerprint(item.metadata));
  }

  let changed = false;
  for (const item of incoming) {
    const existing = byId.get(item.id);
    const incomingMetadataSignature = metadataFingerprint(item.metadata);
    if (!existing) {
      byId.set(item.id, item);
      metadataSignatures.set(item.id, incomingMetadataSignature);
      changed = true;
      continue;
    }

    if (
      existing.timestamp !== item.timestamp ||
      existing.type !== item.type ||
      existing.title !== item.title ||
      existing.description !== item.description ||
      existing.summary !== item.summary ||
      existing.kind !== item.kind ||
      existing.agentId !== item.agentId ||
      existing.agentName !== item.agentName ||
      existing.requesterAgentId !== item.requesterAgentId ||
      existing.requesterAgentName !== item.requesterAgentName ||
      existing.executorAgentId !== item.executorAgentId ||
      existing.executorAgentName !== item.executorAgentName ||
      existing.runId !== item.runId ||
      existing.initiativeId !== item.initiativeId ||
      existing.decisionRequired !== item.decisionRequired ||
      metadataSignatures.get(item.id) !== incomingMetadataSignature
    ) {
      byId.set(item.id, item);
      metadataSignatures.set(item.id, incomingMetadataSignature);
      changed = true;
    }
  }

  if (!changed) {
    return current;
  }

  const mergedSorted = Array.from(byId.values()).sort((a, b) => {
    const timestampDelta = toEpoch(b.timestamp) - toEpoch(a.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
    return b.id.localeCompare(a.id);
  });
  const merged = dedupeActivitySemantically(mergedSorted, maxActivityItems);

  return sameActivityShape(current, merged) ? current : merged;
}

function normalizeActivity(source: LiveActivityItem[], maxActivityItems: number): LiveActivityItem[] {
  const sorted = [...source].sort((a, b) => {
    const timestampDelta = toEpoch(b.timestamp) - toEpoch(a.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
    return b.id.localeCompare(a.id);
  });

  return dedupeActivitySemantically(sorted, maxActivityItems);
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

function hasLiveAgentSignal(agent: LiveSnapshotAgent, status: string): boolean {
  if (LIVE_SESSION_STATUSES.has(status)) return true;
  if (agent.runId && agent.runId.trim().length > 0) return true;
  if (agent.currentTask && agent.currentTask.trim().length > 0) return true;
  return false;
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
  agents: LiveSnapshotResponse['agents'] | undefined,
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
    const nowIso = new Date().toISOString();
    const liveAgentSignal = hasLiveAgentSignal(agent, status);
    const fallbackTimestamp = agent.startedAt ?? (liveAgentSignal ? nowIso : null);
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
        startedAt: fallbackTimestamp,
        updatedAt: fallbackTimestamp,
        lastEventAt: fallbackTimestamp,
        lastEventSummary: agent.currentTask,
        blockers: coerceBlockers(agent.blockers),
      });
      continue;
    }

    if (!existing.agentName && agent.name) existing.agentName = agent.name;
    if (!existing.agentId) existing.agentId = agent.id;
    if (!existing.title || existing.title === existing.runId) existing.title = title;
    if (liveAgentSignal) {
      existing.updatedAt = fallbackTimestamp ?? existing.updatedAt ?? nowIso;
      existing.lastEventAt = fallbackTimestamp ?? existing.lastEventAt ?? nowIso;
    }
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

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options?: FetchJsonOptions
): Promise<JsonFetchResult<T>> {
  const timeoutMs =
    typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(100, Math.floor(options.timeoutMs))
      : 0;
  const timeoutController = timeoutMs > 0 ? new AbortController() : null;
  const upstreamSignal = init?.signal;
  const signal = timeoutController?.signal ?? upstreamSignal;
  const requestInit: RequestInit = signal ? { ...(init ?? {}), signal } : (init ?? {});
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let detachAbortListener: (() => void) | null = null;

  if (timeoutController) {
    if (upstreamSignal?.aborted) {
      timeoutController.abort();
    } else if (upstreamSignal) {
      const onAbort = () => timeoutController.abort();
      upstreamSignal.addEventListener('abort', onAbort, { once: true });
      detachAbortListener = () => upstreamSignal.removeEventListener('abort', onAbort);
    }
    timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  }

  try {
    const response = await fetch(url, requestInit);
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
    const rawError = err instanceof Error ? err.message : 'Network error';
    const timedOut =
      Boolean(timeoutController?.signal.aborted) && !Boolean(upstreamSignal?.aborted);
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      isAbortLikeMessage(rawError)
    ) {
      return {
        ok: false,
        status: 0,
        data: null,
        error:
          timedOut && timeoutMs > 0
            ? `request timed out after ${timeoutMs}ms`
            : 'request cancelled',
      };
    }
    return {
      ok: false,
      status: 0,
      data: null,
      error: rawError,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (detachAbortListener) detachAbortListener();
  }
}

function buildLiveData(
  sessions: SessionTreeResponse,
  activity: LiveActivityItem[],
  handoffs: HandoffSummary[],
  decisions: LiveDecision[],
  sliceRuns: SliceRunProjection[] = [],
  outbox: OutboxStatus = EMPTY_OUTBOX_STATUS,
  generatedAt: string | null = null,
  snapshotVersion = 1,
  runtimeInstances: RuntimeInstance[] = [],
  chat: LiveChatSnapshot = EMPTY_CHAT_SNAPSHOT,
  extra?: {
    workSliceProjections?: WorkSliceProjectionV2[];
    timelineNarrative?: SliceTimelineNarrativeProjectionV2[];
    nextUpByInitiative?: NextUpInitiativeProjection[];
    runningWorkSlices?: number;
    needsInputTotal?: number;
    failedActionableTotal?: number;
    completedTodayTotal?: number;
    consistencyFlags?: string[];
    dataHealth?: SliceDataHealthSummary;
  }
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
    lastSnapshotAt: generatedAt,
    snapshotVersion,
    sessions,
    activity,
    handoffs,
    decisions,
    sliceRuns,
    outbox: normalizeOutboxStatus(outbox),
    chat: normalizeChatSnapshot(chat),
    runtimeInstances,
    workSliceProjections: extra?.workSliceProjections ?? [],
    timelineNarrative: extra?.timelineNarrative ?? [],
    nextUpByInitiative: extra?.nextUpByInitiative ?? [],
    runningWorkSlices: extra?.runningWorkSlices ?? 0,
    needsInputTotal: extra?.needsInputTotal ?? 0,
    failedActionableTotal: extra?.failedActionableTotal ?? 0,
    completedTodayTotal: extra?.completedTodayTotal ?? 0,
    consistencyFlags: extra?.consistencyFlags ?? [],
    dataHealth: extra?.dataHealth,
  };
}

function normalizeRuntimeInstances(input: RuntimeInstance[] | null | undefined): RuntimeInstance[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const byId = new Map<string, RuntimeInstance>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id) continue;
    byId.set(id, item);
  }
  return Array.from(byId.values()).sort(
    (a, b) => toEpoch(b.lastEventAt ?? b.lastHeartbeatAt) - toEpoch(a.lastEventAt ?? a.lastHeartbeatAt)
  );
}

function sameRuntimeInstancesShape(
  left: RuntimeInstance[] | undefined,
  right: RuntimeInstance[] | undefined
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].state !== b[i].state ||
      a[i].lastEventAt !== b[i].lastEventAt ||
      a[i].runId !== b[i].runId ||
      a[i].progressPct !== b[i].progressPct
    ) {
      return false;
    }
  }
  return true;
}

function normalizeChatThreads(input: ChatThreadSummary[] | null | undefined): ChatThreadSummary[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const byId = new Map<string, ChatThreadSummary>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id) continue;
    byId.set(id, {
      ...item,
      id,
      watcherIds: Array.isArray(item.watcherIds) ? item.watcherIds.filter(Boolean) : [],
      watcherNames: Array.isArray(item.watcherNames) ? item.watcherNames.filter(Boolean) : [],
      latestLaunch:
        item.latestLaunch && typeof item.latestLaunch === 'object'
          ? {
              ...item.latestLaunch,
              watcherIds: Array.isArray(item.latestLaunch.watcherIds)
                ? item.latestLaunch.watcherIds.filter(Boolean)
                : [],
              watcherNames: Array.isArray(item.latestLaunch.watcherNames)
                ? item.latestLaunch.watcherNames.filter(Boolean)
                : [],
              warnings: Array.isArray(item.latestLaunch.warnings)
                ? item.latestLaunch.warnings.filter(Boolean)
                : [],
            }
          : null,
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => toEpoch(b.lastActivityAt ?? b.updatedAt) - toEpoch(a.lastActivityAt ?? a.updatedAt)
  );
}

function normalizeChatSnapshot(input: LiveChatSnapshot | null | undefined): LiveChatSnapshot {
  if (!input || typeof input !== 'object') return EMPTY_CHAT_SNAPSHOT;
  const threads = normalizeChatThreads(Array.isArray(input.threads) ? input.threads : []);
  const total =
    typeof input.total === 'number' && Number.isFinite(input.total)
      ? Math.max(threads.length, Math.floor(input.total))
      : threads.length;
  return {
    threads,
    total,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  };
}

function sameChatSnapshotShape(
  left: LiveChatSnapshot | undefined,
  right: LiveChatSnapshot | undefined
): boolean {
  const a = left ?? EMPTY_CHAT_SNAPSHOT;
  const b = right ?? EMPTY_CHAT_SNAPSHOT;
  if (a.total !== b.total || a.updatedAt !== b.updatedAt) return false;
  if (a.threads.length !== b.threads.length) return false;
  for (let i = 0; i < a.threads.length; i += 1) {
    const l = a.threads[i];
    const r = b.threads[i];
    if (
      l.id !== r.id ||
      l.status !== r.status ||
      l.lastActivityAt !== r.lastActivityAt ||
      l.lastSnippet !== r.lastSnippet ||
      l.assigneeId !== r.assigneeId ||
      l.launchCount !== r.launchCount ||
      l.messageCount !== r.messageCount
    ) {
      return false;
    }
  }
  return true;
}

function normalizeSliceRuns(input: SliceRunProjection[] | null | undefined): SliceRunProjection[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const byId = new Map<string, SliceRunProjection>();
  const normalizeLineageIds = (
    values: unknown,
    fallback?: string | null
  ): string[] => {
    const out: string[] = [];
    const push = (entry: unknown) => {
      if (typeof entry !== 'string') return;
      const trimmed = entry.trim();
      if (!trimmed) return;
      if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
      out.push(trimmed);
    };
    if (Array.isArray(values)) {
      for (const entry of values) push(entry);
    } else if (typeof values === 'string') {
      for (const entry of values.split(/[\n,;]+/g)) push(entry);
    }
    if (fallback) push(fallback);
    return out;
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const sliceKind =
      (typeof (item as { sliceKind?: unknown }).sliceKind === 'string'
        ? (item as { sliceKind?: string }).sliceKind
        : typeof (item as { slice_kind?: unknown }).slice_kind === 'string'
          ? (item as { slice_kind?: string }).slice_kind
          : null);
    const normalizedSliceKind = sliceKind?.trim().toLowerCase() ?? null;
    if (normalizedSliceKind && normalizedSliceKind !== 'work_slice') continue;
    const sliceRunId =
      (typeof item.sliceRunId === 'string' && item.sliceRunId.trim().length > 0
        ? item.sliceRunId.trim()
        : typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id.trim()
          : null);
    if (!sliceRunId) continue;
    const initiativeIds = normalizeLineageIds(item.initiativeIds, item.initiativeId ?? null);
    const workstreamIds = normalizeLineageIds(item.workstreamIds, item.workstreamId ?? null);
    const iwmtIds = normalizeLineageIds(item.iwmtIds, item.iwmtId ?? null);
    const initiativeId =
      (typeof item.initiativeId === 'string' && item.initiativeId.trim().length > 0
        ? item.initiativeId.trim()
        : initiativeIds[0] ?? null);
    const workstreamId =
      (typeof item.workstreamId === 'string' && item.workstreamId.trim().length > 0
        ? item.workstreamId.trim()
        : workstreamIds[0] ?? null);
    const iwmtId =
      (typeof item.iwmtId === 'string' && item.iwmtId.trim().length > 0
        ? item.iwmtId.trim()
        : iwmtIds[0] ?? null);
    byId.set(sliceRunId, {
      ...item,
      id: sliceRunId,
      sliceRunId,
      sliceKind: normalizedSliceKind === 'work_slice' ? 'work_slice' : undefined,
      initiativeId,
      initiativeIds,
      workstreamId,
      workstreamIds,
      iwmtId,
      iwmtIds,
      artifacts: Array.isArray(item.artifacts) ? item.artifacts : [],
      decisionOptions: Array.isArray(item.decisionOptions) ? item.decisionOptions : [],
      taskIds: Array.isArray(item.taskIds) ? item.taskIds : [],
      milestoneIds: Array.isArray(item.milestoneIds) ? item.milestoneIds : [],
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => toEpoch(b.updatedAt ?? b.lastEventAt) - toEpoch(a.updatedAt ?? a.lastEventAt)
  );
}

function normalizeWorkSliceProjections(
  input: WorkSliceProjectionV2[] | null | undefined
): WorkSliceProjectionV2[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const byId = new Map<string, WorkSliceProjectionV2>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const sliceRunId =
      typeof item.sliceRunId === 'string' && item.sliceRunId.trim().length > 0
        ? item.sliceRunId.trim()
        : null;
    if (!sliceRunId) continue;
    const lineage = item.lineage && typeof item.lineage === 'object' ? item.lineage : null;
    byId.set(sliceRunId, {
      ...item,
      sliceRunId,
      consistencyFlags: Array.isArray(item.consistencyFlags) ? item.consistencyFlags : [],
      lineage: {
        initiativeIds: Array.isArray(lineage?.initiativeIds) ? lineage.initiativeIds : [],
        initiativeTitles: Array.isArray(lineage?.initiativeTitles) ? lineage.initiativeTitles : [],
        workstreamIds: Array.isArray(lineage?.workstreamIds) ? lineage.workstreamIds : [],
        workstreamTitles: Array.isArray(lineage?.workstreamTitles) ? lineage.workstreamTitles : [],
        taskIds: Array.isArray(lineage?.taskIds) ? lineage.taskIds : [],
        milestoneIds: Array.isArray(lineage?.milestoneIds) ? lineage.milestoneIds : [],
        iwmtIds: Array.isArray(lineage?.iwmtIds) ? lineage.iwmtIds : [],
        sliceRunId,
        sessionId: typeof lineage?.sessionId === 'string' ? lineage.sessionId : null,
      },
      artifacts: Array.isArray(item.artifacts) ? item.artifacts : [],
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => toEpoch(b.updatedAt ?? b.completedAt ?? b.failedAt) - toEpoch(a.updatedAt ?? a.completedAt ?? a.failedAt)
  );
}

function normalizeTimelineNarrative(
  input: SliceTimelineNarrativeProjectionV2[] | null | undefined
): SliceTimelineNarrativeProjectionV2[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const byId = new Map<string, SliceTimelineNarrativeProjectionV2>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const sliceRunId =
      typeof item.sliceRunId === 'string' && item.sliceRunId.trim().length > 0
        ? item.sliceRunId.trim()
        : null;
    if (!sliceRunId) continue;
    byId.set(sliceRunId, {
      ...item,
      sliceRunId,
      highlights: Array.isArray(item.highlights) ? item.highlights : [],
      technicalTrace: item.technicalTrace ?? { eventCount: 0, eventIds: [] },
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => toEpoch(b.occurredAt) - toEpoch(a.occurredAt)
  );
}

function normalizeNextUpByInitiative(
  input: NextUpInitiativeProjection[] | null | undefined
): NextUpInitiativeProjection[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  return input
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      initiativeId:
        typeof item.initiativeId === 'string' && item.initiativeId.trim().length > 0
          ? item.initiativeId.trim()
          : null,
      initiativeTitle:
        typeof item.initiativeTitle === 'string' && item.initiativeTitle.trim().length > 0
          ? item.initiativeTitle.trim()
          : 'Unscoped initiative',
      pendingCount:
        typeof item.pendingCount === 'number' && Number.isFinite(item.pendingCount)
          ? Math.max(0, Math.floor(item.pendingCount))
          : 0,
      queue: Array.isArray(item.queue) ? item.queue : [],
    }))
    .sort((a, b) => b.pendingCount - a.pendingCount);
}

function sliceRunsFromWorkSliceProjections(
  projections: WorkSliceProjectionV2[]
): SliceRunProjection[] {
  if (!Array.isArray(projections) || projections.length === 0) return [];
  const mapped: SliceRunProjection[] = [];
  for (const projection of projections) {
    if (projection.sliceKind !== 'work_slice') continue;
    const initiativeId = projection.lineage.initiativeIds[0] ?? null;
    const workstreamId = projection.lineage.workstreamIds[0] ?? null;
    const workstreamTitle =
      projection.lineage.workstreamTitles[0] ??
      projection.lineage.workstreamIds[0] ??
      null;
    const status: SliceRunProjection['status'] =
      projection.lifecycleState === 'completed' && projection.outcomeState === 'succeeded_without_artifacts'
        ? 'needs_review'
        : projection.lifecycleState;
    const actionType = projection.actionContract?.actionType ?? null;
    const primaryAction: SliceRunProjection['primaryAction'] =
      actionType === 'open_artifact' ||
      actionType === 'open_logs' ||
      actionType === 'open_session' ||
      actionType === 'open_run' ||
      actionType === 'open_workstream' ||
      actionType === 'open_task' ||
      actionType === 'open_initiative' ||
      actionType === 'open_pr' ||
      actionType === 'open_diff' ||
      actionType === 'open_branch'
        ? 'open_artifact'
        : actionType === 'approve' ||
            actionType === 'reject' ||
            actionType === 'provide_context' ||
            actionType === 'request_info' ||
            actionType === 'confirm_scope' ||
            actionType === 'connect_provider' ||
            actionType === 'refresh_credentials' ||
            actionType === 'reassign' ||
            actionType === 'escalate'
          ? 'resolve_decision'
          : actionType === 'retry' ||
              actionType === 'resume' ||
              actionType === 'start' ||
              actionType === 'auto_fix'
            ? 'retry_slice'
            : projection.outcomeState === 'succeeded_without_artifacts'
              ? 'review_output'
              : 'none';
    mapped.push({
      id: projection.sliceRunId,
      sliceRunId: projection.sliceRunId,
      sliceKind: 'work_slice',
      runId: projection.runId,
      initiativeId,
      initiativeIds: projection.lineage.initiativeIds,
      workstreamId,
      workstreamIds: projection.lineage.workstreamIds,
      iwmtId: projection.lineage.iwmtIds[0] ?? null,
      iwmtIds: projection.lineage.iwmtIds,
      workstreamTitle,
      taskIds: projection.lineage.taskIds,
      milestoneIds: projection.lineage.milestoneIds,
      status,
      statusExplainer: projection.statusExplainer,
      primaryAction,
      hasArtifact: projection.hasArtifact,
      artifactCount: projection.artifactCount,
      artifacts: projection.artifacts.map((artifact) => ({
        id: artifact.artifactId,
        type: artifact.type,
        title: artifact.title,
        url: artifact.url,
        createdAt: artifact.producedAt,
      })),
      decisionCount: projection.outcomeState === 'needs_input' ? 1 : 0,
      blockingDecisionCount: projection.outcomeState === 'needs_input' ? 1 : 0,
      decisionOptions: [],
      sourceClient: projection.sourceClient,
      runtimeState: projection.runtimeState,
      startedAt: null,
      updatedAt: projection.updatedAt,
      completedAt: projection.completedAt,
      failedAt: projection.failedAt,
      archivedAt: projection.archivedAt,
      lastEventAt: projection.updatedAt,
      lastEventSummary: projection.statusExplainer,
      correlationId: projection.sliceRunId,
      confidence: projection.confidence,
    });
  }
  return normalizeSliceRuns(mapped);
}

function sameSliceRunsShape(left: SliceRunProjection[], right: SliceRunProjection[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.sliceRunId !== b.sliceRunId ||
      a.status !== b.status ||
      a.updatedAt !== b.updatedAt ||
      a.lastEventAt !== b.lastEventAt ||
      a.artifactCount !== b.artifactCount ||
      a.decisionCount !== b.decisionCount ||
      a.blockingDecisionCount !== b.blockingDecisionCount ||
      a.runtimeState !== b.runtimeState
    ) {
      return false;
    }
  }
  return true;
}

function sameWorkSliceProjectionShape(
  left: WorkSliceProjectionV2[],
  right: WorkSliceProjectionV2[]
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.sliceRunId !== b.sliceRunId ||
      a.lifecycleState !== b.lifecycleState ||
      a.outcomeState !== b.outcomeState ||
      a.updatedAt !== b.updatedAt ||
      a.artifactCount !== b.artifactCount ||
      a.lineage.sessionId !== b.lineage.sessionId
    ) {
      return false;
    }
  }
  return true;
}

function sameTimelineNarrativeShape(
  left: SliceTimelineNarrativeProjectionV2[],
  right: SliceTimelineNarrativeProjectionV2[]
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.sliceRunId !== b.sliceRunId ||
      a.occurredAt !== b.occurredAt ||
      a.outcome.state !== b.outcome.state ||
      a.outcome.artifactCount !== b.outcome.artifactCount
    ) {
      return false;
    }
  }
  return true;
}

function sameNextUpByInitiativeShape(
  left: NextUpInitiativeProjection[],
  right: NextUpInitiativeProjection[]
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.initiativeId !== b.initiativeId ||
      a.pendingCount !== b.pendingCount ||
      a.queue.length !== b.queue.length
    ) {
      return false;
    }
  }
  return true;
}

function sameStringArrayShape(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameDataHealthShape(
  left: SliceDataHealthSummary | undefined,
  right: SliceDataHealthSummary | undefined
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.status === right.status &&
    left.totals.slices === right.totals.slices &&
    left.totals.missingTerminal === right.totals.missingTerminal &&
    left.totals.lineageGap === right.totals.lineageGap &&
    left.totals.artifactMismatch === right.totals.artifactMismatch &&
    left.totals.invalidActor === right.totals.invalidActor
  );
}

export function useLiveData(options: UseLiveDataOptions = {}) {
  const {
    enabled = true,
    pollInterval = DEFAULT_POLL_INTERVAL,
    useMock = false,
    enableDecisions = true,
    initiativeId = null,
    projectId = null,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxActivityItems = DEFAULT_MAX_ACTIVITY_ITEMS,
    maxHandoffs = DEFAULT_MAX_HANDOFFS,
    maxDecisions = DEFAULT_MAX_DECISIONS,
    batchWindowMs = DEFAULT_BATCH_WINDOW_MS,
  } = options;
  const normalizedInitiativeId =
    typeof initiativeId === 'string' && initiativeId.trim().length > 0
      ? initiativeId.trim()
      : null;
  const normalizedProjectId =
    typeof projectId === 'string' && projectId.trim().length > 0
      ? projectId.trim()
      : null;

  const [data, setData] = useState<LiveData>(createMockData());
  const [decisionMutation, setDecisionMutation] =
    useState<DecisionMutationState>(EMPTY_DECISION_MUTATION);
  const [isLoading, setIsLoading] = useState(!useMock);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const inFlightSnapshotRef = useRef<Promise<void> | null>(null);
  const inFlightScopeKeyRef = useRef<string | null>(null);
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const lastSuccessAtRef = useRef<number>(0);
  const authBlockedRef = useRef<boolean>(false);
  const scopeKeyRef = useRef<string>(
    `${normalizedInitiativeId ?? '__all__'}::${normalizedProjectId ?? '__all__'}`
  );
  const resetScopeOnNextSnapshotRef = useRef<boolean>(false);
  const decisionMutationResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishDecisionMutation = useCallback(
    (
      next: DecisionMutationState,
      options?: {
        autoResetMs?: number;
      }
    ) => {
      if (decisionMutationResetTimerRef.current) {
        clearTimeout(decisionMutationResetTimerRef.current);
        decisionMutationResetTimerRef.current = null;
      }
      setDecisionMutation(next);
      if (options?.autoResetMs && options.autoResetMs > 0) {
        decisionMutationResetTimerRef.current = setTimeout(() => {
          decisionMutationResetTimerRef.current = null;
          setDecisionMutation(EMPTY_DECISION_MUTATION);
        }, options.autoResetMs);
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      if (decisionMutationResetTimerRef.current) {
        clearTimeout(decisionMutationResetTimerRef.current);
        decisionMutationResetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const scopeKey = `${normalizedInitiativeId ?? '__all__'}::${normalizedProjectId ?? '__all__'}`;
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    resetScopeOnNextSnapshotRef.current = true;
    publishDecisionMutation(EMPTY_DECISION_MUTATION);
    setData((prev) => ({
      ...prev,
      sessions: { nodes: [], edges: [], groups: [] },
      activity: [],
      handoffs: [],
      decisions: [],
      sliceRuns: [],
      chat: EMPTY_CHAT_SNAPSHOT,
      runtimeInstances: [],
      workSliceProjections: [],
      timelineNarrative: [],
      nextUpByInitiative: [],
      runningWorkSlices: 0,
      needsInputTotal: 0,
      failedActionableTotal: 0,
      completedTodayTotal: 0,
      consistencyFlags: [],
      lastActivity: null,
      lastSnapshotAt: null,
      snapshotVersion: (prev.snapshotVersion ?? 0) + 1,
    }));
    setIsLoading(true);
    setError(null);
  }, [normalizedInitiativeId, normalizedProjectId, publishDecisionMutation]);

  const applySnapshot = useCallback(
    (
      sessionsInput: SessionTreeResponse | null,
      activityInput: LiveActivityItem[] | null,
      handoffInput: HandoffSummary[] | null,
      decisionInput: LiveDecision[] | null = null,
      sliceRunsInput: SliceRunProjection[] | null = null,
      outboxInput: OutboxStatus | null = null,
      generatedAtInput: string | null = null,
      runtimeInstancesInput: RuntimeInstance[] | null = null,
      chatInput: LiveChatSnapshot | null = null,
      v2Input: {
        workSliceProjections?: WorkSliceProjectionV2[] | null;
        timelineNarrative?: SliceTimelineNarrativeProjectionV2[] | null;
        nextUpByInitiative?: NextUpInitiativeProjection[] | null;
        runningWorkSlices?: number | null;
        needsInputTotal?: number | null;
        failedActionableTotal?: number | null;
        completedTodayTotal?: number | null;
        consistencyFlags?: string[] | null;
        dataHealth?: SliceDataHealthSummary | null;
      } | null = null
    ) => {
      lastSuccessAtRef.current = Date.now();
      authBlockedRef.current = false;
      setData((prev) => {
        const resetScope = resetScopeOnNextSnapshotRef.current;
        if (resetScope) {
          resetScopeOnNextSnapshotRef.current = false;
        }
        const activity =
          activityInput === null
            ? resetScope
              ? []
              : prev.activity
            : normalizeActivity(activityInput, maxActivityItems);
        const handoffs =
          handoffInput === null
            ? resetScope
              ? []
              : prev.handoffs
            : trimHandoffs(handoffInput, maxHandoffs);
        const sessions = trimSessions(
          sessionsInput === null
            ? resetScope
              ? { nodes: [], edges: [], groups: [] }
              : prev.sessions
            : resetScope
              ? trimSessions(sessionsInput, maxSessions)
              : mergeSessionSnapshots(prev.sessions, trimSessions(sessionsInput, maxSessions)),
          maxSessions
        );
        const decisions =
          decisionInput === null
            ? resetScope
              ? []
              : prev.decisions
            : normalizeDecisions(decisionInput, maxDecisions);
        const sliceRuns =
          sliceRunsInput === null
            ? resetScope
              ? []
              : prev.sliceRuns
            : normalizeSliceRuns(sliceRunsInput);
        const outbox =
          outboxInput === null
            ? resetScope
              ? EMPTY_OUTBOX_STATUS
              : prev.outbox
            : normalizeOutboxStatus(outboxInput);
        const runtimeInstances =
          runtimeInstancesInput === null
            ? resetScope
              ? []
              : prev.runtimeInstances ?? []
            : normalizeRuntimeInstances(runtimeInstancesInput);
        const chat =
          chatInput === null
            ? resetScope
              ? EMPTY_CHAT_SNAPSHOT
              : prev.chat ?? EMPTY_CHAT_SNAPSHOT
            : normalizeChatSnapshot(chatInput);
        const workSliceProjections =
          v2Input?.workSliceProjections == null
            ? resetScope
              ? []
              : prev.workSliceProjections ?? []
            : normalizeWorkSliceProjections(v2Input.workSliceProjections);
        const timelineNarrative =
          v2Input?.timelineNarrative == null
            ? resetScope
              ? []
              : prev.timelineNarrative ?? []
            : normalizeTimelineNarrative(v2Input.timelineNarrative);
        const nextUpByInitiative =
          v2Input?.nextUpByInitiative == null
            ? resetScope
              ? []
              : prev.nextUpByInitiative ?? []
            : normalizeNextUpByInitiative(v2Input.nextUpByInitiative);
        const runningWorkSlices =
          typeof v2Input?.runningWorkSlices === 'number' && Number.isFinite(v2Input.runningWorkSlices)
            ? Math.max(0, Math.floor(v2Input.runningWorkSlices))
            : prev.runningWorkSlices ?? 0;
        const needsInputTotal =
          typeof v2Input?.needsInputTotal === 'number' && Number.isFinite(v2Input.needsInputTotal)
            ? Math.max(0, Math.floor(v2Input.needsInputTotal))
            : prev.needsInputTotal ?? 0;
        const failedActionableTotal =
          typeof v2Input?.failedActionableTotal === 'number' &&
          Number.isFinite(v2Input.failedActionableTotal)
            ? Math.max(0, Math.floor(v2Input.failedActionableTotal))
            : prev.failedActionableTotal ?? 0;
        const completedTodayTotal =
          typeof v2Input?.completedTodayTotal === 'number' &&
          Number.isFinite(v2Input.completedTodayTotal)
            ? Math.max(0, Math.floor(v2Input.completedTodayTotal))
            : prev.completedTodayTotal ?? 0;
        const consistencyFlags =
          v2Input?.consistencyFlags == null
            ? prev.consistencyFlags ?? []
            : v2Input.consistencyFlags.filter((flag): flag is string => typeof flag === 'string');
        const dataHealth =
          v2Input?.dataHealth === undefined || v2Input?.dataHealth === null
            ? prev.dataHealth
            : v2Input.dataHealth;
        const nextSnapshotVersion = (prev.snapshotVersion ?? 0) + 1;

        if (
          sameSessionsShape(prev.sessions, sessions) &&
          sameActivityShape(prev.activity, activity) &&
          sameHandoffShape(prev.handoffs, handoffs) &&
          sameDecisionShape(prev.decisions, decisions) &&
          sameSliceRunsShape(prev.sliceRuns, sliceRuns) &&
          sameOutboxShape(prev.outbox, outbox) &&
          sameChatSnapshotShape(prev.chat, chat) &&
          sameRuntimeInstancesShape(prev.runtimeInstances, runtimeInstances) &&
          sameWorkSliceProjectionShape(prev.workSliceProjections ?? [], workSliceProjections) &&
          sameTimelineNarrativeShape(prev.timelineNarrative ?? [], timelineNarrative) &&
          sameNextUpByInitiativeShape(prev.nextUpByInitiative ?? [], nextUpByInitiative) &&
          (prev.runningWorkSlices ?? 0) === runningWorkSlices &&
          (prev.needsInputTotal ?? 0) === needsInputTotal &&
          (prev.failedActionableTotal ?? 0) === failedActionableTotal &&
          (prev.completedTodayTotal ?? 0) === completedTodayTotal &&
          sameStringArrayShape(prev.consistencyFlags ?? [], consistencyFlags) &&
          sameDataHealthShape(prev.dataHealth, dataHealth) &&
          prev.lastSnapshotAt === generatedAtInput &&
          prev.connection === 'connected'
        ) {
          return prev;
        }

        return buildLiveData(
          sessions,
          activity,
          handoffs,
          decisions,
          sliceRuns,
          outbox,
          generatedAtInput,
          nextSnapshotVersion,
          runtimeInstances,
          chat,
          {
            workSliceProjections,
            timelineNarrative,
            nextUpByInitiative,
            runningWorkSlices,
            needsInputTotal,
            failedActionableTotal,
            completedTodayTotal,
            consistencyFlags,
            dataHealth,
          }
        );
      });

      setIsLoading(false);
    },
    [maxActivityItems, maxDecisions, maxHandoffs, maxSessions]
  );

  const fetchSnapshot = useCallback(async () => {
    if (!enabled) {
      setData((prev) =>
        prev.connection === 'disconnected' ? prev : { ...prev, connection: 'disconnected' }
      );
      setIsLoading(false);
      setError(null);
      return;
    }

    const requestScopeKey = `${normalizedInitiativeId ?? '__all__'}::${normalizedProjectId ?? '__all__'}`;
    if (
      inFlightSnapshotRef.current &&
      inFlightScopeKeyRef.current === requestScopeKey
    ) {
      return inFlightSnapshotRef.current;
    }

    if (useMock) {
      setData(createMockData());
      setIsLoading(false);
      return;
    }

    const request = (async () => {
      try {
        const query = new URLSearchParams({
          sessionsLimit: String(maxSessions),
          activityLimit: String(maxActivityItems),
          decisionsLimit: String(maxDecisions),
          include_idle: 'true',
        });
        if (normalizedProjectId) {
          appendWorkspaceScopeParams(query, normalizedProjectId);
        }
        if (normalizedInitiativeId) {
          query.set('initiative', normalizedInitiativeId);
        }
        const endpoints = [
          { label: 'live/snapshot-v2', url: `/orgx/api/live/snapshot-v2?${query.toString()}` },
          { label: 'dashboard-bundle', url: `/orgx/api/dashboard-bundle?${query.toString()}` },
          { label: 'live/snapshot', url: `/orgx/api/live/snapshot?${query.toString()}` },
        ];
        const errors: string[] = [];
        let snapshot: LiveSnapshotResponse | null = null;
        let sawAuthFailure = false;
        for (let index = 0; index < endpoints.length; index += 1) {
          const endpoint = endpoints[index];
          if (index > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, SNAPSHOT_FALLBACK_STAGGER_MS);
            });
          }
          const snapshotRes = await fetchJson<LiveSnapshotResponse>(endpoint.url, {
            headers: buildOrgxHeaders({ workspaceId: normalizedProjectId }),
          }, { timeoutMs: SNAPSHOT_ENDPOINT_TIMEOUT_MS });
          if (snapshotRes.ok && snapshotRes.data) {
            snapshot = snapshotRes.data;
            break;
          }
          if (snapshotRes.status === 401 || snapshotRes.status === 403) {
            sawAuthFailure = true;
          }
          errors.push(`${endpoint.label}: ${snapshotRes.error ?? 'unavailable'}`);
        }

        if (!snapshot) {
          if (sawAuthFailure) {
            const authErr = new Error(
              'Unauthorized. Update your OrgX API key in Settings (use a user-scoped oxk_... key; userId should be blank).'
            );
            (authErr as Error & { code?: string }).code = 'ORGX_AUTH';
            throw authErr;
          }
          throw new Error(summarizeSnapshotFailureMessages(errors));
        }
        if (scopeKeyRef.current !== requestScopeKey) {
          return;
        }
        const degradedRaw = Array.isArray(snapshot.degraded)
          ? snapshot.degraded.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const degradedLower = degradedRaw.map((entry) => entry.toLowerCase());
        const hasDegradedReason = (...terms: string[]) =>
          degradedLower.some((entry) => terms.some((term) => entry.includes(term)));

        const rawActivity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
        const rawHandoffs = Array.isArray(snapshot.handoffs) ? snapshot.handoffs : [];
        const rawDecisions = Array.isArray(snapshot.decisions) ? snapshot.decisions : [];

        const shouldPreserveActivity =
          rawActivity.length === 0 &&
          hasDegradedReason('activity unavailable', 'activity local fallback failed');
        const shouldPreserveSessions = hasDegradedReason(
          'sessions unavailable',
          'sessions local fallback failed'
        );
        const shouldPreserveHandoffs =
          rawHandoffs.length === 0 && hasDegradedReason('handoffs unavailable');
        const shouldPreserveDecisions =
          rawDecisions.length === 0 &&
          hasDegradedReason('decisions unavailable');

        const workSliceProjectionsRaw = normalizeWorkSliceProjections(
          Array.isArray(snapshot.projections) ? snapshot.projections : []
        );
        const chat = normalizeChatSnapshot(snapshot.chat ?? null);
        const timelineNarrative = normalizeTimelineNarrative(
          Array.isArray(snapshot.timelineNarrative) ? snapshot.timelineNarrative : []
        );
        const nextUpByInitiativeRaw = normalizeNextUpByInitiative(
          Array.isArray(snapshot.nextUpByInitiative) ? snapshot.nextUpByInitiative : []
        );
        const sliceRunsRaw =
          workSliceProjectionsRaw.length > 0
            ? sliceRunsFromWorkSliceProjections(workSliceProjectionsRaw)
            : normalizeSliceRuns(Array.isArray(snapshot.sliceRuns) ? snapshot.sliceRuns : []);
        const sessionsRaw =
          snapshot.sessions &&
          Array.isArray(snapshot.sessions.nodes) &&
          Array.isArray(snapshot.sessions.edges) &&
          Array.isArray(snapshot.sessions.groups)
            ? snapshot.sessions
            : deriveSessionsFromFallbacks(rawActivity, snapshot.agents, maxSessions);
        const shouldPreserveSliceRuns =
          sliceRunsRaw.length === 0 &&
          workSliceProjectionsRaw.length === 0 &&
          hasDegradedReason(
            'activity unavailable',
            'sessions unavailable',
            'decisions unavailable',
            'next-up unavailable',
            'next-up queue'
          );
        const shouldPreserveNextUp =
          nextUpByInitiativeRaw.length === 0 &&
          hasDegradedReason('next-up unavailable', 'next-up queue');

        const activity = shouldPreserveActivity ? null : rawActivity;
        const handoffs = shouldPreserveHandoffs ? null : rawHandoffs;
        const decisions = shouldPreserveDecisions ? null : rawDecisions;
        const sessions =
          shouldPreserveSessions && sessionsRaw.nodes.length === 0 ? null : sessionsRaw;
        const workSliceProjections = shouldPreserveSliceRuns ? null : workSliceProjectionsRaw;
        const timelineNarrativeInput = shouldPreserveSliceRuns ? null : timelineNarrative;
        const sliceRuns = shouldPreserveSliceRuns ? null : sliceRunsRaw;
        const nextUpByInitiative = shouldPreserveNextUp ? null : nextUpByInitiativeRaw;

        applySnapshot(
          sessions,
          activity,
          handoffs,
          decisions,
          sliceRuns,
          snapshot.outbox ?? null,
          snapshot.generatedAt ?? null,
          snapshot.runtimeInstances ?? null,
          chat,
          {
            workSliceProjections,
            timelineNarrative: timelineNarrativeInput,
            nextUpByInitiative,
            runningWorkSlices: shouldPreserveSliceRuns ? null : snapshot.runningWorkSlices ?? null,
            needsInputTotal: shouldPreserveSliceRuns ? null : snapshot.needsInput ?? null,
            failedActionableTotal: shouldPreserveSliceRuns ? null : snapshot.failedActionable ?? null,
            completedTodayTotal: shouldPreserveSliceRuns ? null : snapshot.completedToday ?? null,
            consistencyFlags: Array.isArray(snapshot.consistencyFlags)
              ? snapshot.consistencyFlags
              : null,
            dataHealth: snapshot.dataHealth ?? null,
          }
        );

        const degradedReasons = degradedRaw.length > 0
          ? summarizeDegradedReasons(degradedRaw)
          : [];

        if (degradedReasons.length > 0) {
          setError(`Partial live data: ${degradedReasons.join('; ')}`);
          // "degraded" means partial data, not necessarily a broken connection.
          // Treat successful snapshot fetches as "connected" to avoid a UI that
          // appears stuck in "Reconnecting" during transient subsystem failures
          // (e.g., decisions endpoint down).
          setData((prev) =>
            prev.connection === 'connected'
              ? prev
              : { ...prev, connection: 'connected' }
          );
          // Keep SSE as the primary transport; don't force polling just because
          // some optional sub-queries degraded.
          setPollingEnabled(false);
        } else {
          setError(null);
          setData((prev) =>
            prev.connection === 'connected'
              ? prev
              : { ...prev, connection: 'connected' }
          );
        }
      } catch (err) {
        if (scopeKeyRef.current !== requestScopeKey) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isAuthBlocked = (() => {
          if (err == null || typeof err !== 'object' || !('code' in err)) return false;
          return (err as { code?: unknown }).code === 'ORGX_AUTH';
        })();

        if (isAuthBlocked) {
          authBlockedRef.current = true;
        }

        const shouldDisconnect =
          lastSuccessAtRef.current > 0 &&
          Date.now() - lastSuccessAtRef.current > DISCONNECT_AFTER_MS;

        setError(message);
        setData((prev) => {
          const nextConnection: LiveData['connection'] = isAuthBlocked || shouldDisconnect
            ? 'disconnected'
            : 'reconnecting';
          return prev.connection === nextConnection ? prev : { ...prev, connection: nextConnection };
        });
        if (!isAuthBlocked) {
          setPollingEnabled(true);
        } else {
          setPollingEnabled(false);
        }
        setIsLoading(false);
      } finally {
        if (inFlightScopeKeyRef.current === requestScopeKey) {
          inFlightSnapshotRef.current = null;
          inFlightScopeKeyRef.current = null;
        }
      }
    })();

    inFlightSnapshotRef.current = request;
    inFlightScopeKeyRef.current = requestScopeKey;
    return request;
  }, [
    applySnapshot,
    enabled,
    enableDecisions,
    maxActivityItems,
    maxDecisions,
    maxHandoffs,
    maxSessions,
    normalizedProjectId,
    normalizedInitiativeId,
    useMock,
  ]);

  const applyDecisionMutation = useCallback(
    async (
      decisionIds: string[],
      action: 'approve' | 'reject',
      input?: DecisionMutationInput
    ): Promise<DecisionActionSummary> => {
      if (!enableDecisions) {
        throw new Error('OrgX decisions are unavailable while disconnected.');
      }

      const ids = Array.from(new Set(decisionIds.filter(Boolean)));
      if (ids.length === 0) {
        return { updated: 0, failed: 0 };
      }
      const note = input?.note?.trim() || undefined;
      const optionId = input?.optionId?.trim() || undefined;

      if (useMock) {
        const resolvedIds = new Set(ids);
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
            requesterAgentId: null,
            requesterAgentName: decision.agentName ?? null,
            executorAgentId: null,
            executorAgentName: decision.agentName ?? null,
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
          return {
            ...prev,
            decisions: prev.decisions.filter((decision) => !resolvedIds.has(decision.id)),
            activity: mergedActivity,
            lastActivity: formatRelativeTime(now),
          };
        });
        return { updated: resolvedIds.size, failed: 0, firstError: undefined };
      }

      const startedAt = new Date().toISOString();
      const response = await fetch('/orgx/api/live/decisions/approve', {
        method: 'POST',
        headers: buildOrgxHeaders({
          contentTypeJson: true,
          workspaceId: normalizedProjectId,
        }),
        body: JSON.stringify({
          ids,
          action,
          ...(note ? { note } : {}),
          ...(optionId ? { option_id: optionId } : {}),
        }),
      });

      try {
        const payload = (await response.json().catch(() => null)) as DecisionMutationResponse | null;
        const results = Array.isArray(payload?.results) ? payload.results : [];
        const resolvedIds = new Set(
          results.filter((result) => result.ok).map((result) => result.id)
        );
        const failedResults = results.filter((result) => !result.ok);
        const firstError =
          failedResults.find((result) => typeof result.error === 'string' && result.error.trim().length > 0)
            ?.error ??
          (typeof payload?.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : undefined);

        if (!response.ok && response.status !== 207) {
          const serverMessage = firstError ?? `Decision action failed (${response.status})`;
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
              requesterAgentId: null,
              requesterAgentName: decision.agentName ?? null,
              executorAgentId: null,
              executorAgentName: decision.agentName ?? null,
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
        } else if (response.ok && ids.length > 0) {
          setData((prev) => ({
            ...prev,
            decisions: prev.decisions.filter((d) => !ids.includes(d.id)),
          }));
        }

        // Force a refetch to reconcile server state after mutation
        void fetchSnapshot();

        const updated = payload?.updated ?? resolvedIds.size;
        const failed = payload?.failed ?? Math.max(0, ids.length - resolvedIds.size);
        publishDecisionMutation(
          {
            phase: failed > 0 ? 'error' : 'success',
            action,
            targetCount: ids.length,
            message:
              failed > 0
                ? `${action === 'approve' ? 'Approve' : 'Reject'} completed with ${failed} failure${failed === 1 ? '' : 's'}.`
                : action === 'approve'
                  ? `Approved ${updated} decision${updated === 1 ? '' : 's'}.`
                  : `Rejected ${updated} decision${updated === 1 ? '' : 's'}.`,
            startedAt,
            completedAt: new Date().toISOString(),
          },
          { autoResetMs: failed > 0 ? 8_000 : 4_000 }
        );
        return { updated, failed, firstError };
      } catch (err) {
        publishDecisionMutation({
          phase: 'error',
          action,
          targetCount: ids.length,
          message: err instanceof Error ? err.message : 'Decision update failed.',
          startedAt,
          completedAt: new Date().toISOString(),
        });
        throw err;
      }
    },
    [
      enableDecisions,
      fetchSnapshot,
      maxActivityItems,
      normalizedProjectId,
      publishDecisionMutation,
      useMock,
    ]
  );

  const approveDecision = useCallback(
    async (decisionId: string, input?: DecisionMutationInput) => {
      return applyDecisionMutation([decisionId], 'approve', input);
    },
    [applyDecisionMutation]
  );

  const rejectDecision = useCallback(
    async (decisionId: string, input?: DecisionMutationInput) => {
      return applyDecisionMutation([decisionId], 'reject', input);
    },
    [applyDecisionMutation]
  );

  const approveAllDecisions = useCallback(async () => {
    // Read decisions from latest state to avoid stale-closure issues
    let allDecisionIds: string[] = [];
    setData((prev) => {
      allDecisionIds = prev.decisions.map((decision) => decision.id);
      return prev;
    });
    if (allDecisionIds.length === 0) {
      return { updated: 0, failed: 0 };
    }
    return applyDecisionMutation(allDecisionIds, 'approve');
  }, [applyDecisionMutation]);

  const bulkDecisionAction = useCallback(
    async (decisionIds: string[], action: 'approve' | 'reject', note?: string) =>
      applyDecisionMutation(decisionIds, action, note ? { note } : undefined),
    [applyDecisionMutation]
  );

  useEffect(() => {
    if (enableDecisions) return;
    publishDecisionMutation(EMPTY_DECISION_MUTATION);
  }, [enableDecisions, publishDecisionMutation]);

  useEffect(() => {
    if (!enabled) {
      setPollingEnabled(false);
      setIsLoading(false);
      setError(null);
      return undefined;
    }

    if (useMock) {
      fetchSnapshot();
      return undefined;
    }

    fetchSnapshot();

    // Workspace-scoped dashboards prioritize strict scope correctness over upstream SSE speed.
    // Upstream live stream payloads are not guaranteed to be workspace-filtered, so we force
    // snapshot polling for scoped views to prevent cross-workspace leakage.
    if (normalizedProjectId) {
      setPollingEnabled(true);
      return undefined;
    }

    const streamQuery = new URLSearchParams();
    if (normalizedProjectId) {
      appendWorkspaceScopeParams(streamQuery, normalizedProjectId);
    }
    if (normalizedInitiativeId) {
      streamQuery.set('initiative', normalizedInitiativeId);
    }
    const streamUrl = streamQuery.toString()
      ? `/orgx/api/live/stream?${streamQuery.toString()}`
      : '/orgx/api/live/stream';
    const eventSource = new EventSource(streamUrl);

    // Local runtime telemetry (Codex/Claude/OpenClaw hooks) streams independently from cloud SSE.
    const runtimeEventSource = new EventSource('/orgx/api/hooks/runtime/stream');

    let pendingSnapshot:
      | {
          sessions: SessionTreeResponse;
          activity: LiveActivityItem[];
          handoffs: HandoffSummary[];
          decisions: LiveDecision[] | null;
          sliceRuns: SliceRunProjection[] | null;
          outbox: OutboxStatus | null;
          generatedAt: string;
          runtimeInstances: RuntimeInstance[] | null;
          chat: LiveChatSnapshot | null;
          v2: {
            workSliceProjections?: WorkSliceProjectionV2[] | null;
            timelineNarrative?: SliceTimelineNarrativeProjectionV2[] | null;
            nextUpByInitiative?: NextUpInitiativeProjection[] | null;
            runningWorkSlices?: number | null;
            needsInputTotal?: number | null;
            failedActionableTotal?: number | null;
            completedTodayTotal?: number | null;
            consistencyFlags?: string[] | null;
            dataHealth?: SliceDataHealthSummary | null;
          } | null;
        }
      | null = null;
    let pendingRuntimeInstances: RuntimeInstance[] | null = null;
    let pendingSessions: SessionTreeResponse | null = null;
    let pendingHandoffs: HandoffSummary[] | null = null;
    let pendingActivity: LiveActivityItem[] = [];
    let pendingDecisions: LiveDecision[] | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flushPending = () => {
      flushTimer = undefined;

      if (pendingSnapshot) {
        lastSuccessAtRef.current = Date.now();
        authBlockedRef.current = false;
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        pendingSessions = null;
        pendingHandoffs = null;
        pendingActivity = [];
        pendingDecisions = null;
        pendingRuntimeInstances = null;
        applySnapshot(
          snapshot.sessions,
          snapshot.activity,
          snapshot.handoffs,
          snapshot.decisions,
          snapshot.sliceRuns,
          snapshot.outbox,
          snapshot.generatedAt,
          snapshot.runtimeInstances,
          snapshot.chat,
          snapshot.v2
        );
        return;
      }

      if (
        !pendingSessions &&
        !pendingHandoffs &&
        !pendingDecisions &&
        !pendingRuntimeInstances &&
        pendingActivity.length === 0
      ) {
        return;
      }

      lastSuccessAtRef.current = Date.now();
      authBlockedRef.current = false;

      setData((prev) => {
        let next = prev;

        if (pendingSessions) {
          const trimmedSessions = trimSessions(pendingSessions, maxSessions);
          const mergedSessions = trimSessions(
            mergeSessionSnapshots(next.sessions, trimmedSessions),
            maxSessions
          );
          pendingSessions = null;

          if (!sameSessionsShape(next.sessions, mergedSessions)) {
            next = { ...next, sessions: mergedSessions };
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

        if (pendingRuntimeInstances) {
          const normalizedRuntime = normalizeRuntimeInstances(pendingRuntimeInstances);
          pendingRuntimeInstances = null;
          if (!sameRuntimeInstancesShape(next.runtimeInstances, normalizedRuntime)) {
            next = { ...next, runtimeInstances: normalizedRuntime };
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
      lastSuccessAtRef.current = Date.now();
      authBlockedRef.current = false;
      setPollingEnabled(false);
      setData((prev) =>
        prev.connection === 'connected'
          ? prev
          : { ...prev, connection: 'connected' }
      );
      setError(null);
    };

    eventSource.onerror = () => {
      if (authBlockedRef.current) {
        setData((prev) =>
          prev.connection === 'disconnected' ? prev : { ...prev, connection: 'disconnected' }
        );
        setPollingEnabled(false);
        return;
      }
      const shouldDisconnect =
        lastSuccessAtRef.current > 0 &&
        Date.now() - lastSuccessAtRef.current > DISCONNECT_AFTER_MS;
      setData((prev) =>
        prev.connection === (shouldDisconnect ? 'disconnected' : 'reconnecting')
          ? prev
          : { ...prev, connection: shouldDisconnect ? 'disconnected' : 'reconnecting' }
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
          sliceRuns?: SliceRunProjection[];
          projections?: WorkSliceProjectionV2[];
          timelineNarrative?: SliceTimelineNarrativeProjectionV2[];
          nextUpByInitiative?: NextUpInitiativeProjection[];
          runningWorkSlices?: number;
          needsInput?: number;
          failedActionable?: number;
          completedToday?: number;
          consistencyFlags?: string[];
          dataHealth?: SliceDataHealthSummary;
          outbox?: OutboxStatus;
          generatedAt?: string;
          runtimeInstances?: RuntimeInstance[];
          chat?: LiveChatSnapshot;
        };

        const generatedAt =
          typeof payload.generatedAt === 'string' && payload.generatedAt.length > 0
            ? payload.generatedAt
            : new Date().toISOString();

        pendingSnapshot = {
          sessions: payload.sessions,
          activity: payload.activity ?? [],
          handoffs: payload.handoffs ?? [],
          decisions: payload.decisions ?? null,
          sliceRuns: Array.isArray(payload.sliceRuns)
            ? normalizeSliceRuns(payload.sliceRuns)
            : Array.isArray(payload.projections)
              ? sliceRunsFromWorkSliceProjections(normalizeWorkSliceProjections(payload.projections))
              : null,
          outbox: payload.outbox ?? null,
          generatedAt,
          runtimeInstances: Array.isArray(payload.runtimeInstances)
            ? payload.runtimeInstances
            : null,
          chat: normalizeChatSnapshot(payload.chat ?? null),
          v2: {
            workSliceProjections: Array.isArray(payload.projections)
              ? normalizeWorkSliceProjections(payload.projections)
              : null,
            timelineNarrative: Array.isArray(payload.timelineNarrative)
              ? normalizeTimelineNarrative(payload.timelineNarrative)
              : null,
            nextUpByInitiative: Array.isArray(payload.nextUpByInitiative)
              ? normalizeNextUpByInitiative(payload.nextUpByInitiative)
              : null,
            runningWorkSlices:
              typeof payload.runningWorkSlices === 'number' ? payload.runningWorkSlices : null,
            needsInputTotal: typeof payload.needsInput === 'number' ? payload.needsInput : null,
            failedActionableTotal:
              typeof payload.failedActionable === 'number' ? payload.failedActionable : null,
            completedTodayTotal:
              typeof payload.completedToday === 'number' ? payload.completedToday : null,
            consistencyFlags: Array.isArray(payload.consistencyFlags)
              ? payload.consistencyFlags
              : null,
            dataHealth: payload.dataHealth ?? null,
          },
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

    const handleRuntimeUpdated = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as
          | RuntimeInstance[]
          | RuntimeInstance;
        pendingRuntimeInstances = Array.isArray(payload) ? payload : [payload];
        scheduleFlush();
      } catch {
        // ignore malformed events
      }
    };

    eventSource.addEventListener('runtime.updated', handleRuntimeUpdated);
    runtimeEventSource.addEventListener('runtime.updated', handleRuntimeUpdated);

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
      runtimeEventSource.close();
    };
  }, [
    applySnapshot,
    batchWindowMs,
    enabled,
    enableDecisions,
    fetchSnapshot,
    maxActivityItems,
    maxDecisions,
    maxHandoffs,
    maxSessions,
    normalizedInitiativeId,
    normalizedProjectId,
    useMock,
  ]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (useMock) return undefined;
    if (intervalRef.current) clearInterval(intervalRef.current);
    const forcePollingForScopedWorkspace = Boolean(normalizedProjectId);
    if (!pollingEnabled && !forcePollingForScopedWorkspace) return undefined;

    intervalRef.current = setInterval(fetchSnapshot, pollInterval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, fetchSnapshot, normalizedProjectId, pollInterval, pollingEnabled, useMock]);

  return {
    data,
    isLoading,
    error,
    refetch: fetchSnapshot,
    approveDecision,
    rejectDecision,
    approveAllDecisions,
    bulkDecisionAction,
    decisionMutation,
  };
}
