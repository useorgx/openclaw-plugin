import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MissionControlSliceItem,
  MissionControlSlicesResponse,
  NextUpQueueItem,
  NextUpQueueResponse,
  NextUpQueueState,
  RunnerAgentRef,
} from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import {
  isDemoModeEnabled,
  isSyntheticInitiativeId,
  shouldIncludeSyntheticEntities,
} from '@/lib/initiativeIds';
import { parseUpgradeRequiredError } from '@/lib/upgradeGate';
import { appendWorkspaceScopeParams } from '@/lib/workspaceScope';
import { humanizeWarning } from '@/lib/humanize';

export type ZoomLevel = 'initiative' | 'workstream' | 'milestone';

export interface InitiativeGroupItem {
  initiativeId: string;
  initiativeTitle: string;
  initiativeStatus: string;
  initiativePriority: string | null;
  initiativePriorityNum: number | null;
  workstreamCount: number;
  workstreamIds: string[];
  runnerAgents: RunnerAgentRef[];
  queueState: NextUpQueueItem['queueState'];
  items: NextUpQueueItem[];
}

export interface MilestoneGroupItem {
  milestoneId: string | null;
  milestoneTitle: string;
  workstreamId: string;
  workstreamTitle: string;
  initiativeId: string;
  initiativeTitle: string;
  taskCount: number;
  queueState: NextUpQueueItem['queueState'];
  item: NextUpQueueItem;
}

interface UseNextUpQueueOptions {
  initiativeId?: string | null;
  projectId?: string | null;
  offset?: number;
  limit?: number;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
  snapshotVersion?: number | null;
  zoomLevel?: ZoomLevel;
}

interface NextUpActionInput {
  initiativeId: string;
  workstreamId: string;
  agentId?: string | null;
  scope?: 'task' | 'milestone' | 'workstream';
  maxParallelSlices?: number;
  parallelMode?: 'iwmt';
}

interface StartAutoContinueInput {
  initiativeId: string;
  workstreamId: string;
  agentId?: string | null;
  tokenBudgetTokens?: number;
  scope?: 'initiative' | 'workstream';
  maxParallelSlices?: number;
  parallelMode?: 'iwmt';
}

interface NextUpPlayResponse {
  ok: boolean;
  initiativeId?: string;
  workstreamId?: string;
  agentId?: string;
  dispatchMode?: 'slice' | 'fallback' | 'none' | 'pending' | string;
  sessionId?: string | null;
  slice?: {
    scope?: 'task' | 'milestone' | 'workstream';
    taskIds?: string[];
    taskCount?: number;
    primaryTaskId?: string | null;
  } | null;
  executionPolicy?: {
    domain?: string;
    requiredSkills?: string[];
    maxParallelAgents?: number | null;
    maxSliceTasks?: number | null;
  } | null;
  run?: unknown;
  error?: string;
  message?: string;
  code?: string;
}

const LIVE_DATA_INVALIDATE_DEBOUNCE_MS = 750;

async function readResponseJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function isUnknownApiEndpointError(response: Response, body: any | null): boolean {
  if (response.status !== 404) return false;
  const error = typeof body?.error === 'string' ? body.error : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  return /unknown api endpoint/i.test(`${error} ${message}`);
}

function normalizeErrorMessage(
  response: Response,
  body: any | null,
  fallback: string
): string {
  if (isUnknownApiEndpointError(response, body)) {
    return `${fallback}. This queue route is unavailable in the running plugin build.`;
  }
  if (response.status === 401 || response.status === 403) {
    return `${fallback}. Reconnect OrgX authentication in Settings.`;
  }
  if (response.status >= 500) {
    return `${fallback}. OrgX is temporarily unavailable.`;
  }
  const detail =
    (typeof body?.error === 'string' && body.error.trim()) ||
    (typeof body?.message === 'string' && body.message.trim()) ||
    fallback;
  return humanizeWarning(detail);
}

function normalizeTransportFailure(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  const normalized = message.trim().toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('signal is aborted')
  ) {
    return `${fallback}. Request timed out while waiting for queue data.`;
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network')) {
    return `${fallback}. Unable to reach the queue service right now.`;
  }
  return message ? humanizeWarning(message) : fallback;
}

