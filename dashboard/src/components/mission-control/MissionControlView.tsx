import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import type {
  ActivityItem,
  Agent,
  ConnectionStatus,
  Initiative,
  LiveActivityItem,
  NextUpQueueItem,
  RuntimeInstance,
} from '@/types';
import { useAgentEntityMap } from '@/hooks/useAgentEntityMap';
import { useAutoContinue } from '@/hooks/useAutoContinue';
import { useNextUpQueue } from '@/hooks/useNextUpQueue';
import { openUpgradeCheckout } from '@/lib/billing';
import { UpgradeRequiredError, formatPlanLabel } from '@/lib/upgradeGate';
import { SearchInput } from '@/components/shared/SearchInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { MissionControlProvider, useMissionControl } from './MissionControlContext';
import type { GroupByOption } from './MissionControlContext';
import { InitiativeOrbit } from './InitiativeOrbit';
import { MissionControlEmpty } from './MissionControlEmpty';
import { EntityDetailModal } from './EntityDetailModal';
import { MissionControlFilters } from './MissionControlFilters';
import { NextUpPanel } from './NextUpPanel';
import { AgentAvatar } from '@/components/agents/AgentAvatar';

interface MissionControlViewProps {
  initiatives: Initiative[];
  activities: Array<ActivityItem | LiveActivityItem>;
  agents: Agent[];
  runtimeInstances?: RuntimeInstance[];
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
  onFollowWorkstream?: (item: NextUpQueueItem) => void;
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
  if (mode === 'running') return 'border-teal-300/35 bg-teal-400/[0.12] text-teal-100';
  if (mode === 'blocked') return 'border-red-400/35 bg-red-500/[0.12] text-red-100';
  if (mode === 'queued' || mode === 'startable') return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
  if (mode === 'completed') return 'border-white/[0.16] bg-white/[0.05] text-white/60';
  return 'border-white/[0.16] bg-white/[0.05] text-white/68';
}

