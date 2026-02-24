import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  MissionControlSliceItem,
  MissionControlSliceLevel,
  MissionControlSliceOrderMode,
  MissionControlSlicesResponse,
} from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import { appendWorkspaceScopeParams } from '@/lib/workspaceScope';

interface UseMissionControlSlicesOptions {
  workspaceId?: string | null;
  initiativeId?: string | null;
  level: MissionControlSliceLevel;
  orderMode?: MissionControlSliceOrderMode | null;
  includeCompleted?: boolean;
  search?: string;
  offset?: number;
  limit?: number;
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRunnerSource(value: unknown): 'assigned' | 'inferred' | 'fallback' | null {
  const raw = (asString(value) ?? '').toLowerCase();
  if (raw === 'assigned' || raw === 'inferred' || raw === 'fallback') return raw;
  return null;
}

function normalizeRunnerName(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'undefined' || normalized === 'null' || normalized === 'main') return null;
  return raw;
}

function normalizeLevel(
  value: unknown,
  fallback: MissionControlSliceLevel
): MissionControlSliceLevel {
  const normalized = (asString(value) ?? '').toLowerCase();
  if (normalized === 'initiative') return 'initiative';
  if (normalized === 'milestone') return 'milestone';
  if (normalized === 'task') return 'task';
  if (normalized === 'workstream') return 'workstream';
  return fallback;
}