function buildDemoQueueResponse(initiativeId: string | null): NextUpQueueResponse {
  const nowIso = new Date().toISOString();
  const items: NextUpQueueItem[] = [
    {
      initiativeId: 'init-1',
      initiativeTitle: 'Q4 Feature Ship',
      initiativeStatus: 'active',
      initiativePriority: 'high',
      initiativePriorityNum: 25,
      workstreamId: 'ws-4',
      workstreamTitle: 'Dashboard UI pass',
      workstreamStatus: 'active',
      nextTaskId: 'task-1',
      nextTaskTitle: 'Polish timeline controls',
      nextTaskPriority: 1,
      nextTaskDueAt: null,
      runnerAgentId: 'dana',
      runnerAgentName: 'Dana',
      runnerAgents: [{ id: 'dana', name: 'Dana' }],
      runnerSource: 'assigned',
      queueState: 'running',
      blockReason: null,
      queueOrigin: 'system',
      autoContinue: {
        status: 'running',
        activeTaskId: 'task-1',
        activeRunId: 'run-2',
        stopReason: null,
        updatedAt: nowIso,
      },
    },
    {
      initiativeId: 'init-2',
      initiativeTitle: 'Black Friday Email',
      initiativeStatus: 'active',
      initiativePriority: 'medium',
      initiativePriorityNum: 50,
      workstreamId: 'ws-9',
      workstreamTitle: 'Email campaign generation',
      workstreamStatus: 'queued',
      nextTaskId: 'task-2',
      nextTaskTitle: 'Draft launch variants',
      nextTaskPriority: 2,
      nextTaskDueAt: null,
      runnerAgentId: 'mark',
      runnerAgentName: 'Mark',
      runnerAgents: [{ id: 'mark', name: 'Mark' }],
      runnerSource: 'assigned',
      queueState: 'queued',
      blockReason: null,
      queueOrigin: 'system',
      autoContinue: {
        status: 'stopped',
        activeTaskId: null,
        activeRunId: null,
        stopReason: null,
        updatedAt: nowIso,
      },
    },
  ];

  const scopedItems =
    typeof initiativeId === 'string' && initiativeId.trim().length > 0
      ? items.filter((item) => item.initiativeId === initiativeId.trim())
      : items;

  return normalizeQueueResponse({
    ok: true,
    generatedAt: nowIso,
    total: scopedItems.length,
    items: scopedItems,
    pagination: {
      offset: 0,
      limit: scopedItems.length || 1,
      total: scopedItems.length,
      nextCursor: null,
      hasMore: false,
    },
    degraded: [],
  });
}

function resolveAutoRuntimeState(item: NextUpQueueItem): NextUpQueueItem['autoRuntimeState'] {
  const status = item.autoContinue?.status ?? 'stopped';
  if (status === 'running') return 'running';
  if (status === 'stopping') return 'stopping';
  if (item.autoContinue?.stopReason === 'error') return 'error';
  return 'idle';
}

function hasExplicitAutoIntent(item: NextUpQueueItem): boolean {
  if (!item.autoContinue) return false;
  const status = item.autoContinue.status;
  if (status !== 'running' && status !== 'stopping') return false;
  // Runtime status is the source of truth. Pointer fields can lag by one
  // polling cycle right after start/stop transitions.
  if (item.autoContinue.stopReason === 'error') return false;
  return true;
}

function normalizeRunnerId(value: string | null | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'unassigned';
  const lowered = raw.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null') return 'unassigned';
  if (lowered === 'main') return 'unassigned';
  return raw;
}

function normalizeRunnerName(
  value: string | null | undefined,
  runnerId: string
): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return runnerId === 'unassigned' ? 'Unassigned' : runnerId;
  const lowered = raw.toLowerCase();
  if (
    lowered === 'undefined' ||
    lowered === 'null' ||
    (lowered === 'main' && runnerId === 'unassigned')
  ) {
    return runnerId === 'unassigned' ? 'Unassigned' : runnerId;
  }
  return raw;
}

