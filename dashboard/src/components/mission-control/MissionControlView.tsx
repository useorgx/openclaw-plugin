import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import type {
  ActivityItem,
  Agent,
  ConnectionStatus,
  Initiative,
  LiveActivityItem,
  RuntimeInstance,
} from '@/types';
import { useAgentEntityMap } from '@/hooks/useAgentEntityMap';
import { useAutoContinue } from '@/hooks/useAutoContinue';
import { useNextUpQueue, type NextUpQueueItem, type UseNextUpQueueResult } from '@/hooks/useNextUpQueue';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
import { useRangeSelection } from '@/hooks/useRangeSelection';
import { useInitiativeSearch } from '@/hooks/useInitiativeSearch';
import { openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { isMissionControlApiError } from '@/lib/missionControlApiError';
import { captureTelemetry } from '@/lib/telemetry';
import { humanizeId, humanizeWarning, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { SearchInput } from '@/components/shared/SearchInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { MissionControlProvider, useMissionControl } from './MissionControlContext';
import type { GroupByOption } from './MissionControlContext';
import { InitiativeOrbit } from './InitiativeOrbit';
import { MissionControlEmpty } from './MissionControlEmpty';
import { EntityDetailModal } from './EntityDetailModal';
import { MissionControlFilters } from './MissionControlFilters';
import { NextUpPanel } from './NextUpPanel';
import { SliceExplorerPanel } from './SliceExplorerPanel';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { InlineToast } from '@/components/shared/InlineToast';
import { HealthScoreCard } from './HealthScoreCard';
import { CostRollupCard } from './CostRollupCard';
import { ActionQueueStrip } from './ActionQueueStrip';
import { useUsageControlPlane } from '@/hooks/useUsageControlPlane';
import { useInitiativeSummary } from '@/hooks/useInitiativeSummary';
import { missionControlMotion } from '@/lib/tokens';

interface MissionControlViewProps {
  initiatives: Initiative[];
  activities: Array<ActivityItem | LiveActivityItem>;
  agents: Agent[];
  runtimeInstances?: RuntimeInstance[];
  workspaceInitiativeId?: string | null;
  isLoading: boolean;
  authToken: string | null;
  embedMode: boolean;
  initialInitiativeId?: string | null;
  connection?: ConnectionStatus;
  lastSnapshotAt?: string | null;
  error?: string | null;
  hasApiKey?: boolean;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
  onCreateInitiative?: () => void;
  onPlayNextUp?: () => Promise<void> | void;
  onStartAutopilot?: () => Promise<void> | void;
  nextUpQueueModel?: UseNextUpQueueResult;
  nextUpActionsModel?: ReturnType<typeof useNextUpQueueActions>;
  snapshotVersion?: number | null;
  devMode?: boolean;
}

function toStatusKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseLocalDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromField(initiative: Initiative, field: 'target' | 'created' | 'updated'): string | null {
  if (field === 'target') return initiative.targetDate ?? null;
  if (field === 'created') return initiative.createdAt ?? null;
  return initiative.updatedAt ?? initiative.createdAt ?? null;
}

function initiativePriorityRank(priority: string | null | undefined): number {
  const normalized = (priority ?? '').trim().toLowerCase();
  if (!normalized) return 4;
  if (normalized === 'critical' || normalized === 'p0' || normalized === 'urgent') return 0;
  if (normalized === 'high' || normalized === 'p1') return 1;
  if (normalized === 'medium' || normalized === 'normal' || normalized === 'p2') return 2;
  if (normalized === 'low' || normalized === 'p3') return 3;
  return 4;
}

function initiativeStatusSortRank(status: Initiative['status']): number {
  if (status === 'active') return 0;
  if (status === 'blocked') return 1;
  if (status === 'paused') return 2;
  return 3;
}

function isDoneTaskStatus(status: string | null | undefined): boolean {
  const normalized = toStatusKey(status);
  return (
    normalized === 'completed' ||
    normalized === 'done' ||
    normalized === 'resolved' ||
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'archived'
  );
}

function groupInitiatives(
  initiatives: Initiative[],
  groupBy: GroupByOption,
): Array<{ key: string; label: string; count: number; initiatives: Initiative[] }> {
  if (groupBy === 'status') {
    const groups = new Map<string, Initiative[]>();
    const order = ['active', 'blocked', 'paused', 'completed'];
    for (const init of initiatives) {
      const status = init.status ?? 'active';
      const list = groups.get(status) ?? [];
      list.push(init);
      groups.set(status, list);
    }
    return order
      .filter((key) => groups.has(key))
      .concat(Array.from(groups.keys()).filter((key) => !order.includes(key)))
      .map((key) => ({
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        count: groups.get(key)?.length ?? 0,
        initiatives: groups.get(key) ?? [],
      }));
  }

  if (groupBy === 'category') {
    const groups = new Map<string, Initiative[]>();
    for (const init of initiatives) {
      const cat = init.category ?? 'Uncategorized';
      const list = groups.get(cat) ?? [];
      list.push(init);
      groups.set(cat, list);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, items]) => ({
        key,
        label: key,
        count: items.length,
        initiatives: items,
      }));
  }

  if (groupBy === 'date') {
    const now = new Date();
    const todayStart = startOfLocalDay(now);
    const weekEnd = todayStart + 7 * 86_400_000;
    const monthEnd = todayStart + 30 * 86_400_000;

    const buckets: Record<string, Initiative[]> = {
      overdue: [],
      this_week: [],
      this_month: [],
      later: [],
      no_date: [],
    };

    for (const init of initiatives) {
      const target = init.targetDate ? Date.parse(init.targetDate) : null;
      if (target === null || !Number.isFinite(target)) {
        buckets.no_date.push(init);
      } else if (target < todayStart) {
        buckets.overdue.push(init);
      } else if (target < weekEnd) {
        buckets.this_week.push(init);
      } else if (target < monthEnd) {
        buckets.this_month.push(init);
      } else {
        buckets.later.push(init);
      }
    }

    const labels: Record<string, string> = {
      overdue: 'Overdue',
      this_week: 'This Week',
      this_month: 'This Month',
      later: 'Later',
      no_date: 'No Date',
    };

    return ['overdue', 'this_week', 'this_month', 'later', 'no_date']
      .filter((key) => buckets[key].length > 0)
      .map((key) => ({
        key,
        label: labels[key],
        count: buckets[key].length,
        initiatives: buckets[key],
      }));
  }

  return [];
}

function groupDisclosureId(groupBy: GroupByOption, key: string): string {
  return `${groupBy}:${key}`;
}

