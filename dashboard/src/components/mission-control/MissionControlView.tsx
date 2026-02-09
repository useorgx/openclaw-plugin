import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItem, Agent, ConnectionStatus, Initiative } from '@/types';
import { useAgentEntityMap } from '@/hooks/useAgentEntityMap';
import { SearchInput } from '@/components/shared/SearchInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { MissionControlProvider, useMissionControl } from './MissionControlContext';
import type { GroupByOption } from './MissionControlContext';
import { InitiativeOrbit } from './InitiativeOrbit';
import { MissionControlEmpty } from './MissionControlEmpty';
import { EntityDetailModal } from './EntityDetailModal';
import { MissionControlFilters } from './MissionControlFilters';

interface MissionControlViewProps {
  initiatives: Initiative[];
  activities: ActivityItem[];
  agents: Agent[];
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

export function MissionControlView({
  initiatives,
  activities,
  agents,
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
        isLoading={isLoading}
        initialInitiativeId={initialInitiativeId}
        connection={connection}
        lastSnapshotAt={lastSnapshotAt}
        error={error}
        hasApiKey={hasApiKey}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
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
  isLoading,
  initialInitiativeId,
  connection,
  lastSnapshotAt,
  error,
  hasApiKey,
  onOpenSettings,
  onRefresh,
}: {
  initiatives: Initiative[];
  isLoading: boolean;
  initialInitiativeId?: string | null;
  connection?: ConnectionStatus;
  lastSnapshotAt?: string | null;
  error?: string | null;
  hasApiKey?: boolean;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
}) {
  const {
    searchQuery,
    setSearchQuery,
    statusFilters,
    dateField,
    datePreset,
    dateStart,
    dateEnd,
    hasActiveFilters,
    groupBy,
    sortBy,
    expandedInitiatives,
    expandAll,
    collapseAll,
    modalTarget,
    closeModal,
    expandInitiative,
  } = useMissionControl();
  const didAutoExpand = useRef(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

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
    if (sortBy === 'default') return filteredInitiatives;
    return [...filteredInitiatives].sort((a, b) => {
      const aDate = a.targetDate ? Date.parse(a.targetDate) : Number.NaN;
      const bDate = b.targetDate ? Date.parse(b.targetDate) : Number.NaN;
      const aValid = Number.isFinite(aDate);
      const bValid = Number.isFinite(bDate);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return sortBy === 'date_asc' ? aDate - bDate : bDate - aDate;
    });
  }, [filteredInitiatives, sortBy]);

  const groups = useMemo(
    () => (groupBy !== 'none' ? groupInitiatives(sortedInitiatives, groupBy) : null),
    [sortedInitiatives, groupBy],
  );

  const groupIds = useMemo(
    () =>
      groups?.map((group) => groupDisclosureId(groupBy, group.key)) ?? [],
    [groupBy, groups],
  );

  const allGroupsExpanded = groupIds.length > 0 && groupIds.every((id) => expandedGroupIds.has(id));

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

  const allExpanded = sortedInitiatives.length > 0 && expandedInitiatives.size >= sortedInitiatives.length;