function normalizeRunnerAgents(
  value: unknown,
  fallbackId: string,
  fallbackName: string
): RunnerAgentRef[] {
  if (!Array.isArray(value)) {
    if (fallbackId === 'unassigned') return [];
    return [{ id: fallbackId, name: fallbackName }];
  }
  const output: RunnerAgentRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeRunnerId(typeof record.id === 'string' ? record.id : null);
    const name = normalizeRunnerName(
      typeof record.name === 'string' ? record.name : null,
      id
    );
    if (id === 'unassigned' && name === 'Unassigned') continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id, name });
  }
  if (output.length === 0 && fallbackId !== 'unassigned') {
    return [{ id: fallbackId, name: fallbackName }];
  }
  return output;
}

function normalizeRunnerSource(
  source: NextUpQueueItem['runnerSource'] | null | undefined,
  runnerId: string
): NextUpQueueItem['runnerSource'] {
  if (source === 'assigned' || source === 'inferred' || source === 'fallback') {
    return source;
  }
  if (runnerId === 'unassigned') return 'fallback';
  return 'inferred';
}

function decorateQueueItem(item: NextUpQueueItem): NextUpQueueItem {
  const fallbackRunnerAgentId = normalizeRunnerId(item.runnerAgentId);
  const fallbackRunnerAgentName = normalizeRunnerName(
    item.runnerAgentName,
    fallbackRunnerAgentId
  );
  const runnerAgents = normalizeRunnerAgents(
    (item as { runnerAgents?: unknown }).runnerAgents,
    fallbackRunnerAgentId,
    fallbackRunnerAgentName
  );
  const runnerPrimary = runnerAgents[0] ?? null;
  const runnerAgentId = runnerPrimary?.id ?? fallbackRunnerAgentId;
  const runnerAgentName = runnerPrimary?.name ?? fallbackRunnerAgentName;
  const runnerSource = normalizeRunnerSource(item.runnerSource, runnerAgentId);
  const normalizedSliceTaskIds =
    Array.isArray(item.sliceTaskIds) && item.sliceTaskIds.length > 0
      ? item.sliceTaskIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : item.nextTaskId
        ? [item.nextTaskId]
        : [];
  const normalizedScope =
    item.sliceScope === 'workstream' || item.sliceScope === 'milestone' || item.sliceScope === 'task'
      ? item.sliceScope
      : null;

  return {
    ...item,
    runnerAgentId,
    runnerAgentName,
    runnerAgents,
    runnerSource,
    playbackState: item.queueState,
    autoIntentEnabled: hasExplicitAutoIntent(item),
    autoRuntimeState: resolveAutoRuntimeState(item),
    queueOrigin: item.queueOrigin ?? 'system',
    sliceScope: normalizedScope,
    sliceTaskIds: normalizedSliceTaskIds,
    sliceTaskCount:
      typeof item.sliceTaskCount === 'number' && Number.isFinite(item.sliceTaskCount)
        ? Math.max(0, Math.floor(item.sliceTaskCount))
        : normalizedSliceTaskIds.length,
    executionPolicy: item.executionPolicy ?? null,
  };
}

function normalizeQueueResponse(response: NextUpQueueResponse): NextUpQueueResponse {
  const items = response.items.map((item) => decorateQueueItem(item));
  const total =
    typeof response.total === 'number' && Number.isFinite(response.total)
      ? Math.max(response.total, items.length)
      : items.length;
  const rawPagination =
    response.pagination && typeof response.pagination === 'object'
      ? response.pagination
      : null;
  const offset =
    rawPagination && Number.isFinite(rawPagination.offset)
      ? Math.max(0, Math.floor(rawPagination.offset))
      : 0;
  const limit =
    rawPagination && Number.isFinite(rawPagination.limit)
      ? Math.max(1, Math.floor(rawPagination.limit))
      : Math.max(1, items.length);
  const fallbackHasMore = offset + limit < total;
  const hasMore =
    rawPagination && typeof rawPagination.hasMore === 'boolean'
      ? rawPagination.hasMore
      : fallbackHasMore;
  const nextCursor =
    rawPagination && typeof rawPagination.nextCursor === 'string'
      ? rawPagination.nextCursor
      : hasMore
        ? String(offset + limit)
        : null;

  return {
    ...response,
    items,
    total,
    pagination: {
      offset,
      limit,
      total,
      nextCursor,
      hasMore,
    },
  };
}