function normalizeOrderMode(value: unknown): MissionControlSliceOrderMode {
  return (asString(value) ?? '').toLowerCase() === 'algorithmic'
    ? 'algorithmic'
    : 'manual';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeSliceItem(
  raw: unknown,
  fallbackLevel: MissionControlSliceLevel,
  fallbackRank: number
): MissionControlSliceItem | null {
  const record = asRecord(raw);
  if (!record) return null;

  const sliceId = asString(record.sliceId) ?? asString(record.id);
  if (!sliceId) return null;

  const level = normalizeLevel(record.level ?? record.scope, fallbackLevel);
  const title =
    asString(record.title) ??
    asString(record.workstreamTitle) ??
    asString(record.milestoneTitle) ??
    asString(record.taskTitle) ??
    asString(record.initiativeTitle) ??
    sliceId;

  const orderRecord = asRecord(record.order);
  const dispatchRecord = asRecord(record.dispatch);
  const objectiveRecord = asRecord(
    record.objectiveSnapshot ?? record.objective ?? record.ranking
  );
  const factorsRecord = asRecord(record.factors);
  const iwmtRecord = asRecord(record.iwmt);
  const lineageRecord = asRecord(record.lineage);

  return {
    sliceId,
    level,
    title,
    initiativeId: asString(record.initiativeId),
    initiativeTitle: asString(record.initiativeTitle),
    workstreamId: asString(record.workstreamId),
    workstreamTitle: asString(record.workstreamTitle),
    milestoneId: asString(record.milestoneId),
    milestoneTitle: asString(record.milestoneTitle),
    taskId: asString(record.taskId),
    taskTitle: asString(record.taskTitle),
    status:
      asString(record.status) ??
      asString(record.queueState) ??
      (dispatchRecord && dispatchRecord.runnable === false ? 'blocked' : 'queued'),
    priorityNum: asNumber(record.priorityNum ?? record.nextTaskPriority),
    dueAt: asString(record.dueAt ?? record.nextTaskDueAt),
    dependencyState: asString(record.dependencyState),
    objectiveScore:
      asNumber(record.objectiveScore) ??
      asNumber(objectiveRecord?.objectiveScore) ??
      asNumber(record.mixScore),
    roiPerToken:
      asNumber(record.roiPerToken) ??
      asNumber(objectiveRecord?.roiPerToken),
    expectedTokens:
      asNumber(record.expectedTokens) ??
      asNumber(objectiveRecord?.expectedTokens),
    expectedValueUsd:
      asNumber(record.expectedValueUsd) ??
      asNumber(objectiveRecord?.expectedValueUsd),
    goalAlignment:
      asNumber(record.goalAlignment) ??
      asNumber(factorsRecord?.goalAlignment),
    riskPenalty:
      asNumber(record.riskPenalty) ??
      asNumber(factorsRecord?.riskPenalty),
    runnable:
      typeof dispatchRecord?.runnable === 'boolean'
        ? dispatchRecord.runnable
        : undefined,
    blockReason: asString(dispatchRecord?.blockReason ?? record.blockReason),
    suggestedScope:
      dispatchRecord && dispatchRecord.suggestedScope
        ? normalizeLevel(dispatchRecord.suggestedScope, level)
        : null,
    manualRank:
      asNumber(record.manualRank) ??
      asNumber(orderRecord?.manualRank),
    algorithmRank:
      asNumber(record.algorithmRank) ??
      asNumber(orderRecord?.algorithmRank) ??
      fallbackRank,
    finalRank:
      asNumber(record.finalRank) ??
      asNumber(orderRecord?.finalRank) ??
      fallbackRank,
    iwmt: iwmtRecord
      ? {
          laneId: asString(iwmtRecord.laneId),
          mixScore: asNumber(iwmtRecord.mixScore),
          factors: Array.isArray(iwmtRecord.factors)
            ? iwmtRecord.factors
                .map((entry) => {
                  const factor = asRecord(entry);
                  if (!factor) return null;
                  return {
                    key: asString(factor.key) ?? undefined,
                    label:
                      asString(factor.label) ??
                      asString(factor.key) ??
                      undefined,
                    value: asNumber(factor.value) ?? undefined,
                    weight: asNumber(factor.weight) ?? undefined,
                  };
                })
                .filter((entry): entry is NonNullable<typeof entry> =>
                  Boolean(entry)
                )
            : undefined,
        }
      : null,
    lineage: lineageRecord
      ? {
          initiativeIds: toStringArray(lineageRecord.initiativeIds),
          workstreamIds: toStringArray(lineageRecord.workstreamIds),
          milestoneIds: toStringArray(lineageRecord.milestoneIds),
          taskIds: toStringArray(lineageRecord.taskIds),
          iwmtIds: toStringArray(lineageRecord.iwmtIds),
        }
      : null,
    sourceWorkstreamIds: toStringArray(record.sourceWorkstreamIds),
    queueState: asString(record.queueState),
    sliceTaskIds: toStringArray(record.sliceTaskIds),
    sliceTaskCount: asNumber(record.sliceTaskCount),
    sliceMilestoneId: asString(record.sliceMilestoneId),
    runnerAgentId: normalizeRunnerName(record.runnerAgentId ?? record.agentId),
    runnerAgentName:
      normalizeRunnerName(record.runnerAgentName ?? record.agentName) ??
      normalizeRunnerName(record.runner),
    runnerSource:
      normalizeRunnerSource(record.runnerSource) ??
      (normalizeRunnerName(record.runnerAgentId ?? record.agentId) ? 'inferred' : 'fallback'),
    updatedAt: asString(record.updatedAt),
  };
}

function buildDemoSlicesResponse(
  level: MissionControlSliceLevel,
  orderMode: MissionControlSliceOrderMode,
  offset: number,
  limit: number
): MissionControlSlicesResponse {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    level,
    orderMode,
    mixPolicy: 'iwmt_v1',
    total: 0,
    items: [],
    degraded: ['Demo mode: slice explorer uses fixture data only.'],
    source: 'local',
    pagination: {
      offset,
      limit,
      total: 0,
      nextCursor: null,
      hasMore: false,
    },
  };
}

function buildFallbackPagination(input: {
  offset: number;
  limit: number;
  total: number;
}) {
  const nextOffset = input.offset + input.limit;
  const hasMore = nextOffset < input.total;
  return {
    offset: input.offset,
    limit: input.limit,
    total: input.total,
    nextCursor: hasMore ? String(nextOffset) : null,
    hasMore,
  };
}