function toDisclosureDomId(value: string): string {
  return `mc-group-${value}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function isSameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function nextUpModeLabel(mode: 'none' | 'running' | 'blocked' | 'queued' | 'startable' | 'completed' | 'active_no_queue'): string {
  if (mode === 'running') return 'Running';
  if (mode === 'blocked') return 'Blocked';
  if (mode === 'queued') return 'Queued';
  if (mode === 'startable') return 'Startable';
  if (mode === 'completed') return 'Complete';
  if (mode === 'active_no_queue') return 'Idle';
  return 'No target';
}

function nextUpModeTone(mode: 'none' | 'running' | 'blocked' | 'queued' | 'startable' | 'completed' | 'active_no_queue'): string {
  if (mode === 'running') return 'border-teal-300/24 bg-teal-400/[0.08] text-teal-100/90';
  if (mode === 'blocked') return 'border-red-400/24 bg-red-500/[0.08] text-red-100/90';
  if (mode === 'queued' || mode === 'startable') return 'border-lime/18 bg-lime/[0.06] text-lime/95';
  if (mode === 'completed') return 'border-strong bg-white/[0.05] text-secondary';
  return 'border-strong bg-white/[0.04] text-white/68';
}

function formatLiveIssueDetail(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('request cancelled') ||
    normalized.includes('signal is aborted')
  ) {
    return 'Live sync is taking longer than expected. Initiatives and Next Up will repopulate as soon as sync completes.';
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('api key') ||
    normalized.includes('auth')
  ) {
    return 'OrgX authentication needs attention. Reconnect your API key in Settings.';
  }
  if (
    normalized.includes('unknown api endpoint') ||
    normalized.includes('missing required live routes')
  ) {
    return 'This runtime is missing required live routes. Restart and update the plugin build.';
  }
  const compact = raw
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^[^:]+:\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return humanizeWarning(compact || raw) || 'Live data is temporarily unavailable.';
}

function formatMissionControlError(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const message = humanizeWarning(raw.trim());
  return message || fallback;
}

type PlayConflictState = {
  target: NextUpQueueItem;
  message: string;
  activeWorkstreamTitle: string | null;
  activeWorkstreamId: string | null;
};

const PAGE_SIZE_OPTIONS = [12, 24, 36, 48, 72] as const;

export function MissionControlView({
  initiatives,
  activities,
  agents,
  runtimeInstances = [],
  workspaceInitiativeId = null,
  isLoading,
  authToken,
  embedMode,
  initialInitiativeId,
  connection,
  lastSnapshotAt,
  error,
  hasApiKey,
  onOpenSettings,
  onRefresh,
  onCreateInitiative,
  onPlayNextUp,
  onStartAutopilot,
  nextUpQueueModel,
  nextUpActionsModel,
  snapshotVersion = null,
  devMode = false,
}: MissionControlViewProps) {
  const agentEntityMap = useAgentEntityMap({ activities, agents, initiatives });

  return (
    <MissionControlProvider
      agentEntityMap={agentEntityMap}
      authToken={authToken}
      embedMode={embedMode}
    >
      <MissionControlInner
        initiatives={initiatives}
        runtimeInstances={runtimeInstances}
        workspaceInitiativeId={workspaceInitiativeId}
        isLoading={isLoading}
        initialInitiativeId={initialInitiativeId}
        connection={connection}
        lastSnapshotAt={lastSnapshotAt}
        error={error}
        hasApiKey={hasApiKey}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
        onCreateInitiative={onCreateInitiative}
        onPlayNextUp={onPlayNextUp}
        onStartAutopilot={onStartAutopilot}
        nextUpQueueModel={nextUpQueueModel}
        nextUpActionsModel={nextUpActionsModel}
        snapshotVersion={snapshotVersion}
        devMode={devMode}
      />
    </MissionControlProvider>
  );
}

function formatLocalTimestamp(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  try {
    return new Date(parsed).toLocaleString();
  } catch {
    return 'unknown';
  }
}

function mergeInitiativeForSearch(existing: Initiative, incoming: Initiative): Initiative {
  return {
    ...incoming,
    ...existing,
    rawStatus: existing.rawStatus ?? incoming.rawStatus ?? null,
    priority: existing.priority ?? incoming.priority ?? null,
    targetDate: existing.targetDate ?? incoming.targetDate ?? null,
    createdAt: existing.createdAt ?? incoming.createdAt ?? null,
    updatedAt: existing.updatedAt ?? incoming.updatedAt ?? null,
    description: existing.description ?? incoming.description,
    activeAgents: Math.max(existing.activeAgents, incoming.activeAgents),
    totalAgents: Math.max(existing.totalAgents, incoming.totalAgents),
    avatars: existing.avatars?.length ? existing.avatars : incoming.avatars,
    workstreams: existing.workstreams?.length ? existing.workstreams : incoming.workstreams,
    health: existing.health > 0 ? existing.health : incoming.health,
  };
}

function MissionControlInner({
  initiatives,
  runtimeInstances,
  workspaceInitiativeId = null,
  isLoading,
  initialInitiativeId,
  connection,
  lastSnapshotAt,
  error,
  hasApiKey,
  onOpenSettings,
  onRefresh,
  onCreateInitiative,
  onPlayNextUp,
  onStartAutopilot,
  nextUpQueueModel,
  nextUpActionsModel,
  snapshotVersion = null,
  devMode = false,
}: {
  initiatives: Initiative[];
  runtimeInstances: RuntimeInstance[];
  workspaceInitiativeId?: string | null;
  isLoading: boolean;
  initialInitiativeId?: string | null;
  connection?: ConnectionStatus;
  lastSnapshotAt?: string | null;
  error?: string | null;
  hasApiKey?: boolean;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
  onCreateInitiative?: () => void;
  onPlayNextUp?: () => Promise<void> | void;
  onStartAutopilot?: () => Promise<void> | void;
  nextUpQueueModel?: UseNextUpQueueResult;
  nextUpActionsModel?: ReturnType<typeof useNextUpQueueActions>;
  snapshotVersion?: number | null;
  devMode?: boolean;
}) {
  const {
    searchQuery,
    setSearchQuery,
    statusFilters,
    setStatusFilters,
    dateField,
    setDateField,
    datePreset,
    setDatePreset,
    dateStart,
    setDateStart,
    dateEnd,
    setDateEnd,
    clearFilters,
    hasActiveFilters,
    groupBy,
    sortBy,
    expandedInitiatives,
    expandAll,
    collapseAll,
    modalTarget,
    closeModal,
    expandInitiative,
    authToken,
    embedMode,
    mutations,
  } = useMissionControl();
  const didAutoExpand = useRef(false);
  const stickyToolbarRef = useRef<HTMLDivElement | null>(null);
  const expandWaveTokenRef = useRef(0);
  const [stickyToolbarOffset, setStickyToolbarOffset] = useState(0);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [isExpandWaveActive, setIsExpandWaveActive] = useState(false);
  const [connectivityToastDismissed, setConnectivityToastDismissed] = useState(false);
  const [nextUpRailOpen, setNextUpRailOpen] = useState(false);
  const [nextUpDrawerOpen, setNextUpDrawerOpen] = useState(false);
  const [railSurface, setRailSurface] = useState<'next-up' | 'slices'>('next-up');
  const [nextActionNotice, setNextActionNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [playConflict, setPlayConflict] = useState<PlayConflictState | null>(null);
  const [isSwitchingRun, setIsSwitchingRun] = useState(false);
  const [autoEnableTarget, setAutoEnableTarget] = useState<NextUpQueueItem | null>(null);
  const [railActionKey, setRailActionKey] = useState<
    'start' | 'pause' | 'defer' | 'auto' | null
  >(null);
  const [selectedInitiativeIds, setSelectedInitiativeIds] = useState<Set<string>>(new Set());
  const [confirmBulkInitiativeDelete, setConfirmBulkInitiativeDelete] = useState(false);
  const [bulkInitiativeNotice, setBulkInitiativeNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(24);
  const normalizedSearchQuery = searchQuery.trim();
  const initiativeSearch = useInitiativeSearch(
    normalizedSearchQuery,
    normalizedSearchQuery.length >= 2,
    workspaceInitiativeId
  );

  const searchableInitiatives = useMemo(() => {
    if (normalizedSearchQuery.length < 2 || !initiativeSearch.data?.length) {
      return initiatives;
    }

    const merged = new Map<string, Initiative>();
    for (const initiative of initiatives) {
      merged.set(initiative.id, initiative);
    }
    for (const initiative of initiativeSearch.data) {
      const existing = merged.get(initiative.id);
      merged.set(
        initiative.id,
        existing ? mergeInitiativeForSearch(existing, initiative) : initiative
      );
    }
    return Array.from(merged.values());
  }, [initiativeSearch.data, initiatives, normalizedSearchQuery.length]);
  const searchResultIds = useMemo(
    () => new Set((initiativeSearch.data ?? []).map((initiative) => initiative.id)),
    [initiativeSearch.data]
  );

  useEffect(() => {
    if (!bulkInitiativeNotice) return;
    const durationMs = bulkInitiativeNotice.tone === 'success' ? 6500 : 9000;
    const timeout = window.setTimeout(() => setBulkInitiativeNotice(null), durationMs);
    return () => window.clearTimeout(timeout);
  }, [bulkInitiativeNotice?.message, bulkInitiativeNotice?.tone]);

  const filteredInitiatives = useMemo(() => {
    const now = new Date();
    const todayStart = startOfLocalDay(now);

    const queryTokens = searchQuery
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    return searchableInitiatives.filter((initiative) => {
      if (statusFilters.length > 0) {
        const statusCandidates = [
          toStatusKey(initiative.status),
          toStatusKey(initiative.rawStatus),
        ].filter(Boolean);
        if (!statusCandidates.some((candidate) => statusFilters.includes(candidate))) {
          return false;
        }
      }

      const selectedDate = dateFromField(initiative, dateField);
      const selectedDateEpoch = selectedDate ? Date.parse(selectedDate) : Number.NaN;
      const selectedDayEpoch = Number.isFinite(selectedDateEpoch)
        ? startOfLocalDay(new Date(selectedDateEpoch))
        : null;
      const dayDelta =
        selectedDayEpoch === null ? null : Math.round((selectedDayEpoch - todayStart) / 86_400_000);

      if (datePreset === 'missing' && selectedDayEpoch !== null) return false;
      if (datePreset === 'overdue' && !(dayDelta !== null && dayDelta < 0)) return false;
      if (datePreset === 'today' && dayDelta !== 0) return false;
      if (datePreset === 'next_7_days' && !(dayDelta !== null && dayDelta >= 0 && dayDelta <= 7)) {
        return false;
      }
      if (datePreset === 'next_30_days' && !(dayDelta !== null && dayDelta >= 0 && dayDelta <= 30)) {
        return false;
      }
      if (datePreset === 'past_7_days' && !(dayDelta !== null && dayDelta <= 0 && dayDelta >= -7)) {
        return false;
      }
      if (datePreset === 'past_30_days' && !(dayDelta !== null && dayDelta <= 0 && dayDelta >= -30)) {
        return false;
      }
      if (datePreset === 'custom_range') {
        const startEpoch = parseLocalDateInput(dateStart);
        const endEpoch = parseLocalDateInput(dateEnd);
        if (selectedDayEpoch === null) return false;
        if (startEpoch !== null && selectedDayEpoch < startEpoch) return false;
        if (endEpoch !== null && selectedDayEpoch > endEpoch) return false;
      }

      if (queryTokens.length === 0) return true;
      if (searchResultIds.has(initiative.id)) return true;
      const haystack = [
        initiative.name,
        initiative.description ?? '',
        initiative.status,
        initiative.rawStatus ?? '',
        initiative.category ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return queryTokens.every((token) => haystack.includes(token));
    });
  }, [
    searchableInitiatives,
    searchQuery,
    searchResultIds,
    statusFilters,
    dateField,
    datePreset,
    dateStart,
    dateEnd,
  ]);

  const sortedInitiatives = useMemo(() => {
    const byDate = (a: Initiative, b: Initiative, direction: 'asc' | 'desc') => {
      const aDate = a.targetDate ? Date.parse(a.targetDate) : Number.NaN;
      const bDate = b.targetDate ? Date.parse(b.targetDate) : Number.NaN;
      const aValid = Number.isFinite(aDate);
      const bValid = Number.isFinite(bDate);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return direction === 'asc' ? aDate - bDate : bDate - aDate;
    };

    return [...filteredInitiatives].sort((a, b) => {
      if (sortBy === 'date_asc') return byDate(a, b, 'asc');
      if (sortBy === 'date_desc') return byDate(a, b, 'desc');

      const aPriority = initiativePriorityRank(a.priority);
      const bPriority = initiativePriorityRank(b.priority);
      if (sortBy === 'priority_high' && aPriority !== bPriority) return aPriority - bPriority;
      if (sortBy === 'priority_low' && aPriority !== bPriority) return bPriority - aPriority;

      if (sortBy === 'default') {
        const aSequence = typeof a.sequenceIndex === 'number' ? a.sequenceIndex : Number.POSITIVE_INFINITY;
        const bSequence = typeof b.sequenceIndex === 'number' ? b.sequenceIndex : Number.POSITIVE_INFINITY;
        if (aSequence !== bSequence) return aSequence - bSequence;
        const statusDelta = initiativeStatusSortRank(a.status) - initiativeStatusSortRank(b.status);
        if (statusDelta !== 0) return statusDelta;
        if (aPriority !== bPriority) return aPriority - bPriority;
      }

      const updatedA = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const updatedB = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      if (updatedA !== updatedB) return updatedB - updatedA;

      return a.name.localeCompare(b.name);
    });
  }, [filteredInitiatives, sortBy]);

  const totalFilteredCount = sortedInitiatives.length;
  const totalPages = Math.max(1, Math.ceil(totalFilteredCount / pageSize));
  const currentPageIndex = totalFilteredCount === 0 ? 0 : Math.min(pageIndex, totalPages - 1);
  const pageSliceStart = currentPageIndex * pageSize;
  const pageSliceEnd = Math.min(totalFilteredCount, pageSliceStart + pageSize);
  const pageRangeStart = totalFilteredCount === 0 ? 0 : pageSliceStart + 1;
  const pageRangeEnd = totalFilteredCount === 0 ? 0 : pageSliceEnd;
  const pagedInitiatives = useMemo(
    () => sortedInitiatives.slice(pageSliceStart, pageSliceEnd),
    [pageSliceEnd, pageSliceStart, sortedInitiatives]
  );
  const filteredInitiativeIds = useMemo(
    () => new Set(sortedInitiatives.map((initiative) => initiative.id)),
    [sortedInitiatives]
  );
  const selectedFilteredInitiatives = useMemo(
    () => sortedInitiatives.filter((initiative) => selectedInitiativeIds.has(initiative.id)),
    [selectedInitiativeIds, sortedInitiatives]
  );
  const selectedVisibleInitiatives = useMemo(
    () => pagedInitiatives.filter((initiative) => selectedInitiativeIds.has(initiative.id)),
    [pagedInitiatives, selectedInitiativeIds]
  );
  const selectedInitiativeCount = selectedFilteredInitiatives.length;
  const selectedVisibleCount = selectedVisibleInitiatives.length;
  const allVisibleSelected =
    pagedInitiatives.length > 0 && selectedVisibleCount === pagedInitiatives.length;
  const isBulkInitiativeMutating = mutations.bulkEntityMutation.isPending;
  const runtimeActivityByInitiativeId = useMemo(() => {
    const map = new Map<
      string,
      {
        activeCount: number;
        totalCount: number;
        lastHeartbeatAt: string | null;
        lastHeartbeatMs: number;
      }
    >();

    for (const runtime of runtimeInstances) {
      const initiativeId = runtime.initiativeId?.trim();
      if (!initiativeId) continue;

      const existing = map.get(initiativeId) ?? {
        activeCount: 0,
        totalCount: 0,
        lastHeartbeatAt: null,
        lastHeartbeatMs: 0,
      };

      existing.totalCount += 1;
      if (runtime.state === 'active') {
        existing.activeCount += 1;
      }

      const heartbeatAt = runtime.lastHeartbeatAt ?? runtime.lastEventAt ?? null;
      const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
      if (Number.isFinite(heartbeatMs) && heartbeatMs > existing.lastHeartbeatMs) {
        existing.lastHeartbeatMs = heartbeatMs;
        existing.lastHeartbeatAt = new Date(heartbeatMs).toISOString();
      }

      map.set(initiativeId, existing);
    }

    const normalized = new Map<
      string,
      { activeCount: number; totalCount: number; lastHeartbeatAt: string | null }
    >();
    for (const [initiativeId, aggregate] of map.entries()) {
      normalized.set(initiativeId, {
        activeCount: aggregate.activeCount,
        totalCount: aggregate.totalCount,
        lastHeartbeatAt: aggregate.lastHeartbeatAt,
      });
    }
    return normalized;
  }, [runtimeInstances]);

  const groups = useMemo(
    () => (groupBy !== 'none' ? groupInitiatives(pagedInitiatives, groupBy) : null),
    [groupBy, pagedInitiatives],
  );

  const groupIds = useMemo(
    () =>
      groups?.map((group) => groupDisclosureId(groupBy, group.key)) ?? [],
    [groupBy, groups],
  );

  const flatVisibleInitiativeIds = useMemo(() => {
    if (!groups) return pagedInitiatives.map((initiative) => initiative.id);
    const ids: string[] = [];
    for (const group of groups) {
      const disclosureId = groupDisclosureId(groupBy, group.key);
      if (expandedGroupIds.has(disclosureId)) {
        for (const initiative of group.initiatives) {
          ids.push(initiative.id);
        }
      }
    }
    return ids;
  }, [expandedGroupIds, groupBy, groups, pagedInitiatives]);

  const { handleSelect: handleInitiativeRangeSelect } = useRangeSelection(flatVisibleInitiativeIds);

  const toggleGroupExpanded = useCallback((id: string) => {
    setExpandedGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!groups || groups.length === 0) {
      setExpandedGroupIds((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }

    const validIds = new Set(groups.map((group) => groupDisclosureId(groupBy, group.key)));
    setExpandedGroupIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => validIds.has(id)));
      if (next.size === 0) {
        next.add(groupDisclosureId(groupBy, groups[0].key));
      }
      return isSameSet(next, previous) ? previous : next;
    });
  }, [groupBy, groups]);

  useEffect(() => {
    setSelectedInitiativeIds((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(Array.from(previous).filter((id) => filteredInitiativeIds.has(id)));
      return isSameSet(next, previous) ? previous : next;
    });
  }, [filteredInitiativeIds]);

  useEffect(() => {
    if (initialInitiativeId && !didAutoExpand.current && !isLoading && initiatives.length > 0) {
      const targetIndex = sortedInitiatives.findIndex((initiative) => initiative.id === initialInitiativeId);
      if (targetIndex >= 0) {
        setPageIndex(Math.floor(targetIndex / pageSize));
      }
      expandInitiative(initialInitiativeId);
      if (groups) {
        const matchingGroup = groups.find((group) =>
          group.initiatives.some((initiative) => initiative.id === initialInitiativeId),
        );
        if (matchingGroup) {
          const id = groupDisclosureId(groupBy, matchingGroup.key);
          setExpandedGroupIds((previous) => {
            if (previous.has(id)) return previous;
            const next = new Set(previous);
            next.add(id);
            return next;
          });
        }
      }
      didAutoExpand.current = true;
      requestAnimationFrame(() => {
        const el = document.getElementById(`initiative-${initialInitiativeId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [
    initialInitiativeId,
    isLoading,
    initiatives.length,
    expandInitiative,
    pageSize,
    groupBy,
    groups,
    sortedInitiatives,
  ]);

  useEffect(() => {
    if (selectedInitiativeCount === 0 && confirmBulkInitiativeDelete) {
      setConfirmBulkInitiativeDelete(false);
    }
  }, [confirmBulkInitiativeDelete, selectedInitiativeCount]);

  useEffect(() => {
    setPageIndex((previous) => Math.min(previous, Math.max(totalPages - 1, 0)));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [searchQuery, statusFilters, dateField, datePreset, dateStart, dateEnd, groupBy, sortBy, pageSize]);

  const allExpanded =
    pagedInitiatives.length > 0 &&
    pagedInitiatives.every((initiative) => expandedInitiatives.has(initiative.id));
  const focusedInitiativeId = useMemo(() => {
    if (modalTarget) {
      return modalTarget.type === 'initiative'
        ? modalTarget.entity.id
        : modalTarget.initiative.id;
    }
    if (selectedInitiativeIds.size === 1) {
      return Array.from(selectedInitiativeIds)[0] ?? null;
    }
    if (expandedInitiatives.size === 1) {
      return Array.from(expandedInitiatives)[0] ?? null;
    }
    if (initialInitiativeId) return initialInitiativeId;
    return null;
  }, [expandedInitiatives, initialInitiativeId, modalTarget, selectedInitiativeIds]);
  const fallbackNextActionInitiative = useMemo(() => {
    if (!focusedInitiativeId) return null;
    return (
      sortedInitiatives.find((initiative) => initiative.id === focusedInitiativeId) ?? null
    );
  }, [focusedInitiativeId, sortedInitiatives]);
  const internalNextActionQueue = useNextUpQueue({
    projectId: workspaceInitiativeId,
    limit: 40,
    authToken,
    embedMode,
    enabled: nextUpQueueModel ? false : initiatives.length > 0,
    snapshotVersion,
  });
  const nextActionQueue = nextUpQueueModel ?? internalNextActionQueue;
  const usageControlPlane = useUsageControlPlane({ authToken, embedMode, enabled: initiatives.length > 0 });
  const initiativeSummary = useInitiativeSummary({
    enabled: initiatives.length > 0,
    projectId: workspaceInitiativeId,
  });
  const healthData = useMemo(() => {
    if (initiativeSummary.data?.aggregate) {
      const agg = initiativeSummary.data.aggregate;
      return {
        completionPercent: agg.completionPercent,
        totalTasks: agg.totalTasks,
        doneTasks: agg.doneTasks,
        blockedCount: agg.blockedCount,
        activeAgents: agg.activeAgents,
      };
    }
    // Only derive task totals from explicit task collections. If task detail is
    // unavailable, show 0/0 instead of mislabeling workstream counts as tasks.
    const seenTaskIds = new Set<string>();
    let totalTasks = 0;
    let doneTasks = 0;
    let blockedCount = 0;

    const normalizeTaskText = (value: unknown): string => {
      if (typeof value !== 'string') return '';
      return value.trim().toLowerCase().replace(/\s+/g, ' ');
    };

    const taskSemanticKey = (
      task: Record<string, unknown>,
      context: {
        initiativeId: string;
        workstreamId: string;
        milestoneId?: string | null;
      }
    ): string => {
      const explicitId = typeof task.id === 'string' && task.id.trim().length > 0 ? task.id.trim() : '';
      if (explicitId) return explicitId;
      const title = normalizeTaskText(task.title ?? task.name ?? null);
      const description = normalizeTaskText(task.description ?? task.summary ?? null);
      const milestoneId =
        typeof task.milestoneId === 'string' && task.milestoneId.trim().length > 0
          ? task.milestoneId.trim()
          : typeof task.milestone_id === 'string' && task.milestone_id.trim().length > 0
            ? task.milestone_id.trim()
            : context.milestoneId?.trim() ?? 'none';
      return [
        context.initiativeId,
        context.workstreamId,
        milestoneId,
        title || 'untitled',
        description || 'no-description',
      ].join(':');
    };

    const countTask = (
      task: Record<string, unknown>,
      context: {
        initiativeId: string;
        workstreamId: string;
        milestoneId?: string | null;
      }
    ) => {
      const rawId = taskSemanticKey(task, context);
      if (seenTaskIds.has(rawId)) return;
      seenTaskIds.add(rawId);
      totalTasks += 1;
      if (isDoneTaskStatus(String(task.status ?? ''))) {
        doneTasks += 1;
      }
      if (String(task.status ?? '').trim().toLowerCase() === 'blocked') {
        blockedCount += 1;
      }
    };

    for (const initiative of initiatives) {
      if (initiative.status === 'blocked') {
        blockedCount += 1;
      }
      for (const workstream of (initiative.workstreams ?? []) as Array<Record<string, unknown>>) {
        if (String(workstream.status ?? '').trim().toLowerCase() === 'blocked') {
          blockedCount += 1;
        }
        const milestones = Array.isArray(workstream.milestones)
          ? (workstream.milestones as Array<Record<string, unknown>>)
          : [];
        const initiativeId = initiative.id;
        const workstreamId =
          typeof workstream.id === 'string' && workstream.id.trim().length > 0
            ? workstream.id.trim()
            : 'workstream';
        const milestoneTaskKeys = new Set<string>();
        for (const milestone of milestones) {
          if (String(milestone.status ?? '').trim().toLowerCase() === 'blocked') {
            blockedCount += 1;
          }
          const milestoneTasks = Array.isArray(milestone.tasks)
            ? (milestone.tasks as Array<Record<string, unknown>>)
            : [];
          const milestoneId =
            typeof milestone.id === 'string' && milestone.id.trim().length > 0
              ? milestone.id.trim()
              : 'milestone';
          milestoneTasks.forEach((task) => {
            const key = taskSemanticKey(task, {
              initiativeId,
              workstreamId,
              milestoneId,
            });
            milestoneTaskKeys.add(key);
            countTask(task, { initiativeId, workstreamId, milestoneId });
          });
        }
        const workstreamTasks = Array.isArray(workstream.tasks)
          ? (workstream.tasks as Array<Record<string, unknown>>)
          : [];
        workstreamTasks.forEach((task) => {
          const key = taskSemanticKey(task, { initiativeId, workstreamId });
          if (milestoneTaskKeys.has(key)) return;
          countTask(task, { initiativeId, workstreamId });
        });
      }
    }
    const completionPercent =
      totalTasks > 0
        ? (doneTasks / totalTasks) * 100
        : initiatives.length > 0
          ? initiatives.reduce((sum, init) => sum + Math.max(0, init.health), 0) / initiatives.length
          : 0;
    const activeAgents = initiatives.reduce((sum, init) => sum + init.activeAgents, 0);
    return { completionPercent, totalTasks, doneTasks, blockedCount, activeAgents };
  }, [initiatives, initiativeSummary.data]);
  const internalNextUpActions = useNextUpQueueActions({
    authToken,
    embedMode,
    projectId: workspaceInitiativeId,
  });
  const nextUpActions = nextUpActionsModel ?? internalNextUpActions;
  const nextActionQueueItem = nextActionQueue.items[0] ?? null;
  const nowWorkingItem = useMemo(
    () =>
      nextActionQueue.items.find(
        (item) => item.playbackState === 'running' || item.playbackState === 'blocked'
      ) ??
      nextActionQueue.items.find(
        (item) => item.queueState === 'running' || item.queueState === 'blocked'
      ) ??
      null,
    [nextActionQueue.items]
  );
  const nextQueuedItem = useMemo(
    () =>
      nextActionQueue.items.find((item) => {
        if (nowWorkingItem && item.initiativeId === nowWorkingItem.initiativeId && item.workstreamId === nowWorkingItem.workstreamId) {
          return false;
        }
        return item.playbackState === 'queued' || item.playbackState === 'idle' || item.queueState === 'queued' || item.queueState === 'idle';
      }) ?? null,
    [nextActionQueue.items, nowWorkingItem]
  );
  const nextActionInitiative = useMemo(() => {
    if (!nextActionQueueItem) return fallbackNextActionInitiative;
    return (
      initiatives.find((initiative) => initiative.id === nextActionQueueItem.initiativeId) ??
      fallbackNextActionInitiative
    );
  }, [fallbackNextActionInitiative, initiatives, nextActionQueueItem]);
  const railFocusItem = nowWorkingItem ?? nextQueuedItem ?? nextActionQueueItem ?? null;
  const queueAutopilotItem = useMemo(
    () =>
      nextActionQueue.items.find(
        (item) =>
          item.autoContinue?.status === 'running' ||
          item.autoContinue?.status === 'stopping'
      ) ??
      nextActionQueue.items.find(
        (item) =>
          item.autoContinue?.stopReason === 'blocked' ||
          item.autoContinue?.stopReason === 'error'
      ) ??
      null,
    [nextActionQueue.items]
  );
  const autopilotInitiativeId =
    queueAutopilotItem?.initiativeId ?? railFocusItem?.initiativeId ?? nextActionInitiative?.id ?? null;
  const autopilotInitiative = useMemo(() => {
    if (!autopilotInitiativeId) return nextActionInitiative ?? null;
    return (
      initiatives.find((initiative) => initiative.id === autopilotInitiativeId) ??
      nextActionInitiative ??
      null
    );
  }, [autopilotInitiativeId, initiatives, nextActionInitiative]);

  const setInitiativeSelected = useCallback(
    (initiativeId: string, selected: boolean, shiftKey: boolean) => {
      setBulkInitiativeNotice(null);
      setConfirmBulkInitiativeDelete(false);
      handleInitiativeRangeSelect(initiativeId, selected, shiftKey, setSelectedInitiativeIds);
    },
    [handleInitiativeRangeSelect]
  );

  const toggleSelectAllVisibleInitiatives = useCallback(() => {
    setBulkInitiativeNotice(null);
    setConfirmBulkInitiativeDelete(false);
    setSelectedInitiativeIds((previous) => {
      if (pagedInitiatives.length === 0) return previous;
      const next = new Set(previous);
      if (allVisibleSelected) {
        for (const initiative of pagedInitiatives) {
          next.delete(initiative.id);
        }
      } else {
        for (const initiative of pagedInitiatives) {
          next.add(initiative.id);
        }
      }
      return next;
    });
  }, [allVisibleSelected, pagedInitiatives]);

  const clearInitiativeSelection = useCallback(() => {
    setConfirmBulkInitiativeDelete(false);
    setSelectedInitiativeIds(new Set());
  }, []);

  const canPageBackward = currentPageIndex > 0;
  const canPageForward = currentPageIndex < totalPages - 1;

  const jumpToPage = useCallback(
    (nextIndex: number) => {
      setPageIndex(Math.max(0, Math.min(nextIndex, totalPages - 1)));
    },
    [totalPages]
  );

  const goToFirstPage = useCallback(() => {
    jumpToPage(0);
  }, [jumpToPage]);

  const goToPreviousPage = useCallback(() => {
    jumpToPage(currentPageIndex - 1);
  }, [currentPageIndex, jumpToPage]);

  const goToNextPage = useCallback(() => {
    jumpToPage(currentPageIndex + 1);
  }, [currentPageIndex, jumpToPage]);

  const goToLastPage = useCallback(() => {
    jumpToPage(totalPages - 1);
  }, [jumpToPage, totalPages]);

  const runBulkInitiativeStatusUpdate = useCallback(
    async (status: Initiative['status']) => {
      if (selectedFilteredInitiatives.length === 0) return;
      setConfirmBulkInitiativeDelete(false);
      setBulkInitiativeNotice(null);

      try {
        const result = await mutations.bulkEntityMutation.mutateAsync({
          items: selectedFilteredInitiatives.map((initiative) => ({
            type: 'initiative',
            id: initiative.id,
          })),
          mode: 'update',
          updates: { status },
        });

        if (result.failed > 0) {
          setBulkInitiativeNotice({
            tone: 'error',
            message: `Updated ${result.updated}, failed ${result.failed}.`,
          });
        } else {
          setBulkInitiativeNotice({
            tone: 'success',
            message: `Updated ${result.updated} initiative${result.updated === 1 ? '' : 's'} to ${status}.`,
          });
        }
      } catch (error) {
        setBulkInitiativeNotice({
          tone: 'error',
          message: formatMissionControlError(
            error instanceof Error ? error.message : '',
            'Bulk initiative update failed.'
          ),
        });
      }
    },
    [mutations.bulkEntityMutation, selectedFilteredInitiatives]
  );

  const runBulkInitiativeDelete = useCallback(async () => {
    if (selectedFilteredInitiatives.length === 0) return;
    setBulkInitiativeNotice(null);

    try {
      const result = await mutations.bulkEntityMutation.mutateAsync({
        items: selectedFilteredInitiatives.map((initiative) => ({
          type: 'initiative',
          id: initiative.id,
        })),
        mode: 'delete',
      });

      if (result.failed > 0) {
        setBulkInitiativeNotice({
          tone: 'error',
          message: `Deleted ${result.updated}, failed ${result.failed}.`,
        });
      } else {
        setBulkInitiativeNotice({
          tone: 'success',
          message: `Deleted ${result.updated} initiative${result.updated === 1 ? '' : 's'}.`,
        });
        setSelectedInitiativeIds(new Set());
        setConfirmBulkInitiativeDelete(false);
      }
    } catch (error) {
      setBulkInitiativeNotice({
        tone: 'error',
        message: formatMissionControlError(
          error instanceof Error ? error.message : '',
          'Bulk initiative delete failed.'
        ),
      });
    }
  }, [mutations.bulkEntityMutation, selectedFilteredInitiatives]);

  const cancelExpandWave = useCallback(() => {
    expandWaveTokenRef.current += 1;
    setIsExpandWaveActive(false);
  }, []);

  const expandAllProgressive = useCallback(
    (initiativeIds: string[]) => {
      if (initiativeIds.length === 0) {
        cancelExpandWave();
        return;
      }

      const batchSize = 1;
      const token = expandWaveTokenRef.current + 1;
      expandWaveTokenRef.current = token;
      setIsExpandWaveActive(true);

      const step = (count: number) => {
        if (expandWaveTokenRef.current !== token) return;
        expandAll(initiativeIds.slice(0, count));
        if (count >= initiativeIds.length) {
          setIsExpandWaveActive(false);
          return;
        }
        requestAnimationFrame(() => step(Math.min(initiativeIds.length, count + batchSize)));
      };

      step(Math.min(batchSize, initiativeIds.length));
    },
    [cancelExpandWave, expandAll]
  );
  const autopilot = useAutoContinue({
    initiativeId: autopilotInitiativeId,
    projectId: workspaceInitiativeId,
    authToken,
    embedMode,
    enabled: Boolean(autopilotInitiativeId),
  });
  const [autopilotUpgradeGate, setAutopilotUpgradeGate] =
    useState<UpgradeRequiredError | null>(null);
  const autopilotRun = autopilot.run;
  const autopilotError = autopilot.error?.toLowerCase() ?? '';
  const autopilotUnavailable =
    !autopilotInitiativeId ||
    autopilotError.includes('404') ||
    autopilotError.includes('400') ||
    autopilotError.includes('not found');
  const nextActionRuntime =
    autopilotInitiativeId ? runtimeActivityByInitiativeId.get(autopilotInitiativeId) ?? null : null;
  const hasActiveRuntime = (nextActionRuntime?.activeCount ?? 0) > 0;
  const hasRuntimePresence = (nextActionRuntime?.totalCount ?? 0) > 0;
  const autopilotStateLabel = autopilotUpgradeGate
    ? `Upgrade required · ${formatPlanLabel(autopilotUpgradeGate.currentPlan)} → ${formatPlanLabel(
        autopilotUpgradeGate.requiredPlan
      )}`
    : !autopilotInitiativeId
      ? 'No target'
      : autopilot.isRunning
        ? hasActiveRuntime
          ? `Running · ${nextActionRuntime?.activeCount ?? 0} live`
          : hasRuntimePresence
            ? `Enabled · ${nextActionRuntime?.totalCount ?? 0} idle`
            : 'Enabled · waiting'
        : autopilotRun?.stopReason
          ? `Idle · ${autopilotRun.stopReason.replace(/_/g, ' ')}`
          : 'Idle';
  const autopilotNeedsUpgrade = Boolean(autopilotUpgradeGate) && !autopilot.isRunning;
  const autopilotTone = autopilotNeedsUpgrade ? 'amber' : 'teal';
  const installOrgxHref = useMemo(() => {
    const url = new URL('https://www.useorgx.com/integrations/openclaw');
    url.searchParams.set('utm_source', embedMode ? 'live_share' : 'orgx_openclaw_plugin');
    url.searchParams.set('utm_medium', 'mission_control');
    url.searchParams.set('utm_campaign', 'live_link_dashboard');
    url.searchParams.set('utm_content', 'install_cta');
    return url.toString();
  }, [embedMode]);

  useEffect(() => {
    setAutopilotUpgradeGate(null);
  }, [autopilotInitiativeId]);

  useEffect(() => {
    const element = stickyToolbarRef.current;
    if (!element) return;

    const update = () => {
      setStickyToolbarOffset(Math.max(64, element.offsetHeight));
    };

    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    return () => observer.disconnect();
  }, [autopilotStateLabel, connection, error, isLoading, sortedInitiatives.length]);

  const hasConnectivityIssue = Boolean(
    !isLoading &&
      hasApiKey &&
      (connection === 'disconnected' || error)
  );
  const hintTone: 'critical' | 'info' = connection === 'disconnected' || Boolean(error) ? 'critical' : 'info';
  const hintLabel =
    connection === 'disconnected'
      ? 'Offline'
      : error
        ? 'Live degraded'
        : 'Connected';
  const hintDetail = error
    ? formatLiveIssueDetail(error)
    : connection === 'disconnected'
      ? 'Live updates are offline. Data may be stale until reconnect.'
      : `Last snapshot ${formatLocalTimestamp(lastSnapshotAt)}`;

  useEffect(() => {
    if (!hasConnectivityIssue) {
      setConnectivityToastDismissed(false);
    }
  }, [hasConnectivityIssue]);
  const openInitiativeFromNextUp = useCallback(
    (initiativeId: string, initiativeTitle?: string) => {
      const target = initiatives.find((initiative) => initiative.id === initiativeId);
      if (!target) {
        const readableTitle = (initiativeTitle ?? '').trim();
        const label = readableTitle
          ? isOpaqueId(readableTitle)
            ? `Initiative ${humanizeId(readableTitle)}`
            : sanitizeDisplayText(readableTitle)
          : 'This initiative';
        setNextActionNotice({
          tone: 'error',
          message: `${label} is not in this workspace view. Switch workspace or clear filters to find it.`,
        });
        return false;
      }

      setNextActionNotice(null);

      const targetSortedIndex = sortedInitiatives.findIndex((initiative) => initiative.id === initiativeId);
      const shouldResetFilters = targetSortedIndex < 0;
      if (targetSortedIndex >= 0) {
        setPageIndex(Math.floor(targetSortedIndex / pageSize));
      }
      if (shouldResetFilters) {
        // Reveal hidden initiatives before scrolling so "Open initiative" always resolves.
        setSearchQuery('');
        setStatusFilters([]);
        setDateField('target');
        setDatePreset('any');
        setDateStart('');
        setDateEnd('');
      }

      expandInitiative(initiativeId);

      if (groupBy !== 'none') {
        const groupedSource = targetSortedIndex >= 0 ? sortedInitiatives : initiatives;
        const grouped = groupInitiatives(groupedSource, groupBy);
        const containingGroup = grouped.find((group) =>
          group.initiatives.some((initiative) => initiative.id === initiativeId),
        );
        if (containingGroup) {
          const disclosureId = groupDisclosureId(groupBy, containingGroup.key);
          setExpandedGroupIds((previous) => {
            if (previous.has(disclosureId)) return previous;
            const next = new Set(previous);
            next.add(disclosureId);
            return next;
          });
        }
      }

      const scrollToInitiative = (attempt = 0) => {
        const element = document.getElementById(`initiative-${initiativeId}`);
        if (element) {
          element.scrollIntoView({
            behavior: attempt === 0 ? 'smooth' : 'auto',
            block: 'start',
          });
          const topThreshold = Math.max(72, stickyToolbarOffset) + 8;
          const rect = element.getBoundingClientRect();
          const inViewportBand =
            rect.top >= topThreshold && rect.top <= window.innerHeight - 72;
          if (!inViewportBand && attempt < 18) {
            window.setTimeout(() => scrollToInitiative(attempt + 1), 90);
          }
          return;
        }
        if (attempt >= 60) return;
        requestAnimationFrame(() => scrollToInitiative(attempt + 1));
      };

      const kickoffScroll = () => requestAnimationFrame(() => scrollToInitiative());
      if (shouldResetFilters) {
        window.setTimeout(kickoffScroll, 90);
      } else {
        kickoffScroll();
      }

      return true;
    },
    [
      initiatives,
      pageSize,
      setNextActionNotice,
      setPageIndex,
      setSearchQuery,
      setStatusFilters,
      setDateField,
      setDatePreset,
      setDateStart,
      setDateEnd,
      expandInitiative,
      groupBy,
      sortedInitiatives,
      stickyToolbarOffset,
    ]
  );
  const startInitiativeFromNextAction = useCallback(() => {
    if (!nextActionInitiative) return;

    setNextActionNotice(null);
    void mutations.updateEntity
      .mutateAsync({
        type: 'initiative',
        id: nextActionInitiative.id,
        status: 'active',
      })
      .then(() => {
        setNextActionNotice({
          tone: 'success',
          message: `Started ${nextActionInitiative.name}.`,
        });
        openInitiativeFromNextUp(nextActionInitiative.id, nextActionInitiative.name);
      })
      .catch((err) => {
        setNextActionNotice({
          tone: 'error',
          message: formatMissionControlError(
            err instanceof Error ? err.message : '',
            'Failed to start initiative.'
          ),
        });
      });
  }, [mutations.updateEntity, nextActionInitiative, openInitiativeFromNextUp]);
  const runRailAction = useCallback(
    async (
      key: 'start' | 'pause' | 'defer' | 'auto',
      action: () => Promise<unknown>,
      successMessage: string
    ) => {
      setRailActionKey(key);
      setNextActionNotice(null);
      try {
        await action();
        setNextActionNotice({
          tone: 'success',
          message: successMessage,
        });
      } catch (error) {
        setNextActionNotice({
          tone: 'error',
          message: formatMissionControlError(
            error instanceof Error ? error.message : '',
            'Action failed.'
          ),
        });
      } finally {
        setRailActionKey(null);
      }
    },
    []
  );
  const startWorkstreamWithConflictHandling = useCallback(
    async (
      item: NextUpQueueItem,
      options?: { surface?: 'rail' | 'card' }
    ) => {
      const reportToRail = options?.surface !== 'card';
      if (reportToRail) {
        setRailActionKey('start');
        setNextActionNotice(null);
      }
      setPlayConflict(null);
      try {
        const result = await nextActionQueue.playWorkstream({
          initiativeId: item.initiativeId,
          workstreamId: item.workstreamId,
          agentId: item.runnerAgentId,
        });
        if (reportToRail) {
          setNextActionNotice({
            tone: 'success',
            message: `Started ${item.workstreamTitle}.`,
          });
        }
        return result;
      } catch (error) {
        if (
          isMissionControlApiError(error) &&
          error.code === 'auto_continue_already_running'
        ) {
          const details = error.details;
          const activeWorkstreamTitle =
            details && typeof details.activeWorkstreamTitle === 'string'
              ? details.activeWorkstreamTitle
              : null;
          const activeWorkstreamId =
            details && typeof details.activeWorkstreamId === 'string'
              ? details.activeWorkstreamId
              : null;
          setPlayConflict({
            target: item,
            message:
              error.message ||
              'A workstream is already running. Stop it before starting another.',
            activeWorkstreamTitle,
            activeWorkstreamId,
          });
          if (!reportToRail) {
            throw error;
          }
          return null;
        }

        if (reportToRail) {
          setNextActionNotice({
            tone: 'error',
            message: formatMissionControlError(
              error instanceof Error ? error.message : '',
              'Unable to start workstream.'
            ),
          });
          return null;
        }
        throw error;
      } finally {
        if (reportToRail) {
          setRailActionKey(null);
        }
      }
    },
    [nextActionQueue]
  );
  const pauseNowWorking = useCallback(() => {
    if (!nowWorkingItem) return Promise.resolve();
    return runRailAction(
      'pause',
      () =>
        nextUpActions.stopTriage({
          initiativeId: nowWorkingItem.initiativeId,
          workstreamId: nowWorkingItem.workstreamId,
          placement: 'bottom',
          resetToTodo: false,
        }),
      `Paused ${nowWorkingItem.workstreamTitle} and moved it to bottom of queue.`
    );
  }, [nextUpActions, nowWorkingItem, runRailAction]);
  const deferNowWorking = useCallback(() => {
    if (!nowWorkingItem) return Promise.resolve();
    const isRunningLike =
      nowWorkingItem.playbackState === 'running' ||
      nowWorkingItem.playbackState === 'blocked' ||
      nowWorkingItem.queueState === 'running' ||
      nowWorkingItem.queueState === 'blocked';
    return runRailAction(
      'defer',
      () =>
        isRunningLike
          ? nextUpActions.stopTriage({
              initiativeId: nowWorkingItem.initiativeId,
              workstreamId: nowWorkingItem.workstreamId,
              placement: 'bottom',
              resetToTodo: false,
            })
          : nextUpActions.move({
              initiativeId: nowWorkingItem.initiativeId,
              workstreamId: nowWorkingItem.workstreamId,
              placement: 'bottom',
            }),
      `Deferred ${nowWorkingItem.workstreamTitle} to bottom of queue.`
    );
  }, [nextUpActions, nowWorkingItem, runRailAction]);
  const toggleRailAutoContinue = useCallback(() => {
    const target = nowWorkingItem ?? nextQueuedItem ?? nextActionQueueItem;
    if (!target) return Promise.resolve();
    const autoEnabled =
      target.autoIntentEnabled === true &&
      (target.autoRuntimeState === 'running' || target.autoRuntimeState === 'stopping');
    if (!autoEnabled) {
      setAutoEnableTarget(target);
      return Promise.resolve();
    }
    return runRailAction(
      'auto',
      () =>
        nextActionQueue.stopInitiativeAutoContinue({ initiativeId: target.initiativeId }),
      `Stopped auto-continue for ${target.initiativeTitle}.`
    );
  }, [nextActionQueue, nextActionQueueItem, nextQueuedItem, nowWorkingItem, runRailAction]);
  const confirmAutoEnable = useCallback(() => {
    if (!autoEnableTarget) return;
    const target = autoEnableTarget;
    setAutoEnableTarget(null);
    void runRailAction(
      'auto',
      () =>
        nextActionQueue.startWorkstreamAutoContinue({
          initiativeId: target.initiativeId,
          workstreamId: target.workstreamId,
          agentId: target.runnerAgentId,
          scope: 'initiative',
        }),
      `Auto-continue enabled for ${target.initiativeTitle}; starting with ${target.workstreamTitle}.`
    );
  }, [autoEnableTarget, nextActionQueue, runRailAction]);
  const switchToConflictTarget = useCallback(async () => {
    if (!playConflict || isSwitchingRun) return;
    setIsSwitchingRun(true);
    setNextActionNotice(null);
    try {
      try {
        await nextActionQueue.stopInitiativeAutoContinue({
          initiativeId: playConflict.target.initiativeId,
        });
      } catch (error) {
        if (!isMissionControlApiError(error) || error.status !== 404) {
          throw error;
        }
      }

      await nextActionQueue.playWorkstream({
        initiativeId: playConflict.target.initiativeId,
        workstreamId: playConflict.target.workstreamId,
        agentId: playConflict.target.runnerAgentId,
      });
      setPlayConflict(null);
      setNextActionNotice({
        tone: 'success',
        message: `Switched run to ${playConflict.target.workstreamTitle}.`,
      });
    } catch (error) {
      setNextActionNotice({
        tone: 'error',
        message: formatMissionControlError(
          error instanceof Error ? error.message : '',
          'Unable to switch run.'
        ),
      });
    } finally {
      setIsSwitchingRun(false);
    }
  }, [isSwitchingRun, nextActionQueue, playConflict]);
  const openNextActionInitiative = useCallback(() => {
    if (!nextActionInitiative) return;
    openInitiativeFromNextUp(nextActionInitiative.id, nextActionInitiative.name);
    if (typeof window !== 'undefined' && window.innerWidth >= 1280) {
      setNextUpRailOpen(true);
    }
  }, [nextActionInitiative, openInitiativeFromNextUp]);
  const toggleNextUpSurface = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (window.innerWidth >= 1280) {
      const next = !nextUpRailOpen;
      setNextUpDrawerOpen(false);
      setNextUpRailOpen(next);
      setNextActionNotice({
        tone: 'success',
        message: next ? 'Opened queue rail.' : 'Closed queue rail.',
      });
      return;
    }

    const next = !nextUpDrawerOpen;
    setNextUpRailOpen(false);
    setNextUpDrawerOpen(next);
    setNextActionNotice({
      tone: 'success',
      message: next ? 'Opened queue panel.' : 'Closed queue panel.',
    });
  }, [nextUpDrawerOpen, nextUpRailOpen]);

  const nextActionStatusKey = toStatusKey(
    nextActionInitiative?.rawStatus ?? nextActionInitiative?.status ?? null
  );
  const nextActionStartableStatuses = useMemo(
    () => new Set(['paused', 'draft', 'planned', 'todo', 'backlog', 'queued']),
    []
  );
  const nextActionMode = useMemo(() => {
    if (!nextActionInitiative) return 'none' as const;
    if (nowWorkingItem?.queueState === 'running' || nowWorkingItem?.playbackState === 'running') {
      return 'running' as const;
    }
    if (
      nextActionQueueItem?.autoIntentEnabled === true &&
      (nextActionQueueItem.autoRuntimeState === 'running' ||
        nextActionQueueItem.autoRuntimeState === 'stopping')
    ) {
      return 'running' as const;
    }
    if (
      nextActionQueueItem?.queueState === 'blocked' ||
      nextActionInitiative.status === 'blocked'
    ) {
      return 'blocked' as const;
    }
    if (nextActionQueueItem) return 'queued' as const;
    if (nextActionStartableStatuses.has(nextActionStatusKey)) return 'startable' as const;
    if (nextActionStatusKey === 'completed' || nextActionStatusKey === 'done') {
      return 'completed' as const;
    }
    return 'active_no_queue' as const;
  }, [
    nextActionInitiative,
    nextActionQueueItem,
    nextActionStartableStatuses,
    nextActionStatusKey,
    nowWorkingItem,
  ]);
  const nextActionSummary = useMemo(() => {
    if (!nextActionInitiative) {
      return {
        headline: 'No initiative selected',
        detail: 'Create or select an initiative to queue work.',
      };
    }

    if (nextActionMode === 'running' && nextActionQueueItem) {
      return {
        headline: `${nextActionQueueItem.workstreamTitle} is running`,
        detail: `Runner: ${nextActionQueueItem.runnerAgentName}. Follow live updates in Activity.`,
      };
    }
    if (nextActionMode === 'queued' && nextActionQueueItem) {
      return {
        headline: nextActionQueueItem.workstreamTitle,
        detail: `Ready to dispatch${nextActionQueueItem.nextTaskTitle ? ` · ${nextActionQueueItem.nextTaskTitle}` : ''}.`,
      };
    }
    if (nextActionMode === 'startable') {
      const isPaused = nextActionStatusKey === 'paused';
      return {
        headline: isPaused
          ? `${nextActionInitiative.name} is paused`
          : `${nextActionInitiative.name} is ready to start`,
        detail: 'Start initiative to queue and dispatch the next workstream.',
      };
    }
    if (nextActionMode === 'blocked') {
      return {
        headline:
          nextActionQueueItem?.queueState === 'blocked'
            ? `${nextActionQueueItem.workstreamTitle} is blocked`
            : `${nextActionInitiative.name} is blocked`,
        detail:
          nextActionQueueItem?.blockReason ??
          'Resolve blockers or approvals before dispatching more work.',
      };
    }
    if (nextActionMode === 'completed') {
      return {
        headline: `${nextActionInitiative.name} is complete`,
        detail: 'Choose another active initiative or queue new workstreams.',
      };
    }
    return {
      headline: nextActionInitiative.name,
      detail: 'No queued workstream detected yet. Use Next Up to choose what runs next.',
    };
  }, [nextActionInitiative, nextActionMode, nextActionQueueItem, nextActionStatusKey]);
  const nextActionBusy =
    nextActionQueue.isPlaying ||
    nextActionQueue.isStartingAutoContinue ||
    nextActionQueue.isStoppingAutoContinue ||
    isSwitchingRun ||
    mutations.updateEntity.isPending;
  const nextActionFallbackLabel = useMemo(() => {
    if (nextActionMode === 'blocked') return 'Review blockers';
    if (nextActionMode === 'active_no_queue') return 'Open and queue work';
    if (nextActionMode === 'completed') return 'Review initiative';
    return 'Open initiative';
  }, [nextActionMode]);
  const railMode = useMemo(() => {
    if (nowWorkingItem?.playbackState === 'running' || nowWorkingItem?.queueState === 'running') {
      return 'running' as const;
    }
    if (nowWorkingItem?.playbackState === 'blocked' || nowWorkingItem?.queueState === 'blocked') {
      return 'blocked' as const;
    }
    if (nextQueuedItem) return 'queued' as const;
    if (nextActionMode === 'startable') return 'startable' as const;
    if (nextActionMode === 'completed') return 'completed' as const;
    if (nextActionInitiative) return 'active_no_queue' as const;
    return 'none' as const;
  }, [nextActionInitiative, nextActionMode, nextQueuedItem, nowWorkingItem]);
  const nowWorkingHeadline = nowWorkingItem?.workstreamTitle ?? 'No active workstream';
  const nowWorkingInitiativeLabel =
    nowWorkingItem?.initiativeTitle ?? nextActionInitiative?.name ?? 'No initiative selected';
  const nowWorkingSubline = nowWorkingItem
    ? [
        nowWorkingItem.nextTaskTitle ? `Next: ${nowWorkingItem.nextTaskTitle}` : null,
        nowWorkingItem.blockReason ? `Blocked: ${nowWorkingItem.blockReason}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : nextQueuedItem
      ? `Next up: ${nextQueuedItem.workstreamTitle}`
      : nextActionSummary.detail;
  const nextQueuedHeadline = nextQueuedItem?.workstreamTitle ?? 'Queue is empty';
  const nextQueuedSubline = nextQueuedItem?.nextTaskTitle
    ? `Next task: ${nextQueuedItem.nextTaskTitle}`
    : 'Add or reorder workstreams in queue.';
  const railStatusLabel = nextUpModeLabel(railMode);
  const railStatusTone = nextUpModeTone(railMode);
  const railAutoTarget = nowWorkingItem ?? nextQueuedItem ?? nextActionQueueItem;
  const railAutoEnabled =
    railAutoTarget?.autoIntentEnabled === true &&
    (railAutoTarget.autoRuntimeState === 'running' || railAutoTarget.autoRuntimeState === 'stopping');
  const prefersReducedMotion = useReducedMotion();
  const nextUpRailLayoutId = 'next-up-surface';
  const nextUpMorphTransition = useMemo(
    () => (prefersReducedMotion ? { duration: 0.01 } : missionControlMotion.railMorphSpring),
    [prefersReducedMotion]
  );
  const nextUpSurfaceTransition = useMemo(
    () => (prefersReducedMotion ? { duration: 0.01 } : missionControlMotion.surfaceSwitch),
    [prefersReducedMotion]
  );
  const railContentTransition = useMemo(
    () =>
      prefersReducedMotion
        ? {
            initial: { opacity: 1, y: 0 },
            animate: { opacity: 1, y: 0 },
            exit: { opacity: 1, y: 0 },
            transition: { duration: 0.01 },
          }
        : missionControlMotion.contentCrossFade,
    [prefersReducedMotion]
  );
  const nextUpInlineShellTone = useMemo(
    () => ({
      // Match the selection bar shell so the inline Next Up surface reads as "docked",
      // not like a competing card.
      backgroundColor: 'rgba(10, 14, 21, 0.66)',
      borderColor: 'rgba(255, 255, 255, 0.10)',
    }),
    []
  );
  const nextUpExpandedShellTone = useMemo(
    () => ({
      backgroundColor: 'rgba(10, 14, 21, 0.95)',
      borderColor: 'rgba(255, 255, 255, 0.11)',
    }),
    []
  );
  const resolvedModalTarget = useMemo(() => {
    if (!modalTarget) return null;
    const resolveInitiative = (id: string) =>
      initiatives.find((initiative) => initiative.id === id) ?? null;

    if (modalTarget.type === 'initiative') {
      const latest = resolveInitiative(modalTarget.entity.id);
      if (!latest) return modalTarget;
      return { ...modalTarget, entity: latest };
    }

    const latestInitiative = resolveInitiative(modalTarget.initiative.id);
    if (!latestInitiative) return modalTarget;
    return { ...modalTarget, initiative: latestInitiative };
  }, [initiatives, modalTarget]);

  useEffect(() => {
    if (!playConflict) return;
    const stillAvailable = nextActionQueue.items.some(
      (item) =>
        item.initiativeId === playConflict.target.initiativeId &&
        item.workstreamId === playConflict.target.workstreamId
    );
    if (!stillAvailable) {
      setPlayConflict(null);
    }
  }, [
    nextActionQueue.items,
    playConflict,
  ]);

  useEffect(() => {
    if (!autoEnableTarget) return;
    const stillAvailable = nextActionQueue.items.some(
      (item) =>
        item.initiativeId === autoEnableTarget.initiativeId &&
        item.workstreamId === autoEnableTarget.workstreamId
    );
    if (!stillAvailable) setAutoEnableTarget(null);
  }, [autoEnableTarget, nextActionQueue.items]);

  useEffect(() => {
    if (!modalTarget) return;
    const initiativeId =
      modalTarget.type === 'initiative' ? modalTarget.entity.id : modalTarget.initiative.id;
    const exists = initiatives.some((initiative) => initiative.id === initiativeId);
    if (!exists) closeModal();
  }, [closeModal, initiatives, modalTarget]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncByViewport = () => {
      if (window.innerWidth >= 1280) {
        setNextUpDrawerOpen(false);
      } else {
        setNextUpRailOpen(false);
      }
    };
    syncByViewport();
    window.addEventListener('resize', syncByViewport);
    return () => window.removeEventListener('resize', syncByViewport);
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="relative flex-1 min-h-0">
        {/* Scroll fade indicators */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#02040A] to-transparent z-10" />
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#02040A] to-transparent z-10" />

        <div data-mc-scroll-host="true" className="h-full overflow-y-auto overflow-x-hidden">
          <div
            className="mx-auto max-w-6xl px-4 sm:px-6"
            style={{ ['--mc-toolbar-offset' as string]: `${stickyToolbarOffset}px` }}
          >
            <LayoutGroup id="next-up-morph">
            <div
              ref={stickyToolbarRef}
              className="sticky top-0 z-40 relative -mx-4 border-b border-subtle bg-[#02040A]/78 px-4 pb-2.5 pt-3.5 backdrop-blur-xl sm:-mx-6 sm:px-6"
            >
              <div className="pointer-events-none absolute right-4 top-2.5 z-50 hidden sm:block sm:right-6">
                <InlineToast
                  open={hasConnectivityIssue && !connectivityToastDismissed}
                  tone={hintTone === 'critical' ? 'error' : 'warning'}
                  title={hintLabel}
                  message={hintDetail}
                  onDismiss={() => setConnectivityToastDismissed(true)}
                  primaryAction={
                    onRefresh
                      ? {
                          label: 'Refresh',
                          onClick: onRefresh,
                        }
                      : null
                  }
                  secondaryAction={
                    onOpenSettings
                      ? {
                          label: 'Settings',
                          onClick: onOpenSettings,
                        }
                      : null
                  }
                />
              </div>

              {hasConnectivityIssue && !connectivityToastDismissed ? (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 sm:hidden">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      hintTone === 'critical' ? 'bg-red-400' : 'bg-amber-300'
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-micro font-semibold text-white/88">{hintLabel}</p>
                    <p className="truncate text-micro text-white/56">{hintDetail}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConnectivityToastDismissed(true)}
                    className="control-pill h-7 px-2 text-micro font-semibold"
                  >
                    Hide
                  </button>
                </div>
              ) : null}

              <div className="toolbar-shell flex flex-col gap-2.5 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <SearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search initiatives..."
                  />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2.5 md:ml-auto md:flex-nowrap">
                  <MissionControlFilters
                    initiatives={initiatives}
                    visibleCount={filteredInitiatives.length}
                  />
                  <div
                    className="hidden min-w-[220px] max-w-[320px] items-center gap-2 rounded-lg border border-strong bg-white/[0.03] px-2.5 py-1.5 xl:flex"
                    title={autopilotInitiative?.name ?? undefined}
                  >
                    <span className="text-micro font-semibold uppercase tracking-[0.08em] text-white/44">
                      Autopilot
                    </span>
                    <div className="min-w-0 flex-1 text-right">
                      <div className="truncate text-micro text-white/72">{autopilotStateLabel}</div>
                      {autopilotInitiative && (
                        <div className="truncate text-micro text-white/44">
                          {autopilotInitiative.name}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (autopilotUnavailable || !autopilotInitiativeId) return;
                      if (autopilotNeedsUpgrade && autopilotUpgradeGate) {
                        void openUpgradeCheckout({
                          actions: autopilotUpgradeGate.actions,
                          requiredPlan: autopilotUpgradeGate.requiredPlan,
                        }).catch((err) => {
                          console.warn('[billing] checkout failed', err);
                          setNextActionNotice({
                            tone: 'error',
                            message: formatMissionControlError(
                              err instanceof Error ? err.message : '',
                              'Unable to open checkout right now.'
                            ),
                          });
                        });
                        return;
                      }

                      const stopRequested = autopilot.isRunning;
                      const action = stopRequested ? autopilot.stop : autopilot.start;
                      void action()
                        .then(() => {
                          setAutopilotUpgradeGate(null);
                          const initiativeLabel = autopilotInitiative?.name ?? 'selected initiative';
                          setNextActionNotice({
                            tone: 'success',
                            message: stopRequested
                              ? `Stopped Autopilot for ${initiativeLabel}.`
                              : `Started Autopilot for ${initiativeLabel}.`,
                          });
                        })
                        .catch((err) => {
                          if (err instanceof UpgradeRequiredError) {
                            setAutopilotUpgradeGate(err);
                          } else {
                            setAutopilotUpgradeGate(null);
                            console.warn('[autopilot] toggle failed', err);
                            setNextActionNotice({
                              tone: 'error',
                              message: formatMissionControlError(
                                err instanceof Error ? err.message : '',
                                'Autopilot action failed.'
                              ),
                            });
                          }
                        });
                    }}
                    disabled={
                      autopilotUnavailable ||
                      autopilot.isStarting ||
                      autopilot.isGracefullyStopping
                    }
                    title={
                      autopilotUnavailable
                        ? 'Select an initiative to run Autopilot'
                        : autopilotNeedsUpgrade
                          ? 'Upgrade to enable auto-continue for BYOK agents'
                          : autopilot.isRunning
                            ? 'Stop Autopilot'
                            : `Start Autopilot${autopilotInitiative ? ` for ${autopilotInitiative.name}` : ''}`
                    }
                    data-state={
                      autopilot.isRunning || autopilotNeedsUpgrade ? 'active' : 'idle'
                    }
                    data-tone={autopilotTone}
                    className="control-pill flex items-center gap-1.5 px-3 text-caption font-semibold disabled:opacity-40"
                  >
                    {autopilotNeedsUpgrade ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 5v14" />
                        <path d="M18 11l-6-6-6 6" />
                      </svg>
                    ) : autopilot.isRunning ? (
                      hasActiveRuntime ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          className="status-breathe"
                        >
                          <rect x="7" y="7" width="10" height="10" rx="2" />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="12" cy="12" r="8" />
                          <path d="M12 8v4l3 2" />
                        </svg>
                      )
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                    <span>
                      {autopilotNeedsUpgrade
                        ? 'Upgrade Autopilot'
                        : autopilot.isGracefullyStopping
                          ? 'Stopping Autopilot…'
                          : `${autopilot.isRunning ? 'Stop' : 'Start'} Autopilot`}
                    </span>
                    {autopilot.isRunning && hasActiveRuntime && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0AD4C4] status-breathe" />
                    )}
                  </button>
                  {/* Autopilot Rail - persistent status banner */}
                  {autopilot.isRunning && (
                    <div
                      className="autopilot-rail autopilot-rail-pulse mt-1.5 hidden items-center gap-2 rounded-lg px-3 py-1.5 sm:flex"
                      data-state={
                        autopilot.run?.lastError ? 'error' :
                        autopilot.run?.stopReason === 'blocked' ? 'blocked' : 'running'
                      }
                    >
                      <span className="relative flex h-2 w-2 flex-shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#0AD4C4] opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#0AD4C4]" />
                      </span>
                      <span className="text-micro font-semibold text-[#7AEDE5]">
                        Autopilot Active
                      </span>
                      {autopilot.run?.tokensUsed != null && autopilot.run?.tokenBudget != null && autopilot.run.tokenBudget > 0 && (
                        <span className="text-micro text-[#7AEDE5]/60 tabular-nums">
                          {Math.round((autopilot.run.tokensUsed / autopilot.run.tokenBudget) * 100)}% budget
                        </span>
                      )}
                    </div>
                  )}
                  {embedMode && (
                    <a
                      href={installOrgxHref}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={() => {
                        try {
                          captureTelemetry('live_install_cta_click', {
                            surface: 'mission_control',
                            embedMode: true,
                            initiativeId: autopilotInitiative?.id ?? null,
                          });
                        } catch {
                          // ignore tracking failures
                        }
                      }}
                      className="control-pill flex items-center gap-1.5 px-3 text-caption font-semibold"
                      data-tone="amber"
                      title="Install OrgX for OpenClaw"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 3v12" />
                        <path d="M8 11l4 4 4-4" />
                        <path d="M5 21h14" />
                      </svg>
                      <span>Install OrgX</span>
                    </a>
                  )}
                  {pagedInitiatives.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (allExpanded) {
                          cancelExpandWave();
                          collapseAll();
                          if (groups && groupIds.length > 0) setExpandedGroupIds(new Set());
                        } else {
                          expandAllProgressive(pagedInitiatives.map((initiative) => initiative.id));
                          if (groups && groupIds.length > 0) setExpandedGroupIds(new Set(groupIds));
                        }
                      }}
                      title={allExpanded ? 'Collapse all' : 'Expand all'}
                      aria-busy={isExpandWaveActive && !allExpanded}
                      className="control-pill flex h-8 w-8 flex-shrink-0 items-center justify-center text-secondary"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        {allExpanded ? (
                          <><path d="M4 14h16" /><path d="M4 10h16" /></>
                        ) : (
                          <><path d="M4 12h16" /><path d="M12 4v16" /></>
                        )}
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Initiative chip carousel hidden — chips are truncated and
               redundant with the initiative list below. Set to `true &&` to
               re-enable if the design changes. */}
            {false && nextActionQueue.items.length > 0 && (
              <ActionQueueStrip
                items={nextActionQueue.items}
                className="mt-2"
              />
            )}

            {sortedInitiatives.length > 0 && (
              <div
                data-mc-selection-bar="true"
                className={`mt-3 relative grid overflow-hidden rounded-xl border xl:grid-cols-[minmax(0,1fr)_560px] xl:gap-0 xl:items-center ${
                  selectedInitiativeCount > 0
                    ? 'border-lime/14 bg-[#0A0E15]/72'
                    : 'border-white/[0.10] bg-[#0A0E15]/66'
                }`}
              >
                {selectedInitiativeCount > 0 && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-px"
                    style={{
                      background:
                        'linear-gradient(90deg, rgba(191,255,0,0.22), rgba(10,212,196,0.16), transparent 72%)',
                    }}
                  />
                )}
                <div
                  className={`min-w-0 px-3 py-2 transition-[padding,min-height] duration-200 ease-out xl:flex ${
                    selectedInitiativeCount > 0
                      ? 'xl:min-h-[92px] xl:items-start'
                      : 'xl:min-h-[70px] xl:items-center'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex flex-shrink-0 items-center gap-2 text-caption text-primary">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisibleInitiatives}
                      className="h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/35"
                    />
                    Select page
                  </label>
                  <span className="flex-shrink-0 text-caption text-white/58">
                    {selectedInitiativeCount > 0
                      ? `${selectedInitiativeCount} selected`
                      : totalFilteredCount === 0
                        ? '0 visible'
                        : `${pageRangeStart}-${pageRangeEnd} of ${totalFilteredCount}`}
                  </span>
                  {selectedInitiativeCount > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('active');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                        data-state="active"
                      >
                        Mark active
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('paused');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('blocked');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                      >
                        Block
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('completed');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                      >
                        Complete
                      </button>
                      {confirmBulkInitiativeDelete ? (
                        <div className="flex items-center gap-2">
                          <span className="text-micro text-white/58">Delete selected?</span>
                          <button
                            type="button"
                            onClick={() => {
                              void runBulkInitiativeDelete();
                            }}
                            disabled={isBulkInitiativeMutating}
                            className="control-pill h-8 flex-shrink-0 border-red-400/35 bg-red-500/14 px-3 text-caption font-semibold text-red-100 disabled:opacity-45"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmBulkInitiativeDelete(false)}
                            disabled={isBulkInitiativeMutating}
                            className="control-pill h-8 flex-shrink-0 px-2.5 text-caption disabled:opacity-45"
                          >
                            Keep
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmBulkInitiativeDelete(true)}
                          disabled={isBulkInitiativeMutating}
                          className="control-pill h-8 flex-shrink-0 border-red-400/24 bg-red-500/[0.08] px-3 text-caption font-semibold text-red-100/85 disabled:opacity-45"
                        >
                          Delete
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={clearInitiativeSelection}
                        disabled={isBulkInitiativeMutating}
                        className="text-caption text-secondary transition-colors hover:text-primary disabled:opacity-45"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                  </div>
                </div>
                <AnimatePresence initial={false} mode="popLayout">
                  {!nextUpRailOpen && !nextUpDrawerOpen && (
                    <motion.div
                      key="next-up-inline-card"
                      layout="position"
                      layoutId={nextUpRailLayoutId}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0, ...nextUpInlineShellTone }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{
                        layout: nextUpMorphTransition,
                        ...nextUpSurfaceTransition,
                      }}
                      className="flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-strong px-2.5 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-[10px] sm:flex-row sm:items-center xl:h-full xl:rounded-none xl:border-b-0 xl:border-l xl:border-r-0 xl:border-t-0 xl:border-white/[0.10] xl:bg-transparent xl:px-3 xl:py-2 xl:shadow-none xl:backdrop-blur-none"
                    >
                      <div className="flex min-w-0 w-full flex-1 items-center gap-2.5">
                        {nextActionQueue.isLoading ? (
                          <Skeleton className="h-6 w-6 rounded-full" />
                        ) : railFocusItem ? (
                          <AgentAvatar
                            name={railFocusItem.runnerAgentName}
                            hint={`${railFocusItem.runnerAgentId} ${railFocusItem.runnerSource}`}
                            size="xs"
                          />
                        ) : (
                          <div className="h-6 w-6 rounded-full border border-strong bg-white/[0.05]" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-micro font-semibold uppercase tracking-[0.08em] text-white/76">
                              Now Working
                            </span>
                            {nextActionQueue.isLoading ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-strong bg-white/[0.04] px-1.5 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                                <span className="h-1.5 w-1.5 rounded-full bg-lime/70 status-breathe" />
                                Syncing
                              </span>
                            ) : (
                              <span className={`rounded-full border px-1.5 py-0.5 text-micro uppercase tracking-[0.08em] ${railStatusTone}`}>
                                {railStatusLabel}
                              </span>
                            )}
                          </div>
                          {nextActionQueue.isLoading ? (
                            <div className="mt-1.5 space-y-1">
                              <Skeleton className="h-3 w-56 rounded" />
                              <Skeleton className="h-3 w-44 rounded" />
                            </div>
                          ) : (
                            <>
                              <p className="truncate text-body font-semibold leading-snug text-bright" title={nowWorkingHeadline}>
                                {nowWorkingHeadline}
                              </p>
                              <p className="truncate text-caption leading-snug text-secondary" title={nowWorkingSubline}>
                                {nowWorkingInitiativeLabel}
                                {nowWorkingSubline ? ` · ${nowWorkingSubline}` : ''}
                              </p>
                              <p className="hidden truncate text-micro leading-snug text-secondary/85 sm:block" title={nextQueuedHeadline}>
                                Up next: {nextQueuedHeadline}
                                {nextQueuedSubline ? ` · ${nextQueuedSubline}` : ''}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                        <button
                          type="button"
                          onClick={() => {
                            const startCandidate = nextQueuedItem ?? nextActionQueueItem;
                            if (nowWorkingItem) {
                              void pauseNowWorking();
                              return;
                            }
                            if (startCandidate) {
                              void startWorkstreamWithConflictHandling(startCandidate);
                              return;
                            }
                            openNextActionInitiative();
                          }}
                          disabled={nextActionBusy || railActionKey === 'start' || railActionKey === 'pause'}
                          className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                          title={nowWorkingItem ? `Pause ${nowWorkingItem.workstreamTitle}` : 'Start next workstream'}
                        >
                          {nowWorkingItem ? 'Pause' : 'Start'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deferNowWorking()}
                          disabled={!nowWorkingItem || railActionKey === 'defer' || nextActionBusy}
                          className="control-pill hidden h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45 sm:inline-flex"
                          title="Send current workstream to the bottom of queue"
                        >
                          Defer
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleRailAutoContinue()}
                          disabled={!railAutoTarget || railActionKey === 'auto' || nextActionBusy}
                          className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
                          data-state={railAutoEnabled ? 'active' : 'idle'}
                          data-tone="teal"
                          title={railAutoEnabled ? 'Stop automatic continuation' : 'Continue automatically for this initiative'}
                        >
                          {railAutoEnabled ? 'Auto on' : 'Auto'}
                        </button>
                        <button
                          type="button"
                          onClick={toggleNextUpSurface}
                          className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold"
                          title="Open queue"
                        >
                          Open queue
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
            {bulkInitiativeNotice && (
              <div
                role="status"
                aria-live="polite"
                className="mt-2 flex items-start justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-caption text-white/72"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden
                    className={`mt-[3px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      bulkInitiativeNotice.tone === 'success'
                        ? 'bg-emerald-300/90'
                        : 'bg-amber-300/90'
                    }`}
                  />
                  <span className="min-w-0 leading-snug">{bulkInitiativeNotice.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setBulkInitiativeNotice(null)}
                  className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary"
                  aria-label="Dismiss notice"
                  title="Dismiss"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* Content */}
            <motion.div
              layout
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
              className={`mt-3 grid gap-4 pb-8 ${
                nextUpRailOpen ? 'xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-0' : 'grid-cols-1'
              }`}
            >
              <motion.div layout className={`min-w-0 ${nextUpRailOpen ? 'xl:pr-4' : ''}`}>
                {devMode && !isLoading && nextActionInitiative && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.995 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 280, damping: 30 }}
                    className="surface-tier-2 relative mb-3.5 overflow-hidden rounded-2xl p-4"
                  >
                    <div
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-px"
                      style={{
                        background:
                          'linear-gradient(90deg, rgba(191,255,0,0.14), rgba(10,212,196,0.12), transparent 72%)',
                      }}
                    />
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-[240px]">
                        <p className="section-kicker">Current context</p>
                        <p className="mt-1 text-heading font-semibold leading-snug tracking-tight text-bright">
                          {nextActionSummary.headline}
                        </p>
                        <p className="mt-1 text-body leading-relaxed text-secondary">
                          {nextActionSummary.detail}
                        </p>
                        {nextActionNotice && (
                          <div
                            className={`mt-2 inline-flex max-w-[520px] items-center gap-1 rounded-full border px-2.5 py-1 text-micro ${
                              nextActionNotice.tone === 'success'
                                ? 'border-emerald-400/24 bg-emerald-500/[0.1] text-emerald-100'
                                : 'border-amber-400/24 bg-amber-500/[0.1] text-amber-100'
                            }`}
                          >
                            {nextActionNotice.message}
                          </div>
                        )}
                      </div>
                      <div className="ml-auto flex flex-wrap items-center gap-2.5 xl:self-end">
                        {nextActionMode === 'startable' ? (
                          <button
                            type="button"
                            onClick={startInitiativeFromNextAction}
                            disabled={nextActionBusy}
                            className="control-pill h-9 px-4 text-body font-semibold disabled:opacity-45"
                            data-state="active"
                          >
                            Start initiative
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={openNextActionInitiative}
                            className="control-pill h-9 px-4 text-body font-semibold"
                            data-state={nextActionMode === 'blocked' ? 'active' : 'idle'}
                          >
                            {nextActionFallbackLabel}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={toggleNextUpSurface}
                          className="control-pill h-9 px-4 text-body font-semibold"
                        >
                          {nextUpRailOpen ? 'Hide Queue' : 'Open Queue'}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}

                {devMode && !isLoading && initiatives.length > 0 && (
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <HealthScoreCard
                      completionPercent={healthData.completionPercent}
                      totalTasks={healthData.totalTasks}
                      doneTasks={healthData.doneTasks}
                      blockedCount={healthData.blockedCount}
                      activeAgents={healthData.activeAgents}
                    />
                    <CostRollupCard usage={usageControlPlane.summary} />
                  </div>
                )}

                {isLoading ? (
                  <div className="space-y-3 pb-8">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div
                        key={`mc-skeleton-${i}`}
                        className="bg-[--orgx-surface] border border-[--orgx-border] soft-shadow rounded-2xl p-4"
                      >
                        <Skeleton className="h-4 w-2/5 rounded" />
                        <Skeleton className="h-1 w-full rounded mt-3" />
                      </div>
                    ))}
                  </div>
                ) : initiatives.length === 0 ? (
                  !hasApiKey ? (
                    <div className="pb-8">
                      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-6 py-8 text-center">
                        <div className="text-heading font-semibold text-bright">Connect OrgX to get started</div>
                        <div className="mt-1 text-body text-secondary">
                          Mission Control shows your initiative hierarchy once a user-scoped API key is configured.
                        </div>
                        {onOpenSettings && (
                          <div className="mt-4 flex items-center justify-center">
                            <button
                              type="button"
                              onClick={onOpenSettings}
                              className="h-10 rounded-full border border-lime/30 bg-lime/15 px-4 text-body font-semibold text-lime transition-colors hover:bg-lime/20"
                            >
                              Open settings
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : connection === 'disconnected' || Boolean(error) ? (
                    <div className="pb-8">
                      <MissionControlEmpty
                        mode="degraded"
                        detail={hintDetail}
                        onCreateInitiative={onCreateInitiative}
                        onPlayNextUp={onPlayNextUp}
                        onStartAutopilot={onStartAutopilot}
                        onRefresh={onRefresh}
                        onOpenSettings={onOpenSettings}
                      />
                    </div>
                  ) : (
                    <div className="pb-8">
                      <MissionControlEmpty
                        mode="empty"
                        onCreateInitiative={onCreateInitiative}
                        onPlayNextUp={onPlayNextUp}
                        onStartAutopilot={onStartAutopilot}
                        onRefresh={onRefresh}
                      />
                    </div>
                  )
                ) : sortedInitiatives.length === 0 ? (
                  <div className="pb-8">
                    <MissionControlEmpty
                      mode="filtered"
                      hasActiveFilters={hasActiveFilters}
                      onClearFilters={hasActiveFilters ? clearFilters : undefined}
                      onCreateInitiative={onCreateInitiative}
                      onPlayNextUp={onPlayNextUp}
                      onStartAutopilot={onStartAutopilot}
                      onRefresh={onRefresh}
                    />
                  </div>
                ) : groups ? (
                  /* Grouped initiative list */
                  <div className="space-y-4 pb-8">
                    {groups.map((group) => {
                      const disclosureId = groupDisclosureId(groupBy, group.key);
                      const panelId = toDisclosureDomId(disclosureId);
                      const isGroupExpanded = expandedGroupIds.has(disclosureId);
                      return (
                        <motion.div
                          key={group.key}
                          layout
                          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                        >
                          <button
                            type="button"
                            aria-expanded={isGroupExpanded}
                            aria-controls={panelId}
                            onClick={() => toggleGroupExpanded(disclosureId)}
                            className="mb-2 flex w-full items-center gap-2 rounded-xl border border-white/[0.075] bg-white/[0.016] px-3 py-2.5 text-left transition-colors hover:border-strong hover:bg-white/[0.04]"
                          >
                            <span
                              aria-hidden
                              className={`inline-flex h-5 w-5 items-center justify-center rounded-md border border-strong bg-white/[0.04] text-caption text-secondary transition-transform ${isGroupExpanded ? 'rotate-90' : ''}`}
                            >
                              ▶
                            </span>
                            <span className="text-body font-semibold text-primary">{group.label}</span>
                            <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
                              {group.count}
                            </span>
                            <span className="ml-auto text-micro uppercase tracking-[0.08em] text-secondary">
                              {isGroupExpanded ? 'Hide' : 'Show'}
                            </span>
                          </button>
                          <AnimatePresence initial={false}>
                            {isGroupExpanded && (
                              <motion.div
                                id={panelId}
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{
                                  height: { type: 'spring', stiffness: 320, damping: 32 },
                                  opacity: { duration: 0.14 },
                                }}
                                className="overflow-hidden"
                              >
                                <div className="pt-0.5">
                                  <InitiativeOrbit
                                    initiatives={group.initiatives}
                                    selectedInitiativeIds={selectedInitiativeIds}
                                    onToggleInitiativeSelection={setInitiativeSelected}
                                    isSquished={nextUpRailOpen}
                                    runtimeActivityByInitiativeId={runtimeActivityByInitiativeId}
                                  />
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="pb-8">
                    <InitiativeOrbit
                      initiatives={pagedInitiatives}
                      selectedInitiativeIds={selectedInitiativeIds}
                      onToggleInitiativeSelection={setInitiativeSelected}
                      isSquished={nextUpRailOpen}
                      runtimeActivityByInitiativeId={runtimeActivityByInitiativeId}
                    />
                  </div>
                )}
                {sortedInitiatives.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-white/70">
                      <span className="font-medium text-white/80">
                        Showing {pageRangeStart}-{pageRangeEnd}
                      </span>
                      <span className="text-white/50">of</span>
                      <span className="font-medium text-white/80">{totalFilteredCount}</span>
                      <span className="text-white/50">initiatives</span>
                    </div>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      <label className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/25 px-2 py-1 text-micro text-white/68">
                        <span>Per page</span>
                        <select
                          value={pageSize}
                          onChange={(event) => {
                            const parsed = Number.parseInt(event.target.value, 10);
                            if (!Number.isFinite(parsed)) return;
                            setPageSize(parsed);
                          }}
                          className="h-6 rounded-md border border-transparent bg-transparent px-1 text-caption text-white/90 outline-none"
                        >
                          {PAGE_SIZE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-black/25 p-1">
                        <button
                          type="button"
                          onClick={goToFirstPage}
                          disabled={!canPageBackward}
                          className="control-pill h-7 px-2 text-micro font-semibold disabled:opacity-40"
                          title="First page"
                        >
                          «
                        </button>
                        <button
                          type="button"
                          onClick={goToPreviousPage}
                          disabled={!canPageBackward}
                          className="control-pill h-7 px-2 text-micro font-semibold disabled:opacity-40"
                          title="Previous page"
                        >
                          ‹
                        </button>
                        <span className="px-1.5 text-micro text-white/64">
                          Page {currentPageIndex + 1} / {totalPages}
                        </span>
                        <button
                          type="button"
                          onClick={goToNextPage}
                          disabled={!canPageForward}
                          className="control-pill h-7 px-2 text-micro font-semibold disabled:opacity-40"
                          title="Next page"
                        >
                          ›
                        </button>
                        <button
                          type="button"
                          onClick={goToLastPage}
                          disabled={!canPageForward}
                          className="control-pill h-7 px-2 text-micro font-semibold disabled:opacity-40"
                          title="Last page"
                        >
                          »
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
              <AnimatePresence initial={false}>
                {nextUpRailOpen && (
                  <motion.aside
                    layout
                    initial={{ opacity: 0, x: 14 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 14 }}
                    transition={nextUpSurfaceTransition}
                    className="hidden xl:block"
                  >
                    <div className="sticky" style={{ top: 'calc(var(--mc-toolbar-offset) + 12px)' }}>
                      <motion.div
                        layout="position"
                        layoutId={nextUpRailLayoutId}
                        initial={{ borderRadius: 12 }}
                        animate={{ borderRadius: 16, ...nextUpExpandedShellTone }}
                        transition={{ layout: nextUpMorphTransition }}
                        className="origin-top-right flex h-[calc(100vh-var(--mc-toolbar-offset)-24px)] min-h-0 flex-col overflow-hidden rounded-2xl border shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-[12px] xl:rounded-l-none"
                      >
                        <div className="relative flex h-full min-h-0 flex-col">
                          <div className="flex items-center gap-1 border-b border-strong px-3 py-2">
                            <motion.button
                              type="button"
                              onClick={() => setRailSurface('next-up')}
                              {...missionControlMotion.segmentedTap}
                              className={`control-pill relative h-7 px-2 text-micro font-semibold ${
                                railSurface === 'next-up'
                                  ? 'text-lime'
                                  : 'text-secondary'
                              }`}
                            >
                              {railSurface === 'next-up' ? (
                                <motion.span
                                  layoutId="next-up-rail-surface-indicator"
                                  transition={nextUpMorphTransition}
                                  className="pointer-events-none absolute inset-0 rounded-md border border-lime/34 bg-lime/[0.12]"
                                  aria-hidden
                                />
                              ) : null}
                              <span className="relative z-[1]">Next Up</span>
                            </motion.button>
                            <motion.button
                              type="button"
                              onClick={() => setRailSurface('slices')}
                              {...missionControlMotion.segmentedTap}
                              className={`control-pill relative h-7 px-2 text-micro font-semibold ${
                                railSurface === 'slices'
                                  ? 'text-teal-100'
                                  : 'text-secondary'
                              }`}
                            >
                              {railSurface === 'slices' ? (
                                <motion.span
                                  layoutId="next-up-rail-surface-indicator"
                                  transition={nextUpMorphTransition}
                                  className="pointer-events-none absolute inset-0 rounded-md border border-teal-300/34 bg-teal-400/[0.12]"
                                  aria-hidden
                                />
                              ) : null}
                              <span className="relative z-[1]">Slices</span>
                            </motion.button>
                          </div>
                          <div className="min-h-0 flex-1">
                            <AnimatePresence initial={false} mode="wait">
                              {railSurface === 'next-up' ? (
                                <motion.div
                                  key="next-up-rail"
                                  {...railContentTransition}
                                  className="h-full min-h-0"
                                >
                                  <NextUpPanel
                                    title="Next Up"
                                    panelStyle="flat"
                                    className="!bg-transparent !shadow-none !border-transparent"
                                    disableEnterAnimation
                                    showHeader={false}
                                    projectId={workspaceInitiativeId}
                                    authToken={authToken}
                                    embedMode={embedMode}
                                    queueModel={nextActionQueue}
                                    queueActions={nextUpActions}
                                    snapshotVersion={snapshotVersion}
                                    onPlayWorkstream={(item) =>
                                      startWorkstreamWithConflictHandling(item, {
                                        surface: 'card',
                                      })
                                    }
                                    onOpenInitiative={openInitiativeFromNextUp}
                                    onOpenSettings={onOpenSettings}
                                    onUpgradeGate={setAutopilotUpgradeGate}
                                    excludeRunning
                                  />
                                </motion.div>
                              ) : (
                                <motion.div
                                  key="slices-rail"
                                  {...railContentTransition}
                                  className="h-full min-h-0"
                                >
                                  <SliceExplorerPanel
                                    title="Slice Explorer"
                                    className="h-full !rounded-none !border-0 !bg-transparent"
                                    workspaceId={workspaceInitiativeId}
                                    authToken={authToken}
                                    embedMode={embedMode}
                                    compact
                                    onOpenInitiative={(initiativeId, initiativeTitle) => {
                                      openInitiativeFromNextUp(initiativeId, initiativeTitle);
                                    }}
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                          <button
                            type="button"
                            onClick={toggleNextUpSurface}
                            className="control-pill absolute right-3 top-3 z-20 h-7 px-2 text-micro font-semibold"
                            title="Collapse Next Up rail"
                          >
                            Hide
                          </button>
                        </div>
                      </motion.div>
                    </div>
                  </motion.aside>
                )}
              </AnimatePresence>
            </motion.div>
            </LayoutGroup>

            <AnimatePresence>
              {nextUpDrawerOpen && (
                <>
                  <motion.button
                    key="next-up-backdrop"
                    type="button"
                    aria-label="Close next up panel"
                    onClick={() => setNextUpDrawerOpen(false)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed bottom-0 left-0 right-0 top-[64px] z-[240] bg-black/45 xl:hidden"
                  />
                  <motion.aside
                    key="next-up-drawer"
                    initial={{ x: '100%', opacity: 0.85 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: '100%', opacity: 0.9 }}
                    transition={nextUpMorphTransition}
                    className="fixed inset-x-0 bottom-0 top-[60vh] z-[250] p-2 sm:top-[64px] sm:left-auto sm:right-0 sm:w-[min(84vw,360px)] sm:p-3 lg:w-[360px] lg:max-w-[94vw] xl:hidden"
                  >
                    <div className="relative flex h-full flex-col">
                      <button
                        type="button"
                        onClick={() => setNextUpDrawerOpen(false)}
                        className="absolute right-2 top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border border-strong bg-[#080d14]/85 text-white/72 transition-colors hover:text-white"
                        aria-label="Close next up drawer"
                      >
                        ✕
                      </button>
                      <motion.div
                        layout="position"
                        layoutId={nextUpRailLayoutId}
                        initial={{ borderRadius: 12 }}
                        animate={{ borderRadius: 16, ...nextUpExpandedShellTone }}
                        transition={{ layout: nextUpMorphTransition }}
                        className="h-full overflow-hidden rounded-2xl border shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-[12px]"
                      >
                        <div className="flex h-full min-h-0 flex-col">
                          <div className="flex items-center gap-1 border-b border-strong px-3 py-2">
                            <motion.button
                              type="button"
                              onClick={() => setRailSurface('next-up')}
                              {...missionControlMotion.segmentedTap}
                              className={`control-pill relative h-7 px-2 text-micro font-semibold ${
                                railSurface === 'next-up'
                                  ? 'text-lime'
                                  : 'text-secondary'
                              }`}
                            >
                              {railSurface === 'next-up' ? (
                                <motion.span
                                  layoutId="next-up-rail-surface-indicator-mobile"
                                  transition={nextUpMorphTransition}
                                  className="pointer-events-none absolute inset-0 rounded-md border border-lime/34 bg-lime/[0.12]"
                                  aria-hidden
                                />
                              ) : null}
                              <span className="relative z-[1]">Next Up</span>
                            </motion.button>
                            <motion.button
                              type="button"
                              onClick={() => setRailSurface('slices')}
                              {...missionControlMotion.segmentedTap}
                              className={`control-pill relative h-7 px-2 text-micro font-semibold ${
                                railSurface === 'slices'
                                  ? 'text-teal-100'
                                  : 'text-secondary'
                              }`}
                            >
                              {railSurface === 'slices' ? (
                                <motion.span
                                  layoutId="next-up-rail-surface-indicator-mobile"
                                  transition={nextUpMorphTransition}
                                  className="pointer-events-none absolute inset-0 rounded-md border border-teal-300/34 bg-teal-400/[0.12]"
                                  aria-hidden
                                />
                              ) : null}
                              <span className="relative z-[1]">Slices</span>
                            </motion.button>
                          </div>
                          <div className="min-h-0 flex-1">
                            <AnimatePresence initial={false} mode="wait">
                              {railSurface === 'next-up' ? (
                                <motion.div
                                  key="next-up-drawer"
                                  {...railContentTransition}
                                  className="h-full min-h-0"
                                >
                                  <NextUpPanel
                                    title="Next Up"
                                    panelStyle="flat"
                                    className="!bg-transparent !shadow-none !border-transparent"
                                    disableEnterAnimation
                                    showHeader={false}
                                    projectId={workspaceInitiativeId}
                                    authToken={authToken}
                                    embedMode={embedMode}
                                    queueModel={nextActionQueue}
                                    queueActions={nextUpActions}
                                    snapshotVersion={snapshotVersion}
                                    onPlayWorkstream={(item) =>
                                      startWorkstreamWithConflictHandling(item, {
                                        surface: 'card',
                                      })
                                    }
                                    onOpenInitiative={(initiativeId, initiativeTitle) => {
                                      openInitiativeFromNextUp(initiativeId, initiativeTitle);
                                      setNextUpDrawerOpen(false);
                                    }}
                                    onOpenSettings={onOpenSettings}
                                    onUpgradeGate={setAutopilotUpgradeGate}
                                    excludeRunning
                                  />
                                </motion.div>
                              ) : (
                                <motion.div
                                  key="slices-drawer"
                                  {...railContentTransition}
                                  className="h-full min-h-0"
                                >
                                  <SliceExplorerPanel
                                    title="Slice Explorer"
                                    className="h-full !rounded-none !border-0 !bg-transparent"
                                    workspaceId={workspaceInitiativeId}
                                    authToken={authToken}
                                    embedMode={embedMode}
                                    compact
                                    onOpenInitiative={(initiativeId, initiativeTitle) => {
                                      openInitiativeFromNextUp(initiativeId, initiativeTitle);
                                      setNextUpDrawerOpen(false);
                                    }}
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>
                      </motion.div>
                    </div>
                  </motion.aside>
                </>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {autoEnableTarget && (
                <>
                  <motion.button
                    key="auto-enable-backdrop"
                    type="button"
                    aria-label="Close auto-enable dialog"
                    onClick={() => setAutoEnableTarget(null)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[320] bg-black/50"
                  />
                  <motion.div
                    key="auto-enable-dialog"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    transition={missionControlMotion.surfaceSwitch}
                    className="fixed inset-x-4 top-1/2 z-[330] -translate-y-1/2 rounded-2xl border border-white/[0.12] bg-[#080d14]/96 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:left-1/2 sm:right-auto sm:w-[440px] sm:-translate-x-1/2"
                  >
                    <p className="text-caption uppercase tracking-[0.08em] text-secondary">Enable Auto</p>
                    <h3 className="mt-1 text-heading font-semibold text-bright">
                      Auto-continue this initiative
                    </h3>
                    <p className="mt-2 text-caption text-secondary">
                      Initiative: <span className="text-primary">{autoEnableTarget.initiativeTitle}</span>
                    </p>
                    <p className="mt-1 text-caption text-secondary">
                      Starting workstream:{' '}
                      <span className="text-primary">{autoEnableTarget.workstreamTitle}</span>
                    </p>
                    <p className="mt-3 text-caption text-secondary">
                      OrgX will continue dispatching work in this initiative until blocked or stopped.
                    </p>
                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setAutoEnableTarget(null)}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={confirmAutoEnable}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                        data-tone="teal"
                      >
                        Enable Auto
                      </button>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {playConflict && (
                <>
                  <motion.button
                    key="play-conflict-backdrop"
                    type="button"
                    aria-label="Close switch-run dialog"
                    onClick={() => setPlayConflict(null)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[320] bg-black/50"
                  />
                  <motion.div
                    key="play-conflict-dialog"
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    transition={missionControlMotion.surfaceSwitch}
                    className="fixed inset-x-4 top-1/2 z-[330] -translate-y-1/2 rounded-2xl border border-white/[0.12] bg-[#080d14]/96 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:left-1/2 sm:right-auto sm:w-[460px] sm:-translate-x-1/2"
                  >
                    <p className="text-caption uppercase tracking-[0.08em] text-secondary">Run conflict</p>
                    <h3 className="mt-1 text-heading font-semibold text-bright">
                      Another workstream is already running
                    </h3>
                    <p className="mt-2 text-caption text-secondary">
                      {playConflict.activeWorkstreamTitle
                        ? `Running now: ${playConflict.activeWorkstreamTitle}`
                        : playConflict.message}
                    </p>
                    <p className="mt-1 text-caption text-secondary">
                      Requested: <span className="text-primary">{playConflict.target.workstreamTitle}</span>
                    </p>
                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setPlayConflict(null)}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                      >
                        Keep current
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          openInitiativeFromNextUp(
                            playConflict.target.initiativeId,
                            playConflict.target.initiativeTitle
                          );
                          setPlayConflict(null);
                        }}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                      >
                        Open running
                      </button>
                      <button
                        type="button"
                        disabled={isSwitchingRun}
                        onClick={() => void switchToConflictTarget()}
                        className="control-pill h-8 px-3 text-caption font-semibold disabled:opacity-45"
                        data-tone="teal"
                      >
                        {isSwitchingRun ? 'Switching…' : 'Switch run'}
                      </button>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Entity detail modal */}
      <EntityDetailModal target={resolvedModalTarget} onClose={closeModal} />
    </div>
  );
}