function normalizeSliceQueueState(item: MissionControlSliceItem): NextUpQueueState {
  const explicit = (item.queueState ?? '').trim().toLowerCase();
  if (
    explicit === 'queued' ||
    explicit === 'running' ||
    explicit === 'blocked' ||
    explicit === 'idle' ||
    explicit === 'completed'
  ) {
    return explicit as NextUpQueueState;
  }

  const status = item.status.trim().toLowerCase();
  if (
    status === 'running' ||
    status === 'in_progress' ||
    status === 'dispatching'
  ) {
    return 'running';
  }
  // 'active' means the workstream is enabled/configured, not that a session
  // is currently executing. Treat it as queued so the card stays visible.
  if (status === 'active') {
    return 'queued';
  }
  if (
    item.runnable === false ||
    status === 'blocked' ||
    status === 'failed' ||
    status === 'error'
  ) {
    return 'blocked';
  }
  if (status === 'completed' || status === 'done' || status === 'resolved') {
    return 'completed';
  }
  return 'queued';
}

function toWorkstreamFallbackLabel(workstreamId: string | null): string {
  if (!workstreamId) return 'Workstream';
  const trimmed = workstreamId.trim();
  if (trimmed.length === 0) return 'Workstream';
  return /^[a-f0-9-]{16,}$/i.test(trimmed)
    ? `Workstream ${trimmed.slice(0, 8)}`
    : trimmed;
}

function mapSliceToQueueItem(item: MissionControlSliceItem): NextUpQueueItem | null {
  const lineageInitiativeIds =
    item.lineage?.initiativeIds?.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    ) ?? [];
  const lineageWorkstreamIds =
    item.lineage?.workstreamIds?.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    ) ?? [];

  const initiativeId = item.initiativeId?.trim() || lineageInitiativeIds[0] || null;
  const workstreamId =
    item.workstreamId?.trim() ||
    item.sourceWorkstreamIds?.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ||
    lineageWorkstreamIds[0] ||
    null;
  if (!initiativeId || !workstreamId) return null;

  const taskIds =
    item.lineage?.taskIds?.filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0) ??
    [];
  const scopeFromLevel =
    item.level === 'workstream' || item.level === 'milestone' || item.level === 'task'
      ? item.level
      : null;
  const fallbackRunnerId = normalizeRunnerId(item.runnerAgentId ?? null);
  const fallbackRunnerName = normalizeRunnerName(item.runnerAgentName ?? null, fallbackRunnerId);
  const runnerAgents = normalizeRunnerAgents(
    item.runnerAgents ?? null,
    fallbackRunnerId,
    fallbackRunnerName
  );
  const runnerPrimary = runnerAgents[0] ?? null;

  return {
    initiativeId,
    initiativeTitle: item.initiativeTitle?.trim() || lineageInitiativeIds[0] || initiativeId,
    initiativeStatus: 'active',
    initiativePriority: null,
    initiativePriorityNum: null,
    workstreamId,
    workstreamTitle:
      item.workstreamTitle?.trim() ||
      item.title?.trim() ||
      item.milestoneTitle?.trim() ||
      item.taskTitle?.trim() ||
      toWorkstreamFallbackLabel(workstreamId),
    workstreamStatus: item.status,
    nextTaskId: item.taskId,
    nextTaskTitle: item.taskTitle?.trim() || null,
    nextTaskPriority: typeof item.priorityNum === 'number' ? item.priorityNum : null,
    nextTaskDueAt: item.dueAt,
    runnerAgentId: runnerPrimary?.id ?? fallbackRunnerId,
    runnerAgentName: runnerPrimary?.name ?? fallbackRunnerName,
    runnerAgents,
    runnerSource: item.runnerSource ?? (runnerPrimary ? 'inferred' : 'fallback'),
    queueState: normalizeSliceQueueState(item),
    blockReason: item.blockReason ?? null,
    queueOrigin: 'system',
    sliceScope: scopeFromLevel,
    sliceTaskIds: taskIds.length > 0 ? taskIds : item.taskId ? [item.taskId] : [],
    sliceTaskCount:
      taskIds.length > 0 ? taskIds.length : item.taskId ? 1 : 0,
    sliceMilestoneId: item.milestoneId,
    executionPolicy: null,
    autoContinue: null,
  };
}