export function MissionControlView({
  initiatives,
  activities,
  agents,
  runtimeInstances = [],
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
  onFollowWorkstream,
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
        isLoading={isLoading}
        initialInitiativeId={initialInitiativeId}
        connection={connection}
        lastSnapshotAt={lastSnapshotAt}
        error={error}
        hasApiKey={hasApiKey}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
        onFollowWorkstream={onFollowWorkstream}
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

function MissionControlInner({
  initiatives,
  runtimeInstances,
  isLoading,
  initialInitiativeId,
  connection,
  lastSnapshotAt,
  error,
  hasApiKey,
  onOpenSettings,
  onRefresh,
  onFollowWorkstream,
}: {
  initiatives: Initiative[];
  runtimeInstances: RuntimeInstance[];
  isLoading: boolean;
  initialInitiativeId?: string | null;
  connection?: ConnectionStatus;
  lastSnapshotAt?: string | null;
  error?: string | null;
  hasApiKey?: boolean;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
  onFollowWorkstream?: (item: NextUpQueueItem) => void;
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
  const [showConnectivityHint, setShowConnectivityHint] = useState(false);
  const [nextUpRailOpen, setNextUpRailOpen] = useState(false);
  const [nextUpDrawerOpen, setNextUpDrawerOpen] = useState(false);
  const [nextActionNotice, setNextActionNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [selectedInitiativeIds, setSelectedInitiativeIds] = useState<Set<string>>(new Set());
  const [confirmBulkInitiativeDelete, setConfirmBulkInitiativeDelete] = useState(false);
  const [bulkInitiativeNotice, setBulkInitiativeNotice] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!bulkInitiativeNotice) return;
    if (bulkInitiativeNotice.tone !== 'success') return;
    const timeout = window.setTimeout(() => setBulkInitiativeNotice(null), 6500);
    return () => window.clearTimeout(timeout);
  }, [bulkInitiativeNotice]);

  const filteredInitiatives = useMemo(() => {
    const now = new Date();
    const todayStart = startOfLocalDay(now);

    const queryTokens = searchQuery
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    return initiatives.filter((initiative) => {
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
    initiatives,
    searchQuery,
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

  const visibleInitiativeIds = useMemo(
    () => new Set(sortedInitiatives.map((initiative) => initiative.id)),
    [sortedInitiatives]
  );

  const selectedVisibleInitiatives = useMemo(
    () => sortedInitiatives.filter((initiative) => selectedInitiativeIds.has(initiative.id)),
    [selectedInitiativeIds, sortedInitiatives]
  );
  const selectedInitiativeCount = selectedVisibleInitiatives.length;
  const allVisibleSelected =
    sortedInitiatives.length > 0 && selectedInitiativeCount === sortedInitiatives.length;
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
    () => (groupBy !== 'none' ? groupInitiatives(sortedInitiatives, groupBy) : null),
    [sortedInitiatives, groupBy],
  );

  const groupIds = useMemo(
    () =>
      groups?.map((group) => groupDisclosureId(groupBy, group.key)) ?? [],
    [groupBy, groups],
  );

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
      const next = new Set(Array.from(previous).filter((id) => visibleInitiativeIds.has(id)));
      return isSameSet(next, previous) ? previous : next;
    });
  }, [visibleInitiativeIds]);

  useEffect(() => {
    if (initialInitiativeId && !didAutoExpand.current && !isLoading && initiatives.length > 0) {
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
  }, [initialInitiativeId, isLoading, initiatives.length, expandInitiative, groupBy, groups]);

  useEffect(() => {
    if (selectedInitiativeCount === 0 && confirmBulkInitiativeDelete) {
      setConfirmBulkInitiativeDelete(false);
    }
  }, [confirmBulkInitiativeDelete, selectedInitiativeCount]);

  const allExpanded = sortedInitiatives.length > 0 && expandedInitiatives.size >= sortedInitiatives.length;
  const fallbackNextActionInitiative = useMemo(
    () =>
      sortedInitiatives.find((initiative) => initiative.status !== 'completed') ??
      sortedInitiatives[0] ??
      null,
    [sortedInitiatives]
  );
  const nextActionQueue = useNextUpQueue({
    initiativeId: null,
    authToken,
    embedMode,
    enabled: initiatives.length > 0,
  });
  const nextActionQueueItem = nextActionQueue.items[0] ?? null;
  const nextActionInitiative = useMemo(() => {
    if (!nextActionQueueItem) return fallbackNextActionInitiative;
    return (
      initiatives.find((initiative) => initiative.id === nextActionQueueItem.initiativeId) ??
      fallbackNextActionInitiative
    );
  }, [fallbackNextActionInitiative, initiatives, nextActionQueueItem]);
  const autopilotInitiativeId = nextActionInitiative?.id ?? null;

  const setInitiativeSelected = useCallback(
    (initiativeId: string, selected: boolean) => {
      setBulkInitiativeNotice(null);
      setConfirmBulkInitiativeDelete(false);
      setSelectedInitiativeIds((previous) => {
        const next = new Set(previous);
        if (selected) {
          next.add(initiativeId);
        } else {
          next.delete(initiativeId);
        }
        return next;
      });
    },
    []
  );

  const toggleSelectAllVisibleInitiatives = useCallback(() => {
    setBulkInitiativeNotice(null);
    setConfirmBulkInitiativeDelete(false);
    setSelectedInitiativeIds((previous) => {
      if (sortedInitiatives.length === 0) return previous;
      if (allVisibleSelected) return new Set();
      return new Set(sortedInitiatives.map((initiative) => initiative.id));
    });
  }, [allVisibleSelected, sortedInitiatives]);

  const clearInitiativeSelection = useCallback(() => {
    setConfirmBulkInitiativeDelete(false);
    setSelectedInitiativeIds(new Set());
  }, []);

  const runBulkInitiativeStatusUpdate = useCallback(
    async (status: Initiative['status']) => {
      if (selectedVisibleInitiatives.length === 0) return;
      setConfirmBulkInitiativeDelete(false);
      setBulkInitiativeNotice(null);

      try {
        const result = await mutations.bulkEntityMutation.mutateAsync({
          items: selectedVisibleInitiatives.map((initiative) => ({
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
          message: error instanceof Error ? error.message : 'Bulk initiative update failed.',
        });
      }
    },
    [mutations.bulkEntityMutation, selectedVisibleInitiatives]
  );

  const runBulkInitiativeDelete = useCallback(async () => {
    if (selectedVisibleInitiatives.length === 0) return;
    setBulkInitiativeNotice(null);

    try {
      const result = await mutations.bulkEntityMutation.mutateAsync({
        items: selectedVisibleInitiatives.map((initiative) => ({
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
        message: error instanceof Error ? error.message : 'Bulk initiative delete failed.',
      });
    }
  }, [mutations.bulkEntityMutation, selectedVisibleInitiatives]);

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
  const isConnectivityCritical = Boolean(connection === 'disconnected' || error);

  useEffect(() => {
    if (!hasConnectivityIssue) {
      setShowConnectivityHint(false);
      return;
    }

    if (isConnectivityCritical) {
      setShowConnectivityHint(true);
    }
  }, [hasConnectivityIssue, isConnectivityCritical]);

  const hintTone: 'critical' | 'info' =
    connection === 'disconnected' || Boolean(error)
      ? 'critical'
      : 'info';
  const hintBorder =
    hintTone === 'critical'
      ? 'border-red-400/30 bg-red-500/14 text-red-100'
      : 'border-white/[0.14] bg-white/[0.08] text-white/75';
  const hintLabel =
    connection === 'disconnected'
      ? 'Offline'
      : error
        ? 'Live degraded'
        : 'Connected';
  const hintDetail = error
    ? error
    : connection === 'disconnected'
      ? 'Data may be stale'
      : `Last snapshot ${formatLocalTimestamp(lastSnapshotAt)}`;
  const openInitiativeFromNextUp = useCallback(
    (initiativeId: string, initiativeTitle?: string) => {
      const target = initiatives.find((initiative) => initiative.id === initiativeId);
      if (!target) {
        setNextActionNotice({
          tone: 'error',
          message: initiativeTitle
            ? `${initiativeTitle} is unavailable in the current initiative list.`
            : 'Initiative is unavailable in the current initiative list.',
        });
        return false;
      }

      setNextActionNotice(null);

      const targetVisible = visibleInitiativeIds.has(initiativeId);
      const shouldResetFilters = !targetVisible;
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
        const groupedSource = targetVisible ? sortedInitiatives : initiatives;
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
      visibleInitiativeIds,
      setNextActionNotice,
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
  const handleFollowFromNextUp = useCallback(
    (item: NextUpQueueItem) => {
      onFollowWorkstream?.(item);
      setNextUpDrawerOpen(false);
    },
    [onFollowWorkstream]
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
          message: err instanceof Error ? err.message : 'Failed to start initiative.',
        });
      });
  }, [mutations.updateEntity, nextActionInitiative, openInitiativeFromNextUp]);
  const startNextAction = useCallback(() => {
    if (!nextActionQueueItem) {
      if (nextActionInitiative) {
        openInitiativeFromNextUp(nextActionInitiative.id, nextActionInitiative.name);
      }
      return;
    }

    setNextActionNotice(null);
    void nextActionQueue
      .playWorkstream({
        initiativeId: nextActionQueueItem.initiativeId,
        workstreamId: nextActionQueueItem.workstreamId,
        agentId: nextActionQueueItem.runnerAgentId,
      })
      .then(() => {
        setNextActionNotice({
          tone: 'success',
          message: `Dispatched ${nextActionQueueItem.workstreamTitle}.`,
        });
      })
      .catch((err) => {
        setNextActionNotice({
          tone: 'error',
          message: err instanceof Error ? err.message : 'Failed to dispatch next workstream.',
        });
      });
  }, [
    nextActionQueue,
    nextActionQueueItem,
    nextActionInitiative,
    openInitiativeFromNextUp,
  ]);
  const openNextActionInitiative = useCallback(() => {
    if (!nextActionInitiative) return;
    openInitiativeFromNextUp(nextActionInitiative.id, nextActionInitiative.name);
    if (typeof window !== 'undefined' && window.innerWidth >= 1280) {
      setNextUpRailOpen(true);
    }
  }, [nextActionInitiative, openInitiativeFromNextUp]);
  const toggleNextUpSurface = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1280) {
      setNextUpDrawerOpen(false);
      setNextUpRailOpen((previous) => !previous);
      return;
    }
    setNextUpDrawerOpen(true);
  }, []);

  const nextActionStatusKey = toStatusKey(
    nextActionInitiative?.rawStatus ?? nextActionInitiative?.status ?? null
  );
  const nextActionStartableStatuses = useMemo(
    () => new Set(['paused', 'draft', 'planned', 'todo', 'backlog', 'queued']),
    []
  );
  const nextActionMode = useMemo(() => {
    if (!nextActionInitiative) return 'none' as const;
    if (
      nextActionQueueItem?.queueState === 'running' ||
      nextActionQueueItem?.autoContinue?.status === 'running'
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
  }, [nextActionInitiative, nextActionQueueItem, nextActionStartableStatuses, nextActionStatusKey]);
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
    mutations.updateEntity.isPending;
  const nextActionFallbackLabel = useMemo(() => {
    if (nextActionMode === 'blocked') return 'Review blockers';
    if (nextActionMode === 'active_no_queue') return 'Open and queue work';
    if (nextActionMode === 'completed') return 'Review initiative';
    return 'Open initiative';
  }, [nextActionMode]);
  const nextUpInlineSummary = nextActionQueueItem
    ? nextActionQueueItem.workstreamTitle
    : 'No queued workstream';
  const nextUpInlineContextLabel =
    nextActionQueueItem?.initiativeTitle ?? nextActionInitiative?.name ?? 'No initiative selected';
  const nextUpInlineSubline = nextActionQueueItem?.nextTaskTitle ?? nextActionSummary.detail;
  const nextUpInlineStatusLabel = nextUpModeLabel(nextActionMode);
  const nextUpInlineStatusTone = nextUpModeTone(nextActionMode);
  const nextUpRailLayoutId = 'next-up-surface';
  const nextUpMorphTransition = useMemo(
    () => ({ type: 'spring' as const, stiffness: 340, damping: 38, mass: 0.72 }),
    []
  );
  const nextUpInlineShellTone = useMemo(
    () => ({
      backgroundColor: 'rgba(10, 14, 21, 0.82)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
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
    setNextActionNotice(null);
  }, [nextActionInitiative?.id, nextActionQueueItem?.initiativeId, nextActionQueueItem?.workstreamId]);

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
              className="sticky top-0 z-40 relative -mx-4 border-b border-white/[0.05] bg-[#02040A]/78 px-4 pb-2.5 pt-3.5 backdrop-blur-xl sm:-mx-6 sm:px-6"
            >
              <AnimatePresence initial={false}>
                {showConnectivityHint && hasConnectivityIssue && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="pointer-events-none absolute right-4 top-2.5 z-50 sm:right-6"
                  >
                    <div className={`pointer-events-auto inline-flex max-w-[540px] items-center gap-2 rounded-full border px-2.5 py-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.35)] ${hintBorder}`}>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          hintTone === 'critical'
                            ? 'bg-red-300'
                            : 'bg-white/70'
                        }`}
                      />
                      <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">
                        {hintLabel}
                      </span>
                      <span className="max-w-[280px] truncate text-[11px] opacity-85" title={hintDetail}>
                        {hintDetail}
                      </span>
                      <div className="flex items-center gap-1">
                        {onRefresh && (
                          <button
                            type="button"
                            onClick={onRefresh}
                            className="h-6 rounded-full border border-white/[0.16] bg-white/[0.08] px-2 text-[10px] font-semibold text-current transition-colors hover:bg-white/[0.15]"
                          >
                            Refresh
                          </button>
                        )}
                        {onOpenSettings && (
                          <button
                            type="button"
                            onClick={onOpenSettings}
                            className="h-6 rounded-full border border-white/[0.16] bg-white/[0.08] px-2 text-[10px] font-semibold text-current transition-colors hover:bg-white/[0.15]"
                          >
                            Settings
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

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
                    className="hidden min-w-[220px] max-w-[320px] items-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.03] px-2.5 py-1.5 xl:flex"
                    title={nextActionInitiative?.name ?? undefined}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/44">
                      Autopilot
                    </span>
                    <div className="min-w-0 flex-1 text-right">
                      <div className="truncate text-[10px] text-white/72">{autopilotStateLabel}</div>
                      {nextActionInitiative && (
                        <div className="truncate text-[10px] text-white/44">
                          {nextActionInitiative.name}
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
                        });
                        return;
                      }

                      const action = autopilot.isRunning ? autopilot.stop : autopilot.start;
                      void action()
                        .then(() => setAutopilotUpgradeGate(null))
                        .catch((err) => {
                          if (err instanceof UpgradeRequiredError) {
                            setAutopilotUpgradeGate(err);
                          } else {
                            setAutopilotUpgradeGate(null);
                            console.warn('[autopilot] toggle failed', err);
                          }
                        });
                    }}
                    disabled={
                      autopilotUnavailable ||
                      autopilot.isStarting ||
                      autopilot.isStopping
                    }
                    title={
                      autopilotUnavailable
                        ? 'Select an initiative to run Autopilot'
                        : autopilotNeedsUpgrade
                          ? 'Upgrade to enable auto-continue for BYOK agents'
                          : autopilot.isRunning
                            ? 'Stop Autopilot'
                            : `Start Autopilot${nextActionInitiative ? ` for ${nextActionInitiative.name}` : ''}`
                    }
                    data-state={
                      autopilot.isRunning || autopilotNeedsUpgrade ? 'active' : 'idle'
                    }
                    data-tone={autopilotTone}
                    className="control-pill flex items-center gap-1.5 px-3 text-[11px] font-semibold disabled:opacity-40"
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
                        : `${autopilot.isRunning ? 'Stop' : 'Start'} Autopilot`}
                    </span>
                    {autopilot.isRunning && hasActiveRuntime && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0AD4C4] status-breathe" />
                    )}
                  </button>
                  {sortedInitiatives.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (allExpanded) {
                          cancelExpandWave();
                          collapseAll();
                          if (groups && groupIds.length > 0) setExpandedGroupIds(new Set());
                        } else {
                          expandAllProgressive(sortedInitiatives.map((i) => i.id));
                          if (groups && groupIds.length > 0) setExpandedGroupIds(new Set(groupIds));
                        }
                      }}
                      title={allExpanded ? 'Collapse all' : 'Expand all'}
                      aria-busy={isExpandWaveActive && !allExpanded}
                      className="control-pill flex h-8 w-8 flex-shrink-0 items-center justify-center text-white/55"
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

            {sortedInitiatives.length > 0 && (
              <div
                data-mc-selection-bar="true"
                className={`mt-3 grid gap-2 rounded-xl border px-3 py-2 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center ${
                  selectedInitiativeCount > 0
                    ? 'border-[#BFFF00]/18 bg-[#BFFF00]/[0.04]'
                    : 'border-white/[0.08] bg-white/[0.02]'
                }`}
              >
                <div className="min-w-0 flex flex-wrap items-center gap-2">
                  <label className="inline-flex flex-shrink-0 items-center gap-2 text-[11px] text-white/75">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisibleInitiatives}
                      className="h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-[#BFFF00] focus:ring-[#BFFF00]/35"
                    />
                    Select visible
                  </label>
                  <span className="flex-shrink-0 text-[11px] text-white/58">
                    {selectedInitiativeCount > 0
                      ? `${selectedInitiativeCount} selected`
                      : `${sortedInitiatives.length} visible`}
                  </span>
                  {selectedInitiativeCount > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('active');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
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
                        className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('blocked');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
                      >
                        Block
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runBulkInitiativeStatusUpdate('completed');
                        }}
                        disabled={isBulkInitiativeMutating}
                        className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
                      >
                        Complete
                      </button>
                      {confirmBulkInitiativeDelete ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-white/58">Delete selected?</span>
                          <button
                            type="button"
                            onClick={() => {
                              void runBulkInitiativeDelete();
                            }}
                            disabled={isBulkInitiativeMutating}
                            className="control-pill h-8 flex-shrink-0 border-red-400/35 bg-red-500/14 px-3 text-[11px] font-semibold text-red-100 disabled:opacity-45"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmBulkInitiativeDelete(false)}
                            disabled={isBulkInitiativeMutating}
                            className="control-pill h-8 flex-shrink-0 px-2.5 text-[11px] disabled:opacity-45"
                          >
                            Keep
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmBulkInitiativeDelete(true)}
                          disabled={isBulkInitiativeMutating}
                          className="control-pill h-8 flex-shrink-0 border-red-400/24 bg-red-500/[0.08] px-3 text-[11px] font-semibold text-red-100/85 disabled:opacity-45"
                        >
                          Delete
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={clearInitiativeSelection}
                        disabled={isBulkInitiativeMutating}
                        className="text-[11px] text-white/55 transition-colors hover:text-white/80 disabled:opacity-45"
                      >
                        Clear
                      </button>
                    </div>
                  )}
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
                        duration: 0.2,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      className="flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-white/[0.12] px-2.5 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-[10px] xl:w-[520px] xl:justify-self-end"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        {nextActionQueue.isLoading ? (
                          <Skeleton className="h-6 w-6 rounded-full" />
                        ) : nextActionQueueItem ? (
                          <AgentAvatar
                            name={nextActionQueueItem.runnerAgentName}
                            hint={`${nextActionQueueItem.runnerAgentId} ${nextActionQueueItem.runnerSource}`}
                            size="xs"
                          />
                        ) : (
                          <div className="h-6 w-6 rounded-full border border-white/[0.16] bg-white/[0.05]" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/76">
                              Next Up
                            </span>
                            {nextActionQueue.isLoading ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.14] bg-white/[0.04] px-1.5 py-[1px] text-[9px] uppercase tracking-[0.07em] text-white/60">
                                <span className="h-1.5 w-1.5 rounded-full bg-[#BFFF00]/70 status-breathe" />
                                Syncing
                              </span>
                            ) : (
                              <span className={`rounded-full border px-1.5 py-[1px] text-[9px] uppercase tracking-[0.07em] ${nextUpInlineStatusTone}`}>
                                {nextUpInlineStatusLabel}
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
                              <p className="truncate text-[12px] font-semibold leading-snug text-white/90" title={nextUpInlineSummary}>
                                {nextUpInlineSummary}
                              </p>
                              <p className="truncate text-[11px] leading-snug text-white/45" title={nextUpInlineSubline}>
                                {nextUpInlineContextLabel}
                                {nextUpInlineSubline ? ` · ${nextUpInlineSubline}` : ''}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <button
                          type="button"
                          onClick={startNextAction}
                          disabled={!nextActionQueueItem || nextActionBusy}
                          className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
                          title={
                            nextActionQueueItem
                              ? `Dispatch ${nextActionQueueItem.workstreamTitle}`
                              : 'No queued workstream to dispatch'
                          }
                        >
                          Play
                        </button>
                        <button
                          type="button"
                          onClick={toggleNextUpSurface}
                          className="control-pill h-8 flex-shrink-0 px-3 text-[11px] font-semibold"
                          title="Expand Next Up rail"
                        >
                          Open
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
            {bulkInitiativeNotice && (
              <div
                className={`mt-2 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-[11px] ${
                  bulkInitiativeNotice.tone === 'success'
                    ? 'border-emerald-400/18 bg-white/[0.02] text-white/75'
                    : 'border-amber-400/18 bg-white/[0.02] text-white/75'
                }`}
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
                  className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.10] bg-white/[0.02] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                  aria-label="Dismiss notice"
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Content */}
            <motion.div
              layout
              transition={{ type: 'spring', stiffness: 260, damping: 30 }}
              className={`grid gap-4 pb-8 ${
                nextUpRailOpen ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'
              }`}
            >
              <motion.div layout className="min-w-0">
                {!isLoading && nextActionInitiative && (
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
                          'linear-gradient(90deg, rgba(191,255,0,0.18), rgba(10,212,196,0.16), transparent 72%)',
                      }}
                    />
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-[240px]">
                        <p className="section-kicker">Next action</p>
                        <p className="mt-1 text-[15px] font-semibold leading-snug tracking-tight text-white/92">
                          {nextActionSummary.headline}
                        </p>
                        <p className="mt-1 text-[12px] leading-relaxed text-white/55">
                          {nextActionSummary.detail}
                        </p>
                        {nextActionNotice && (
                          <div
                            className={`mt-2 inline-flex max-w-[520px] items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] ${
                              nextActionNotice.tone === 'success'
                                ? 'border-emerald-400/24 bg-emerald-500/[0.1] text-emerald-100'
                                : 'border-amber-400/24 bg-amber-500/[0.1] text-amber-100'
                            }`}
                          >
                            {nextActionNotice.message}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        {(nextActionMode === 'queued' || nextActionMode === 'running') && nextActionQueueItem ? (
                          <button
                            type="button"
                            onClick={
                              nextActionMode === 'running'
                                ? () => handleFollowFromNextUp(nextActionQueueItem)
                                : startNextAction
                            }
                            disabled={nextActionBusy}
                            className="control-pill h-9 px-4 text-[12px] font-semibold disabled:opacity-45"
                            data-state="active"
                          >
                            {nextActionMode === 'running' ? 'Follow workstream' : 'Play next workstream'}
                          </button>
                        ) : nextActionMode === 'startable' ? (
                          <button
                            type="button"
                            onClick={startInitiativeFromNextAction}
                            disabled={nextActionBusy}
                            className="control-pill h-9 px-4 text-[12px] font-semibold disabled:opacity-45"
                            data-state="active"
                          >
                            Start initiative
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={openNextActionInitiative}
                            className="control-pill h-9 px-4 text-[12px] font-semibold"
                            data-state={nextActionMode === 'blocked' ? 'active' : 'idle'}
                          >
                            {nextActionFallbackLabel}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={toggleNextUpSurface}
                          className="control-pill h-9 px-4 text-[12px] font-semibold"
                        >
                          {nextUpRailOpen ? 'Hide Next Up' : 'Open Next Up'}
                        </button>
                      </div>
                    </div>
                  </motion.div>
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
                        <div className="text-[14px] font-semibold text-white/85">Connect OrgX to get started</div>
                        <div className="mt-1 text-[12px] text-white/55">
                          Mission Control shows your initiative hierarchy once a user-scoped API key is configured.
                        </div>
                        {onOpenSettings && (
                          <div className="mt-4 flex items-center justify-center">
                            <button
                              type="button"
                              onClick={onOpenSettings}
                              className="h-10 rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-4 text-[12px] font-semibold text-[#D8FFA1] transition-colors hover:bg-[#BFFF00]/20"
                            >
                              Open settings
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="pb-8">
                      <MissionControlEmpty />
                    </div>
                  )
                ) : sortedInitiatives.length === 0 ? (
                  <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-8 text-center pb-8">
                    <div className="text-[13px] font-medium text-white/85">
                      No initiatives match the current filters
                    </div>
                    <div className="mt-1 text-[12px] text-white/50">
                      {hasActiveFilters
                        ? 'Try adjusting status/date filters or clear them.'
                        : 'Try a broader search phrase.'}
                    </div>
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
                            className="mb-2 flex w-full items-center gap-2 rounded-xl border border-white/[0.075] bg-white/[0.016] px-3 py-2.5 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.04]"
                          >
                            <span
                              aria-hidden
                              className={`inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.04] text-[11px] text-white/55 transition-transform ${isGroupExpanded ? 'rotate-90' : ''}`}
                            >
                              ▶
                            </span>
                            <span className="text-[12px] font-semibold text-white/80">{group.label}</span>
                            <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/55">
                              {group.count}
                            </span>
                            <span className="ml-auto text-[10px] uppercase tracking-[0.08em] text-white/45">
                              {isGroupExpanded ? 'Hide' : 'Show'}
                            </span>
                          </button>
                          <AnimatePresence initial={false}>
                            {isGroupExpanded && (
                              <motion.div
                                id={panelId}
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                              >
                                <div className="pt-0.5">
                                  <InitiativeOrbit
                                    initiatives={group.initiatives}
                                    selectedInitiativeIds={selectedInitiativeIds}
                                    onToggleInitiativeSelection={setInitiativeSelected}
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
                      initiatives={sortedInitiatives}
                      selectedInitiativeIds={selectedInitiativeIds}
                      onToggleInitiativeSelection={setInitiativeSelected}
                      runtimeActivityByInitiativeId={runtimeActivityByInitiativeId}
                    />
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
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="hidden xl:block"
                  >
                    <div className="sticky" style={{ top: 'calc(var(--mc-toolbar-offset) + 12px)' }}>
                      <motion.div
                        layout="position"
                        layoutId={nextUpRailLayoutId}
                        initial={{ borderRadius: 12 }}
                        animate={{ borderRadius: 16, ...nextUpExpandedShellTone }}
                        transition={{ layout: nextUpMorphTransition, type: 'spring', stiffness: 340, damping: 38, mass: 0.72 }}
                        className="origin-top-right flex h-[calc(100vh-var(--mc-toolbar-offset)-24px)] min-h-0 flex-col overflow-hidden rounded-2xl border shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-[12px]"
                      >
                        <div className="relative flex-1 min-h-0">
                          <button
                            type="button"
                            onClick={toggleNextUpSurface}
                            className="control-pill absolute right-3 top-3 z-20 h-7 px-2 text-[10px] font-semibold"
                            title="Collapse Next Up rail"
                          >
                            Hide
                          </button>
                          <NextUpPanel
                            title="Next Up"
                            className="!bg-transparent !shadow-none !border-transparent"
                            disableEnterAnimation
                            authToken={authToken}
                            embedMode={embedMode}
                            onFollowWorkstream={handleFollowFromNextUp}
                            onOpenInitiative={openInitiativeFromNextUp}
                            onOpenSettings={onOpenSettings}
                            onUpgradeGate={setAutopilotUpgradeGate}
                          />
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
                    className="fixed bottom-0 left-0 right-0 top-[64px] z-[220] hidden bg-black/45 lg:block xl:hidden"
                  />
                  <motion.aside
                    key="next-up-drawer"
                    initial={{ x: '100%', opacity: 0.85 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: '100%', opacity: 0.9 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 34 }}
                    className="fixed bottom-0 right-0 top-[64px] z-[230] hidden w-[360px] max-w-[94vw] p-3 lg:block xl:hidden"
                  >
                    <div className="relative flex h-full flex-col">
                      <button
                        type="button"
                        onClick={() => setNextUpDrawerOpen(false)}
                        className="absolute right-2 top-16 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.14] bg-[#080d14]/85 text-white/72 transition-colors hover:text-white"
                        aria-label="Close next up drawer"
                      >
                        ✕
                      </button>
                      <motion.div
                        layout="position"
                        layoutId={nextUpRailLayoutId}
                        initial={{ borderRadius: 12 }}
                        animate={{ borderRadius: 16, ...nextUpExpandedShellTone }}
                        transition={{ layout: nextUpMorphTransition, type: 'spring', stiffness: 340, damping: 38, mass: 0.72 }}
                        className="h-full overflow-hidden rounded-2xl border shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur-[12px]"
                      >
                          <NextUpPanel
                            title="Next Up"
                            className="!bg-transparent !shadow-none !border-transparent"
                            disableEnterAnimation
                            authToken={authToken}
                            embedMode={embedMode}
                            onFollowWorkstream={handleFollowFromNextUp}
                            onOpenInitiative={(initiativeId, initiativeTitle) => {
                              openInitiativeFromNextUp(initiativeId, initiativeTitle);
                              setNextUpDrawerOpen(false);
                            }}
                            onOpenSettings={onOpenSettings}
                            onUpgradeGate={setAutopilotUpgradeGate}
                          />
                      </motion.div>
                    </div>
                  </motion.aside>
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