export function useMissionControlSlices({
  workspaceId = null,
  initiativeId = null,
  level,
  orderMode = null,
  includeCompleted = false,
  search = '',
  offset = 0,
  limit = 24,
  authToken = null,
  embedMode = false,
  enabled = true,
}: UseMissionControlSlicesOptions) {
  const demoMode = isDemoModeEnabled();
  const normalizedOffset = Math.max(0, offset);
  const normalizedLimit = Math.max(1, Math.min(300, limit));
  const normalizedSearch = search.trim();
  const queryKey = useMemo(
    () =>
      queryKeys.missionControlSlices({
        workspaceId,
        initiativeId,
        level,
        orderMode,
        includeCompleted,
        search: normalizedSearch,
        offset: normalizedOffset,
        limit: normalizedLimit,
        authToken,
        embedMode,
      }),
    [
      authToken,
      embedMode,
      includeCompleted,
      initiativeId,
      level,
      normalizedLimit,
      normalizedOffset,
      normalizedSearch,
      orderMode,
      workspaceId,
    ]
  );

  const query = useQuery<MissionControlSlicesResponse, Error>({
    queryKey,
    enabled,
    queryFn: async () => {
      if (demoMode) {
        return buildDemoSlicesResponse(
          level,
          orderMode ?? 'manual',
          normalizedOffset,
          normalizedLimit
        );
      }

      const params = new URLSearchParams();
      if (workspaceId) {
        appendWorkspaceScopeParams(params, workspaceId, {
          includeCenterAlias: true,
          includeProjectAlias: false,
        });
      }
      if (initiativeId) params.set('initiative_id', initiativeId);
      params.set('level', level);
      params.set('include_completed', includeCompleted ? '1' : '0');
      params.set('offset', String(normalizedOffset));
      params.set('limit', String(normalizedLimit));
      params.set('mix_policy', 'iwmt_v1');
      if (orderMode) params.set('order_mode', orderMode);
      if (normalizedSearch.length > 0) params.set('q', normalizedSearch);

      const response = await fetch(
        `/orgx/api/mission-control/slices?${params.toString()}`,
        {
          headers: buildOrgxHeaders({ authToken, embedMode }),
        }
      );
      const body = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        const message =
          (body && typeof body.error === 'string' && body.error) ||
          (body && typeof body.message === 'string' && body.message) ||
          `Failed to fetch mission-control slices (${response.status})`;
        throw new Error(message);
      }

      const rawItems = Array.isArray(body?.items) ? body.items : [];
      const resolvedLevel = normalizeLevel(body?.level ?? body?.scope, level);
      const normalizedItems = rawItems
        .map((item, index) => normalizeSliceItem(item, resolvedLevel, index + 1))
        .filter((item): item is MissionControlSliceItem => Boolean(item));

      const paginationRecord = asRecord(body?.pagination);
      const total =
        asNumber(body?.total) ??
        asNumber(paginationRecord?.total) ??
        normalizedItems.length;
      const pagination = paginationRecord
        ? {
            offset:
              asNumber(paginationRecord.offset) ?? normalizedOffset,
            limit: asNumber(paginationRecord.limit) ?? normalizedLimit,
            total,
            nextCursor: asString(paginationRecord.nextCursor),
            hasMore:
              typeof paginationRecord.hasMore === 'boolean'
                ? paginationRecord.hasMore
                : false,
          }
        : buildFallbackPagination({
            offset: normalizedOffset,
            limit: normalizedLimit,
            total,
          });

      return {
        ok: true,
        generatedAt:
          asString(body?.generatedAt) ?? new Date().toISOString(),
        workspaceId: asString(body?.workspaceId ?? body?.workspace_id),
        initiativeId: asString(
          body?.initiativeId ?? body?.initiative_id ?? initiativeId
        ),
        level: resolvedLevel,
        mixPolicy:
          asString(body?.mixPolicy ?? body?.mix_policy) ?? 'iwmt_v1',
        orderMode: normalizeOrderMode(body?.orderMode ?? body?.order_mode ?? body?.order),
        total,
        items: normalizedItems,
        degraded: Array.isArray(body?.degraded)
          ? body.degraded
              .map((entry) => asString(entry))
              .filter((entry): entry is string => Boolean(entry))
          : undefined,
        source:
          asString(body?.source) === 'canonical'
            ? 'canonical'
            : asString(body?.source) === 'local_fallback'
              ? 'local_fallback'
              : 'local',
        pagination,
      };
    },
  });

  return {
    ...query,
    slices: query.data?.items ?? [],
    orderMode: query.data?.orderMode ?? (orderMode ?? 'manual'),
    degraded: query.data?.degraded ?? [],
    source: query.data?.source ?? null,
    pagination: query.data?.pagination ?? null,
  };
}
