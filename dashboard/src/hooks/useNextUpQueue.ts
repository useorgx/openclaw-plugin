import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  AutoContinueRun,
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
import { parseMissionControlApiError } from '@/lib/missionControlApiError';
import {
  invalidateMissionControlQueries,
  LIVE_DATA_INVALIDATE_DEBOUNCE_MS,
} from '@/lib/missionControlInvalidation';

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

export interface NextUpPlayResponse {
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

export interface StartAutoContinueResponse {
  ok: boolean;
  initiativeId?: string;
  workstreamIds?: string[];
  run?: AutoContinueRun | null;
  error?: string;
  message?: string;
}

type QueueMutationContext = {
  previous: InfiniteData<NextUpQueueResponse> | undefined;
};

function patchInfiniteQueueData(
  previous: InfiniteData<NextUpQueueResponse> | undefined,
  updateItem: (item: NextUpQueueItem) => NextUpQueueItem
): InfiniteData<NextUpQueueResponse> | undefined {
  if (!previous) return previous;
  return {
    ...previous,
    pages: previous.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => updateItem(item)),
    })),
  };
}

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
  const minusMinutes = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  const autoState = (
    status: 'running' | 'stopping' | 'stopped',
    updatedAt: string,
    input?: {
      activeTaskId?: string | null;
      activeRunId?: string | null;
      stopReason?: 'budget_exhausted' | 'blocked' | 'completed' | 'stopped' | 'error' | null;
      maxParallelSlices?: number;
      parallelMode?: 'iwmt';
    }
  ): NonNullable<NextUpQueueItem['autoContinue']> => ({
    status,
    activeTaskId: input?.activeTaskId ?? null,
    activeRunId: input?.activeRunId ?? null,
    stopReason: input?.stopReason ?? null,
    maxParallelSlices: input?.maxParallelSlices ?? 3,
    parallelMode: input?.parallelMode ?? 'iwmt',
    updatedAt,
  });

  const items: NextUpQueueItem[] = [
    {
      initiativeId: 'init-1',
      initiativeTitle: 'Content Engine: Dogfood the Larry Playbook',
      initiativeStatus: 'active',
      initiativePriority: 'critical',
      initiativePriorityNum: 11,
      workstreamId: 'ws-content-1',
      workstreamTitle: 'Long-form article generation',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-content-13',
      nextTaskTitle: 'Apply editorial revisions for sections 3-4',
      nextTaskPriority: 1,
      nextTaskDueAt: minusMinutes(-35),
      runnerAgentId: 'kimi',
      runnerAgentName: 'Kimi',
      runnerAgents: [{ id: 'kimi', name: 'Kimi' }],
      runnerSource: 'assigned',
      queueState: 'running',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-content-12', 'task-content-13'],
      sliceTaskCount: 2,
      executionPolicy: {
        domain: 'content',
        requiredSkills: ['editorial-review', 'voice-consistency'],
        profile: 'quality-first',
        sliceScopePreference: 'task',
        maxSliceTasks: 2,
        maxParallelAgents: 2,
        dependencyMode: 'strict',
      },
      autoContinue: autoState('running', minusMinutes(4), {
        activeTaskId: 'task-content-13',
        activeRunId: 'run-101',
        maxParallelSlices: 2,
      }),
    },
    {
      initiativeId: 'init-1',
      initiativeTitle: 'Content Engine: Dogfood the Larry Playbook',
      initiativeStatus: 'active',
      initiativePriority: 'critical',
      initiativePriorityNum: 12,
      workstreamId: 'ws-content-legal',
      workstreamTitle: 'Persona QA and legal sweep',
      workstreamStatus: 'blocked',
      nextTaskId: 'task-legal-2',
      nextTaskTitle: 'Approve legal-safe copy variant',
      nextTaskPriority: 1,
      nextTaskDueAt: minusMinutes(-20),
      runnerAgentId: 'holt',
      runnerAgentName: 'Holt',
      runnerAgents: [{ id: 'holt', name: 'Holt' }],
      runnerSource: 'assigned',
      queueState: 'blocked',
      blockReason: 'Waiting on legal-safe variant decision from you',
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-legal-2'],
      sliceTaskCount: 1,
      autoContinue: autoState('stopped', minusMinutes(7), {
        stopReason: 'blocked',
        maxParallelSlices: 2,
      }),
    },
    {
      initiativeId: 'init-2',
      initiativeTitle: "Live View UX Redesign — The Conductor's Display",
      initiativeStatus: 'active',
      initiativePriority: 'high',
      initiativePriorityNum: 24,
      workstreamId: 'ws-ux-devmode',
      workstreamTitle: 'Developer-mode feature gating',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-ux-33',
      nextTaskTitle: 'Capture final mobile + desktop verification',
      nextTaskPriority: 1,
      nextTaskDueAt: minusMinutes(-15),
      runnerAgentId: 'holt',
      runnerAgentName: 'Holt',
      runnerAgents: [{ id: 'holt', name: 'Holt' }],
      runnerSource: 'assigned',
      queueState: 'running',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'workstream',
      sliceTaskIds: ['task-ux-31', 'task-ux-32', 'task-ux-33'],
      sliceTaskCount: 3,
      autoContinue: autoState('running', minusMinutes(2), {
        activeTaskId: 'task-ux-33',
        activeRunId: 'run-202',
      }),
    },
    {
      initiativeId: 'init-2',
      initiativeTitle: "Live View UX Redesign — The Conductor's Display",
      initiativeStatus: 'active',
      initiativePriority: 'high',
      initiativePriorityNum: 26,
      workstreamId: 'ws-ux-activity',
      workstreamTitle: 'Activity feed readability pass',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-ux-19',
      nextTaskTitle: 'Finalize hierarchy labels and evidence chips',
      nextTaskPriority: 2,
      nextTaskDueAt: minusMinutes(-28),
      runnerAgentId: 'dana',
      runnerAgentName: 'Dana',
      runnerAgents: [{ id: 'dana', name: 'Dana' }],
      runnerSource: 'assigned',
      queueState: 'queued',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-ux-18', 'task-ux-19'],
      sliceTaskCount: 2,
      autoContinue: autoState('running', minusMinutes(6), {
        activeTaskId: 'task-ux-19',
        activeRunId: 'run-201',
      }),
    },
    {
      initiativeId: 'init-2',
      initiativeTitle: "Live View UX Redesign — The Conductor's Display",
      initiativeStatus: 'active',
      initiativePriority: 'high',
      initiativePriorityNum: 27,
      workstreamId: 'ws-ux-collapse',
      workstreamTitle: 'Grouped section collapse spacing regression',
      workstreamStatus: 'blocked',
      nextTaskId: 'task-ux-41',
      nextTaskTitle: 'Apply approved collapsed spacing token',
      nextTaskPriority: 1,
      nextTaskDueAt: minusMinutes(-12),
      runnerAgentId: 'kimi',
      runnerAgentName: 'Kimi',
      runnerAgents: [{ id: 'kimi', name: 'Kimi' }],
      runnerSource: 'assigned',
      queueState: 'blocked',
      blockReason: 'Decision required: choose 8px or 0px collapsed spacing',
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-ux-41'],
      sliceTaskCount: 1,
      autoContinue: autoState('stopped', minusMinutes(2), {
        stopReason: 'blocked',
      }),
    },
    {
      initiativeId: 'init-3',
      initiativeTitle: 'Directory Submissions & External References',
      initiativeStatus: 'active',
      initiativePriority: 'medium',
      initiativePriorityNum: 41,
      workstreamId: 'ws-directory-import',
      workstreamTitle: 'Enrichment import pipeline',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-dir-12',
      nextTaskTitle: 'Finish vendor retry batch after cooldown',
      nextTaskPriority: 2,
      nextTaskDueAt: minusMinutes(-45),
      runnerAgentId: 'pace',
      runnerAgentName: 'Pace',
      runnerAgents: [{ id: 'pace', name: 'Pace' }],
      runnerSource: 'assigned',
      queueState: 'running',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-dir-11', 'task-dir-12'],
      sliceTaskCount: 2,
      autoContinue: autoState('running', minusMinutes(3), {
        activeTaskId: 'task-dir-12',
        activeRunId: 'run-301',
      }),
    },
    {
      initiativeId: 'init-3',
      initiativeTitle: 'Directory Submissions & External References',
      initiativeStatus: 'active',
      initiativePriority: 'medium',
      initiativePriorityNum: 43,
      workstreamId: 'ws-directory-qa',
      workstreamTitle: 'Reference verification QA lane',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-dir-qa-2',
      nextTaskTitle: 'Reconcile citation mismatches and publish QA memo',
      nextTaskPriority: 2,
      nextTaskDueAt: minusMinutes(-38),
      runnerAgentId: 'kimi',
      runnerAgentName: 'Kimi',
      runnerAgents: [{ id: 'kimi', name: 'Kimi' }],
      runnerSource: 'assigned',
      queueState: 'queued',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-dir-qa-1', 'task-dir-qa-2'],
      sliceTaskCount: 2,
      autoContinue: autoState('running', minusMinutes(5), {
        activeTaskId: 'task-dir-qa-2',
        activeRunId: 'run-302',
      }),
    },
    {
      initiativeId: 'init-3',
      initiativeTitle: 'Directory Submissions & External References',
      initiativeStatus: 'active',
      initiativePriority: 'medium',
      initiativePriorityNum: 45,
      workstreamId: 'ws-directory-outreach',
      workstreamTitle: 'External partner outreach copy',
      workstreamStatus: 'in_progress',
      nextTaskId: 'task-dir-outreach-2',
      nextTaskTitle: 'Finalize outreach sequence copy',
      nextTaskPriority: 3,
      nextTaskDueAt: minusMinutes(-52),
      runnerAgentId: 'mark',
      runnerAgentName: 'Mark',
      runnerAgents: [{ id: 'mark', name: 'Mark' }],
      runnerSource: 'assigned',
      queueState: 'queued',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'task',
      sliceTaskIds: ['task-dir-outreach-1', 'task-dir-outreach-2'],
      sliceTaskCount: 2,
      autoContinue: autoState('running', minusMinutes(8), {
        activeTaskId: 'task-dir-outreach-2',
        activeRunId: 'run-303',
      }),
    },
    {
      initiativeId: 'init-5',
      initiativeTitle: 'Incident Replay & Reliability',
      initiativeStatus: 'blocked',
      initiativePriority: 'critical',
      initiativePriorityNum: 8,
      workstreamId: 'ws-reliability-replay',
      workstreamTitle: 'Incident replay reconstruction',
      workstreamStatus: 'blocked',
      nextTaskId: 'task-rel-44',
      nextTaskTitle: 'Approve snapshot restore and rerun replay',
      nextTaskPriority: 1,
      nextTaskDueAt: minusMinutes(-10),
      runnerAgentId: 'ops',
      runnerAgentName: 'Ops',
      runnerAgents: [{ id: 'ops', name: 'Ops' }],
      runnerSource: 'assigned',
      queueState: 'blocked',
      blockReason: 'Archive restore approval needed to continue replay',
      queueOrigin: 'system',
      sliceScope: 'milestone',
      sliceTaskIds: ['task-rel-44'],
      sliceTaskCount: 1,
      sliceMilestoneId: 'mile-rel-9',
      autoContinue: autoState('stopped', minusMinutes(25), {
        stopReason: 'blocked',
        maxParallelSlices: 1,
      }),
    },
    {
      initiativeId: 'init-4',
      initiativeTitle: 'Revenue Expansion Q2',
      initiativeStatus: 'completed',
      initiativePriority: 'low',
      initiativePriorityNum: 74,
      workstreamId: 'ws-revenue-closeout',
      workstreamTitle: 'Revenue Expansion Q2 closeout',
      workstreamStatus: 'completed',
      nextTaskId: null,
      nextTaskTitle: 'Completed',
      nextTaskPriority: null,
      nextTaskDueAt: null,
      runnerAgentId: 'mark',
      runnerAgentName: 'Mark',
      runnerAgents: [{ id: 'mark', name: 'Mark' }],
      runnerSource: 'assigned',
      queueState: 'completed',
      blockReason: null,
      queueOrigin: 'system',
      sliceScope: 'milestone',
      sliceTaskIds: ['task-revenue-19'],
      sliceTaskCount: 1,
      sliceMilestoneId: 'mile-revenue-4',
      autoContinue: autoState('stopped', minusMinutes(40), {
        stopReason: 'completed',
        maxParallelSlices: 1,
      }),
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
    summary: response.summary
      ? {
          visibleTotal:
            typeof response.summary.visibleTotal === 'number' &&
            Number.isFinite(response.summary.visibleTotal)
              ? Math.max(0, Math.floor(response.summary.visibleTotal))
              : items.filter(
                  (item) => item.queueState !== 'running' && item.queueState !== 'completed'
                ).length,
          stateCounts: {
            queued: Math.max(0, Math.floor(response.summary.stateCounts?.queued ?? 0)),
            running: Math.max(0, Math.floor(response.summary.stateCounts?.running ?? 0)),
            blocked: Math.max(0, Math.floor(response.summary.stateCounts?.blocked ?? 0)),
            idle: Math.max(0, Math.floor(response.summary.stateCounts?.idle ?? 0)),
            completed: Math.max(0, Math.floor(response.summary.stateCounts?.completed ?? 0)),
          },
        }
      : undefined,
    pagination: {
      offset,
      limit,
      total,
      nextCursor,
      hasMore,
    },
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

  const setAutoContinueStatusCache = useCallback(
    (targetInitiativeId: string, run: AutoContinueRun | null) => {
      const targetKey = queryKeys.autoContinueStatus({
        initiativeId: targetInitiativeId,
        authToken,
        embedMode,
      });
      queryClient.setQueryData(targetKey, (current: unknown) => {
        const existing =
          current && typeof current === 'object'
            ? (current as { defaults?: { tokenBudget?: number | null; maxParallelSlices?: number; tickMs?: number } })
            : null;
        return {
          ok: true,
          initiativeId: targetInitiativeId,
          run,
          defaults: existing?.defaults ?? { tokenBudget: null, tickMs: 0 },
        };
      });
    },
    [authToken, embedMode, queryClient]
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

  const invalidate = async ({
    includeGraph = true,
    includeLiveData = true,
  }: {
    includeGraph?: boolean;
    includeLiveData?: boolean;
  } = {}) => {
    await invalidateMissionControlQueries(queryClient, {
      initiativeId,
      projectId,
      authToken,
      embedMode,
      queueQueryKey: queryKey,
      includeGraph,
      includeSlices: false,
      includeLiveData: false,
    });
    if (includeLiveData) {
      scheduleLiveDataInvalidate();
    }
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
      const responsePayload = normalizeQueueResponse({
        ...normalized,
        items: visibleItems,
      });
      return responsePayload;
  };

  const query = useInfiniteQuery<NextUpQueueResponse, Error>({
    queryKey,
    enabled,
    initialPageParam: normalizedOffset,
    queryFn: async ({ pageParam }) => {
      const targetOffset =
        typeof pageParam === 'number' && Number.isFinite(pageParam)
          ? Math.max(0, Math.floor(pageParam))
          : normalizedOffset;
      return await loadQueuePage(targetOffset, normalizedLimit);
    },
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.pagination;
      if (!pagination?.hasMore || !pagination.nextCursor) return undefined;
      const nextOffset = Number.parseInt(pagination.nextCursor, 10);
      if (!Number.isFinite(nextOffset)) return undefined;
      return Math.max(0, Math.floor(nextOffset));
    },
    refetchInterval: (state) => {
      const pages = state.state.data?.pages;
      if (!pages || pages.length === 0) return 10_000;
      const hasRunning = pages.some(
        (page) =>
          Array.isArray(page.items) &&
          page.items.some((item) => item.queueState === 'running')
      );
      return hasRunning ? 2_500 : 8_000;
    },
  });

  const playMutation = useMutation<NextUpPlayResponse, Error, NextUpActionInput, QueueMutationContext>({
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
          workspaceId: projectId ?? undefined,
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
        throw parseMissionControlApiError(
          response,
          body,
          'Failed to dispatch queued workstream'
        );
      }
      return (
        body ?? {
          ok: true,
          initiativeId: input.initiativeId,
          workstreamId: input.workstreamId,
          agentId: input.agentId ?? undefined,
          dispatchMode: 'none',
          sessionId: null,
        }
      );
    },
    onMutate: async (input: NextUpActionInput) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<InfiniteData<NextUpQueueResponse>>(queryKey);
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        patchInfiniteQueueData(previous, (item) => {
          if (
            item.initiativeId !== input.initiativeId ||
            item.workstreamId !== input.workstreamId
          ) {
            return item;
          }
          return { ...item, queueState: 'running', playbackState: 'running' };
        })
      );
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    onSuccess: (result, input) => {
      if (input.initiativeId) {
        setAutoContinueStatusCache(
          input.initiativeId,
          result.dispatchMode === 'none'
            ? null
            : ({
                id: result.sessionId ?? `${input.initiativeId}:${input.workstreamId}:play`,
                initiativeId: input.initiativeId,
                agentId: input.agentId ?? 'auto',
                agentName: null,
                tokenBudget: null,
                tokensUsed: 0,
                status: 'running',
                stopRequested: false,
                updatedAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
                stoppedAt: null,
                lastError: null,
                lastTaskId: null,
                lastRunId: result.sessionId ?? null,
                activeTaskId: null,
                activeRunId: result.sessionId ?? null,
                stopReason: null,
                activeSliceRunIds: result.sessionId ? [result.sessionId] : [],
                activeTaskIds: [],
                maxParallelSlices: input.maxParallelSlices ?? 1,
                parallelMode: input.parallelMode ?? 'iwmt',
              } as AutoContinueRun)
        );
      }
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        (current) =>
          patchInfiniteQueueData(current, (item) => {
            if (
              item.initiativeId !== input.initiativeId ||
              item.workstreamId !== input.workstreamId
            ) {
              return item;
            }
            return {
              ...item,
              queueState: result.dispatchMode === 'none' ? item.queueState : 'running',
              playbackState: result.dispatchMode === 'none' ? item.playbackState : 'running',
            };
          })
      );
      void invalidate({ includeGraph: false });
    },
  });

  const startAutoContinueMutation = useMutation<
    StartAutoContinueResponse,
    Error,
    StartAutoContinueInput,
    QueueMutationContext
  >({
    mutationFn: async (input: StartAutoContinueInput) => {
      if (demoMode) {
        return {
          ok: true,
          initiativeId: input.initiativeId,
          workstreamIds: [input.workstreamId],
          run: null,
        };
      }
      const payload: Record<string, unknown> = {
        initiativeId: input.initiativeId,
        workspaceId: projectId ?? undefined,
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

      const body = await readResponseJson<StartAutoContinueResponse>(response);
      if (!response.ok) {
        const upgradeError = parseUpgradeRequiredError(body);
        if (upgradeError) throw upgradeError;
        throw parseMissionControlApiError(
          response,
          body,
          'Failed to start auto-continue'
        );
      }
      return body ?? { ok: true, initiativeId: input.initiativeId, workstreamIds: [input.workstreamId], run: null };
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<InfiniteData<NextUpQueueResponse>>(queryKey);
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        patchInfiniteQueueData(previous, (item) => {
          if (item.initiativeId !== input.initiativeId) return item;
          const isTargetWorkstream =
            item.workstreamId === input.workstreamId || input.scope !== 'workstream';
          if (!isTargetWorkstream) return item;
          return {
            ...item,
            autoContinue: {
              ...(item.autoContinue ?? {
                status: 'running' as const,
                activeTaskId: null,
                activeRunId: null,
                stopReason: null,
                maxParallelSlices: input.maxParallelSlices ?? 1,
                parallelMode: input.parallelMode ?? 'iwmt',
                updatedAt: new Date().toISOString(),
              }),
              status: 'running',
              stopReason: null,
              maxParallelSlices: input.maxParallelSlices ?? item.autoContinue?.maxParallelSlices ?? 1,
              parallelMode: input.parallelMode ?? item.autoContinue?.parallelMode ?? 'iwmt',
              updatedAt: new Date().toISOString(),
            },
          };
        })
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (result, input) => {
      setAutoContinueStatusCache(input.initiativeId, result.run ?? null);
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        (current) =>
          patchInfiniteQueueData(current, (item) => {
            if (item.initiativeId !== input.initiativeId) return item;
            const isTargetWorkstream =
              item.workstreamId === input.workstreamId || input.scope !== 'workstream';
            if (!isTargetWorkstream) return item;
            return {
              ...item,
              autoContinue: result.run
                ? {
                    status: result.run.status,
                    activeTaskId: result.run.activeTaskId ?? null,
                    activeRunId:
                      result.run.activeRunId ??
                      result.run.activeSliceRunIds?.[0] ??
                      result.run.lastRunId ??
                      null,
                    stopReason: result.run.stopReason,
                    maxParallelSlices: result.run.maxParallelSlices,
                    parallelMode: result.run.parallelMode,
                    updatedAt: result.run.updatedAt,
                  }
                : item.autoContinue,
            };
          })
      );
      void invalidate({ includeGraph: false });
    },
  });

  const stopAutoContinueMutation = useMutation<
    StartAutoContinueResponse,
    Error,
    { initiativeId: string },
    QueueMutationContext
  >({
    mutationFn: async (input: { initiativeId: string }) => {
      if (demoMode) {
        return {
          ok: true,
          initiativeId: input.initiativeId,
          run: null,
        };
      }
      const response = await fetch('/orgx/api/mission-control/auto-continue/stop', {
        method: 'POST',
        headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
        body: JSON.stringify({ initiativeId: input.initiativeId }),
      });
      const body = await readResponseJson<StartAutoContinueResponse>(response);
      if (!response.ok) {
        throw parseMissionControlApiError(
          response,
          body,
          'Failed to stop auto-continue'
        );
      }
      return (
        body ?? {
          ok: true,
          initiativeId: input.initiativeId,
          run: null,
        }
      );
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<InfiniteData<NextUpQueueResponse>>(queryKey);
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        patchInfiniteQueueData(previous, (item) => {
          if (item.initiativeId !== input.initiativeId || !item.autoContinue) return item;
          return {
            ...item,
            autoContinue: {
              ...item.autoContinue,
              status: 'stopping',
              updatedAt: new Date().toISOString(),
            },
          };
        })
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (result, input) => {
      setAutoContinueStatusCache(input.initiativeId, result.run ?? null);
      queryClient.setQueryData<InfiniteData<NextUpQueueResponse>>(
        queryKey,
        (current) =>
          patchInfiniteQueueData(current, (item) => {
            if (item.initiativeId !== input.initiativeId) return item;
            if (!item.autoContinue) return item;
            return {
              ...item,
              autoContinue: result.run
                ? {
                    status: result.run.status,
                    activeTaskId: result.run.activeTaskId ?? null,
                    activeRunId:
                      result.run.activeRunId ??
                      result.run.activeSliceRunIds?.[0] ??
                      result.run.lastRunId ??
                      null,
                    stopReason: result.run.stopReason,
                    maxParallelSlices: result.run.maxParallelSlices,
                    parallelMode: result.run.parallelMode,
                    updatedAt: result.run.updatedAt,
                  }
                : null,
            };
          })
      );
      void invalidate({ includeGraph: false });
    },
  });

  const allItems = useMemo(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return [];
    const seen = new Set<string>();
    const merged: NextUpQueueItem[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        const key = `${item.initiativeId}:${item.workstreamId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }, [query.data?.pages]);

  const combinedTotal = useMemo(() => {
    const pages = query.data?.pages ?? [];
    let maxTotal = 0;
    for (const page of pages) {
      if (typeof page.total === 'number' && Number.isFinite(page.total)) {
        maxTotal = Math.max(maxTotal, page.total);
      }
    }
    return Math.max(maxTotal, allItems.length);
  }, [allItems.length, query.data?.pages]);

  const combinedPagination = useMemo(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return null;
    const first = pages[0];
    const last = pages[pages.length - 1];
    const firstPagination = first.pagination;
    const lastPagination = last.pagination;
    const hasMore = Boolean(query.hasNextPage);
    return {
      offset:
        firstPagination && Number.isFinite(firstPagination.offset)
          ? Math.max(0, Math.floor(firstPagination.offset))
          : normalizedOffset,
      limit:
        firstPagination && Number.isFinite(firstPagination.limit)
          ? Math.max(1, Math.floor(firstPagination.limit))
          : normalizedLimit,
      total: combinedTotal,
      nextCursor: hasMore
        ? lastPagination?.nextCursor ??
          String(
            (lastPagination?.offset ?? normalizedOffset) +
              (lastPagination?.limit ?? normalizedLimit)
          )
        : null,
      hasMore,
    } satisfies NonNullable<NextUpQueueResponse['pagination']>;
  }, [
    combinedTotal,
    normalizedLimit,
    normalizedOffset,
    query.data?.pages,
    query.hasNextPage,
  ]);

  const combinedGeneratedAt = query.data?.pages[0]?.generatedAt ?? null;
  const combinedSummary = useMemo(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return null;
    let bestVisibleTotal = 0;
    const stateCounts = {
      queued: 0,
      running: 0,
      blocked: 0,
      idle: 0,
      completed: 0,
    } satisfies Record<NextUpQueueState, number>;
    let sawSummary = false;
    for (const page of pages) {
      if (!page.summary) continue;
      sawSummary = true;
      bestVisibleTotal = Math.max(bestVisibleTotal, page.summary.visibleTotal ?? 0);
      stateCounts.queued = Math.max(stateCounts.queued, page.summary.stateCounts?.queued ?? 0);
      stateCounts.running = Math.max(stateCounts.running, page.summary.stateCounts?.running ?? 0);
      stateCounts.blocked = Math.max(stateCounts.blocked, page.summary.stateCounts?.blocked ?? 0);
      stateCounts.idle = Math.max(stateCounts.idle, page.summary.stateCounts?.idle ?? 0);
      stateCounts.completed = Math.max(
        stateCounts.completed,
        page.summary.stateCounts?.completed ?? 0
      );
    }
    if (!sawSummary) return null;
    return {
      visibleTotal: bestVisibleTotal,
      stateCounts,
    } satisfies NonNullable<NextUpQueueResponse['summary']>;
  }, [query.data?.pages]);
  const combinedDegraded = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const deduped = new Set<string>();
    for (const page of pages) {
      for (const reason of page.degraded ?? []) {
        if (typeof reason === 'string' && reason.trim().length > 0) {
          deduped.add(reason);
        }
      }
    }
    return Array.from(deduped);
  }, [query.data?.pages]);

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
    total: combinedTotal,
    summary: combinedSummary,
    pagination: combinedPagination,
    generatedAt: combinedGeneratedAt,
    degraded: combinedDegraded,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: Boolean(query.hasNextPage),
    error: query.error?.message ?? null,
    refetch: query.refetch,
    fetchNextPage: query.fetchNextPage,
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
  summary?: NextUpQueueResponse['summary'] | null;
  pagination?: NextUpQueueResponse['pagination'] | null;
  generatedAt: string | null;
  degraded: string[];
  isLoading: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
  playWorkstream: (input: NextUpActionInput) => Promise<NextUpPlayResponse>;
  startWorkstreamAutoContinue: (input: StartAutoContinueInput) => Promise<StartAutoContinueResponse | undefined>;
  stopInitiativeAutoContinue: (input: { initiativeId: string }) => Promise<unknown>;
  isPlaying: boolean;
  isStartingAutoContinue: boolean;
  isStoppingAutoContinue: boolean;
  zoomLevel: ZoomLevel;
  initiativeGroups: InitiativeGroupItem[];
  milestoneGroups: MilestoneGroupItem[];
}