  const showConnectivityBanner = Boolean(
    !isLoading &&
      (connection === 'reconnecting' || connection === 'disconnected' || error)
  );
  const bannerTone =
    connection === 'disconnected'
      ? 'error'
      : connection === 'reconnecting'
        ? 'warn'
        : error
          ? 'warn'
          : 'info';
  const bannerTitle =
    !hasApiKey
      ? 'Connect OrgX'
      : connection === 'disconnected'
        ? 'Offline'
        : connection === 'reconnecting'
          ? 'Reconnecting'
          : error
            ? 'Live stream degraded'
            : 'Status';
  const bannerMessage =
    !hasApiKey
      ? 'No OrgX API key configured. Connect to see Mission Control live updates.'
      : error
        ? error
        : connection === 'disconnected'
          ? 'Mission Control is offline. Data may be stale until OrgX reconnects.'
          : 'Live data is recovering. Some sections may lag.';
  const bannerBorder =
    bannerTone === 'error'
      ? 'border-red-400/25 bg-red-500/10 text-red-100'
      : bannerTone === 'warn'
        ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
        : 'border-white/[0.08] bg-white/[0.03] text-white/70';

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="relative flex-1 min-h-0">
        {/* Scroll fade indicators */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#02040A] to-transparent z-10" />
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#02040A] to-transparent z-10" />

        <div className="h-full overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="sticky top-0 z-20 -mx-4 px-4 pt-4 pb-3 sm:-mx-6 sm:px-6 bg-[#02040A]/75 backdrop-blur">
              {showConnectivityBanner && (
                <div className={`mb-3 rounded-2xl border px-4 py-3 ${bannerBorder}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-[220px]">
                      <div className="text-[12px] font-semibold tracking-[-0.01em]">
                        {bannerTitle}
                      </div>
                      <div className="mt-0.5 text-[12px] leading-relaxed opacity-90">
                        {bannerMessage}
                      </div>
                      <div className="mt-1 text-[11px] opacity-70">
                        Last snapshot: {formatLocalTimestamp(lastSnapshotAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {onRefresh && (
                        <button
                          type="button"
                          onClick={onRefresh}
                          className="h-9 rounded-full border border-white/[0.14] bg-white/[0.05] px-3 text-[11px] font-semibold text-white/80 transition-colors hover:bg-white/[0.1]"
                        >
                          Refresh
                        </button>
                      )}
                      {onOpenSettings && (
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="h-9 rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 text-[11px] font-semibold text-[#D8FFA1] transition-colors hover:bg-[#BFFF00]/20"
                        >
                          Settings
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Search + filters + expand/collapse (single row, compact) */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1">
                  <SearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search initiatives, status, or category..."
                  />
                </div>
                <MissionControlFilters
                  initiatives={initiatives}
                  visibleCount={filteredInitiatives.length}
                />
                {/* Expand/Collapse All toggle */}
                {sortedInitiatives.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (allExpanded) {
                        collapseAll();
                      } else {
                        expandAll(sortedInitiatives.map((i) => i.id));
                      }
                    }}
                    className="h-10 rounded-lg border border-white/[0.12] px-3 text-[11px] uppercase tracking-[0.08em] text-white/70 transition-colors hover:border-white/[0.2] hover:text-white whitespace-nowrap"
                  >
                    {allExpanded ? 'Collapse All' : 'Expand All'}
                  </button>
                )}
                {groups && groupIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (allGroupsExpanded) {
                        setExpandedGroupIds(new Set());
                      } else {
                        setExpandedGroupIds(new Set(groupIds));
                      }
                    }}
                    className="h-10 rounded-lg border border-white/[0.12] px-3 text-[11px] uppercase tracking-[0.08em] text-white/70 transition-colors hover:border-white/[0.2] hover:text-white whitespace-nowrap"
                  >
                    {allGroupsExpanded ? 'Collapse Groups' : 'Expand Groups'}
                  </button>
                )}
              </div>
            </div>

            {/* Content */}
            {isLoading ? (
              <div className="space-y-3 pb-8">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={`mc-skeleton-${i}`}
                    className="glass-panel soft-shadow rounded-2xl p-4"
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
                    <div key={group.key}>
                      <button
                        type="button"
                        aria-expanded={isGroupExpanded}
                        aria-controls={panelId}
                        onClick={() => toggleGroupExpanded(disclosureId)}
                        className="mb-2 flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.04]"
                      >
                        <span
                          aria-hidden
                          className={`inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/[0.1] bg-white/[0.03] text-[11px] text-white/55 transition-transform ${isGroupExpanded ? 'rotate-90' : ''}`}
                        >
                          ▶
                        </span>
                        <span className="text-[12px] font-medium text-white/75">{group.label}</span>
                        <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/50">
                          {group.count}
                        </span>
                        <span className="ml-auto text-[10px] uppercase tracking-[0.08em] text-white/45">
                          {isGroupExpanded ? 'Hide' : 'Show'}
                        </span>
                      </button>
                      {isGroupExpanded && (
                        <div id={panelId}>
                          <InitiativeOrbit initiatives={group.initiatives} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="pb-8">
                <InitiativeOrbit initiatives={sortedInitiatives} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Entity detail modal */}
      <EntityDetailModal target={modalTarget} onClose={closeModal} />
    </div>
  );
}