function groupByInitiative(items: NextUpQueueItem[]): InitiativeGroupItem[] {
  const map = new Map<string, InitiativeGroupItem>();
  for (const item of items) {
    const existing = map.get(item.initiativeId);
    if (existing) {
      existing.workstreamCount += 1;
      existing.workstreamIds.push(item.workstreamId);
      existing.items.push(item);
      // Merge runner agents
      for (const agent of item.runnerAgents ?? []) {
        if (!existing.runnerAgents.some((a) => a.id === agent.id)) {
          existing.runnerAgents.push(agent);
        }
      }
      // Promote queueState: running > blocked > queued > idle
      const rank = (s: string) =>
        s === 'running' ? 3 : s === 'blocked' ? 2 : s === 'queued' ? 1 : 0;
      if (rank(item.queueState) > rank(existing.queueState)) {
        existing.queueState = item.queueState;
      }
    } else {
      map.set(item.initiativeId, {
        initiativeId: item.initiativeId,
        initiativeTitle: item.initiativeTitle ?? item.initiativeId,
        initiativeStatus: item.initiativeStatus ?? 'active',
        initiativePriority:
          typeof item.initiativePriority === 'string' ? item.initiativePriority : null,
        initiativePriorityNum:
          typeof item.initiativePriorityNum === 'number' ? item.initiativePriorityNum : null,
        workstreamCount: 1,
        workstreamIds: [item.workstreamId],
        runnerAgents: [...(item.runnerAgents ?? [])],
        queueState: item.queueState,
        items: [item],
      });
    }
  }
  return Array.from(map.values());
}

function groupByMilestone(items: NextUpQueueItem[]): MilestoneGroupItem[] {
  return items.map((item) => ({
    milestoneId: item.sliceMilestoneId ?? null,
    milestoneTitle: item.sliceMilestoneId
      ? `Milestone ${item.sliceMilestoneId.slice(0, 8)}`
      : item.workstreamTitle ?? 'Workstream',
    workstreamId: item.workstreamId,
    workstreamTitle: item.workstreamTitle ?? item.workstreamId,
    initiativeId: item.initiativeId,
    initiativeTitle: item.initiativeTitle ?? item.initiativeId,
    taskCount: item.sliceTaskCount ?? 0,
    queueState: item.queueState,
    item,
  }));
}

export function useNextUpQueue({
  initiativeId = null,
  projectId = null,
  offset = 0,
  limit = 20,
  authToken = null,
  embedMode = false,
  enabled = true,
  snapshotVersion = null,
  zoomLevel = 'workstream',
}: UseNextUpQueueOptions) {
  const queryClient = useQueryClient();
  const demoMode = isDemoModeEnabled();
  const normalizedOffset = Math.max(0, offset);
  const normalizedLimit = Math.max(1, Math.min(300, limit));
  const liveDataInvalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (liveDataInvalidateTimerRef.current) {
        clearTimeout(liveDataInvalidateTimerRef.current);
        liveDataInvalidateTimerRef.current = null;
      }
    };
  }, []);

  const queryKey = useMemo(
    () =>
      queryKeys.nextUpQueue({
        initiativeId,
        projectId,
        offset: normalizedOffset,
        limit: normalizedLimit,
        authToken,
        embedMode,
      }),
    [
      initiativeId,
      projectId,
      normalizedOffset,
      normalizedLimit,
      authToken,
      embedMode,
    ]
  );

  // When the SSE snapshot version bumps, invalidate the cache so the next
  // poll picks up fresh data — but keep the same query key to avoid orphaning
  // in-flight fetches (which caused the perpetual-loading bug).
  const prevSnapshotRef = useRef(snapshotVersion);
  useEffect(() => {
    if (
      snapshotVersion !== null &&
      prevSnapshotRef.current !== null &&
      snapshotVersion !== prevSnapshotRef.current
    ) {
      void queryClient.invalidateQueries({ queryKey });
    }
    prevSnapshotRef.current = snapshotVersion;
  }, [snapshotVersion, queryClient, queryKey]);

  const scheduleLiveDataInvalidate = () => {
    if (liveDataInvalidateTimerRef.current) {
      clearTimeout(liveDataInvalidateTimerRef.current);
      liveDataInvalidateTimerRef.current = null;
    }
    liveDataInvalidateTimerRef.current = setTimeout(() => {
      liveDataInvalidateTimerRef.current = null;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.liveData({ authToken, embedMode, projectId }),
      });
    }, LIVE_DATA_INVALIDATE_DEBOUNCE_MS);
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoContinueStatus({ initiativeId, authToken, embedMode }),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
      }),
    ]);
    scheduleLiveDataInvalidate();
  };

  const loadQueuePage = async (
    targetOffset: number,
    targetLimit: number
  ): Promise<NextUpQueueResponse> => {
      if (demoMode) {
        return buildDemoQueueResponse(initiativeId);
      }

      const params = new URLSearchParams();
      if (initiativeId) params.set('initiative_id', initiativeId);
      appendWorkspaceScopeParams(params, projectId, {
        allTokenWhenMissing: true,
      });
      params.set('offset', String(targetOffset));
      params.set('limit', String(targetLimit));
      let response: Response;
      try {
        response = await fetch(`/orgx/api/mission-control/next-up?${params.toString()}`, {
          headers: buildOrgxHeaders({ authToken, embedMode }),
        });
      } catch (err) {
        throw new Error(normalizeTransportFailure(err, 'Failed to load next up queue'));
      }
      const body = await readResponseJson<NextUpQueueResponse | { error?: string; message?: string }>(
        response
      );
      if (!response.ok) {
        const message = normalizeErrorMessage(
          response,
          body as { error?: string; message?: string } | null,
          'Failed to load next up queue'
        );
        throw new Error(message);
      }

      const normalized = (body ?? null) as NextUpQueueResponse | null;
      if (!normalized || normalized.ok !== true) {
        return {
          ok: true,
          generatedAt: new Date().toISOString(),
          total: 0,
          items: [],
          pagination: {
            offset: targetOffset,
            limit: targetLimit,
            total: 0,
            nextCursor: null,
            hasMore: false,
          },
          degraded: ['next-up queue response missing expected payload'],
        } satisfies NextUpQueueResponse;
      }
      if (shouldIncludeSyntheticEntities()) {
        return normalizeQueueResponse(normalized);
      }
      const visibleItems = normalized.items.filter(
        (item) => !isSyntheticInitiativeId(item.initiativeId)
      );
      let responsePayload = normalizeQueueResponse({
        ...normalized,
        items: visibleItems,
      });

      if (responsePayload.items.length > 0) {
        return responsePayload;
      }

      const sliceParams = new URLSearchParams();
      if (initiativeId) sliceParams.set('initiative_id', initiativeId);
      appendWorkspaceScopeParams(sliceParams, projectId, {
        allTokenWhenMissing: true,
      });
      sliceParams.set('level', 'workstream');
      sliceParams.set('include_completed', '0');
      sliceParams.set('offset', String(targetOffset));
      sliceParams.set('limit', String(Math.max(targetLimit, 24)));

      try {
        const slicesRes = await fetch(`/orgx/api/mission-control/slices?${sliceParams.toString()}`, {
          headers: buildOrgxHeaders({ authToken, embedMode }),
        });
        const slicesBody = await readResponseJson<MissionControlSlicesResponse>(slicesRes);
        if (slicesRes.ok && slicesBody?.ok && Array.isArray(slicesBody.items)) {
          const sliceItems = slicesBody.items
            .map((slice) => mapSliceToQueueItem(slice))
            .filter((item): item is NextUpQueueItem => Boolean(item))
            .filter((item) => !isSyntheticInitiativeId(item.initiativeId));
          if (sliceItems.length > 0) {
            responsePayload = normalizeQueueResponse({
              ok: true,
              generatedAt: new Date().toISOString(),
              total:
                typeof slicesBody.total === 'number' && Number.isFinite(slicesBody.total)
                  ? Math.max(slicesBody.total, sliceItems.length)
                  : sliceItems.length,
              items: sliceItems,
              pagination:
                slicesBody.pagination && typeof slicesBody.pagination === 'object'
                  ? {
                      offset:
                        typeof slicesBody.pagination.offset === 'number'
                          ? Math.max(0, Math.floor(slicesBody.pagination.offset))
                          : targetOffset,
                      limit:
                        typeof slicesBody.pagination.limit === 'number'
                          ? Math.max(1, Math.floor(slicesBody.pagination.limit))
                          : Math.max(targetLimit, 24),
                      total:
                        typeof slicesBody.pagination.total === 'number'
                          ? Math.max(0, Math.floor(slicesBody.pagination.total))
                          : sliceItems.length,
                      nextCursor:
                        typeof slicesBody.pagination.nextCursor === 'string'
                          ? slicesBody.pagination.nextCursor
                          : null,
                      hasMore:
                        typeof slicesBody.pagination.hasMore === 'boolean'
                          ? slicesBody.pagination.hasMore
                          : false,
                    }
                  : undefined,
              degraded: Array.from(
                new Set([
                  ...(normalized.degraded ?? []),
                  'Queue derived from slices while live queue stabilizes.',
                ])
              ),
            });
          }
        }
      } catch {
        // best effort fallback only
      }

      return responsePayload;
  };

  const query = useQuery<NextUpQueueResponse, Error>({
    queryKey,
    enabled,
    queryFn: async () => loadQueuePage(normalizedOffset, normalizedLimit),
    refetchInterval: (state) => {
      const payload = state.state.data;
      if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return 10_000;
      const hasRunning = payload.items.some((item) => item.queueState === 'running');
      return hasRunning ? 2_500 : 8_000;
    },
  });

  const warmedNextCursorRef = useRef<string | null>(null);
  useEffect(() => {
    const pagination = query.data?.pagination;
    if (!enabled || !pagination?.hasMore || !pagination.nextCursor) return;
    if (warmedNextCursorRef.current === pagination.nextCursor) return;
    const nextOffset = Number.parseInt(pagination.nextCursor, 10);
    if (!Number.isFinite(nextOffset)) return;
    warmedNextCursorRef.current = pagination.nextCursor;
    void queryClient.prefetchQuery({
      queryKey: queryKeys.nextUpQueue({
        initiativeId,
        projectId,
        offset: nextOffset,
        limit: normalizedLimit,
        authToken,
        embedMode,
      }),
      queryFn: () => loadQueuePage(nextOffset, normalizedLimit),
      staleTime: 15_000,
    });
  }, [
    enabled,
    query.data?.pagination?.hasMore,
    query.data?.pagination?.nextCursor,
    initiativeId,
    projectId,
    normalizedLimit,
    authToken,
    embedMode,
    queryClient,
  ]);

  const playMutation = useMutation({
    mutationFn: async (input: NextUpActionInput) => {
      if (demoMode) {
        return {
          ok: true,
          initiativeId: input.initiativeId,
          workstreamId: input.workstreamId,
          dispatchMode: 'slice',
          sessionId: null,
        } satisfies NextUpPlayResponse;
      }
      const response = await fetch('/orgx/api/mission-control/next-up/play', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({
          initiativeId: input.initiativeId,
          workstreamId: input.workstreamId,
          agentId: input.agentId ?? undefined,
          scope: input.scope ?? undefined,
          maxParallelSlices:
            typeof input.maxParallelSlices === 'number' && Number.isFinite(input.maxParallelSlices)
              ? Math.max(1, Math.floor(input.maxParallelSlices))
              : undefined,
          parallelMode: input.parallelMode === 'iwmt' ? 'iwmt' : undefined,
          fastAck: true,
          // Explicit user play action should bypass soft spawn-guard rate limits.
          ignoreSpawnGuardRateLimit: true,
        }),
      });

      const body = await readResponseJson<NextUpPlayResponse>(response);
      if (!response.ok) {
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to dispatch queued workstream')
        );
      }
      return body;
    },
    onMutate: async (input: NextUpActionInput) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<NextUpQueueResponse>(queryKey);
      if (!previous) return { previous };

      queryClient.setQueryData<NextUpQueueResponse>(queryKey, {
        ...previous,
        items: previous.items.map((item) => {
          if (item.initiativeId === input.initiativeId && item.workstreamId === input.workstreamId) {
            return { ...item, queueState: 'running', playbackState: 'running' };
          }
          // Only one workstream can be "running" in the queue UI.
          if (item.queueState === 'running') return { ...item, queueState: 'idle', playbackState: 'idle' };
          return item;
        }),
      });

      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const startAutoContinueMutation = useMutation({
    mutationFn: async (input: StartAutoContinueInput) => {
      if (demoMode) return;
      const payload: Record<string, unknown> = {
        initiativeId: input.initiativeId,
        agentId: input.agentId ?? undefined,
        tokenBudgetTokens: input.tokenBudgetTokens,
        // Explicit user auto-enable should bypass soft spawn-guard rate limits.
        ignoreSpawnGuardRateLimit: true,
      };
      if (input.scope === 'workstream' && input.workstreamId) {
        payload.workstreamIds = [input.workstreamId];
      }
      if (typeof input.maxParallelSlices === 'number' && Number.isFinite(input.maxParallelSlices)) {
        payload.maxParallelSlices = input.maxParallelSlices;
      }
      if (input.parallelMode === 'iwmt') {
        payload.parallelMode = input.parallelMode;
      }

      const response = await fetch('/orgx/api/mission-control/auto-continue/start', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify(payload),
      });

      const body = await readResponseJson<unknown>(response);
      if (!response.ok) {
        const upgradeError = parseUpgradeRequiredError(body);
        if (upgradeError) throw upgradeError;
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to start auto-continue')
        );
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const stopAutoContinueMutation = useMutation({
    mutationFn: async (input: { initiativeId: string }) => {
      if (demoMode) return;
      const response = await fetch('/orgx/api/mission-control/auto-continue/stop', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({ initiativeId: input.initiativeId }),
      });
      const body = await readResponseJson<{ error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(
          normalizeErrorMessage(response, body, 'Failed to stop auto-continue')
        );
      }
    },
    onSuccess: () => {
      void invalidate();
    },
  });

  const allItems = query.data?.items ?? [];

  const initiativeGroups = useMemo(
    () => (zoomLevel === 'initiative' ? groupByInitiative(allItems) : []),
    [allItems, zoomLevel]
  );

  const milestoneGroups = useMemo(
    () => (zoomLevel === 'milestone' ? groupByMilestone(allItems) : []),
    [allItems, zoomLevel]
  );

  return {
    items: allItems,
    total: query.data?.total ?? 0,
    pagination: query.data?.pagination ?? null,
    generatedAt: query.data?.generatedAt ?? null,
    degraded: query.data?.degraded ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error?.message ?? null,
    refetch: query.refetch,
    playWorkstream: playMutation.mutateAsync,
    startWorkstreamAutoContinue: startAutoContinueMutation.mutateAsync,
    stopInitiativeAutoContinue: stopAutoContinueMutation.mutateAsync,
    isPlaying: playMutation.isPending,
    isStartingAutoContinue: startAutoContinueMutation.isPending,
    isStoppingAutoContinue: stopAutoContinueMutation.isPending,
    zoomLevel,
    initiativeGroups,
    milestoneGroups,
  };
}

export type { NextUpQueueItem };

export interface UseNextUpQueueResult {
  items: NextUpQueueItem[];
  total: number;
  pagination?: NextUpQueueResponse['pagination'] | null;
  generatedAt: string | null;
  degraded: string[];
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
  playWorkstream: (input: NextUpActionInput) => Promise<unknown>;
  startWorkstreamAutoContinue: (input: StartAutoContinueInput) => Promise<unknown>;
  stopInitiativeAutoContinue: (input: { initiativeId: string }) => Promise<unknown>;
  isPlaying: boolean;
  isStartingAutoContinue: boolean;
  isStoppingAutoContinue: boolean;
  zoomLevel: ZoomLevel;
  initiativeGroups: InitiativeGroupItem[];
  milestoneGroups: MilestoneGroupItem[];
}
