import { useEffect, useMemo, useRef } from 'react';
import type { ActivityItem, Agent, Initiative } from '@/types';
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

export function MissionControlView({
  initiatives,
  activities,
  agents,
  isLoading,
  authToken,
  embedMode,
  initialInitiativeId,
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
      />
    </MissionControlProvider>
  );
}

function MissionControlInner({
  initiatives,
  isLoading,
  initialInitiativeId,
}: {
  initiatives: Initiative[];
  isLoading: boolean;
  initialInitiativeId?: string | null;
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
    expandedInitiatives,
    expandAll,
    collapseAll,
    modalTarget,
    closeModal,
    expandInitiative,
  } = useMissionControl();
  const didAutoExpand = useRef(false);

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

  const groups = useMemo(
    () => (groupBy !== 'none' ? groupInitiatives(filteredInitiatives, groupBy) : null),
    [filteredInitiatives, groupBy],
  );

  useEffect(() => {
    if (initialInitiativeId && !didAutoExpand.current && !isLoading && initiatives.length > 0) {
      expandInitiative(initialInitiativeId);
      didAutoExpand.current = true;
      requestAnimationFrame(() => {
        const el = document.getElementById(`initiative-${initialInitiativeId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [initialInitiativeId, isLoading, initiatives.length, expandInitiative]);

  const allExpanded = filteredInitiatives.length > 0 && expandedInitiatives.size >= filteredInitiatives.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="relative flex-1 min-h-0">
        {/* Scroll fade indicators */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#02040A] to-transparent z-10" />
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#02040A] to-transparent z-10" />

        <div className="h-full overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 pb-8 sm:px-6 lg:pb-6">
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
              {filteredInitiatives.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (allExpanded) {
                      collapseAll();
                    } else {
                      expandAll(filteredInitiatives.map((i) => i.id));
                    }
                  }}
                  className="h-10 rounded-lg border border-white/[0.12] px-3 text-[11px] uppercase tracking-[0.08em] text-white/70 transition-colors hover:border-white/[0.2] hover:text-white whitespace-nowrap"
                >
                  {allExpanded ? 'Collapse All' : 'Expand All'}
                </button>
              )}
            </div>

            {/* Content */}
            {isLoading ? (
              <div className="space-y-3">
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
              <MissionControlEmpty />
            ) : filteredInitiatives.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-8 text-center">
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
              <div className="space-y-4">
                {groups.map((group) => (
                  <div key={group.key}>
                    <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 mb-2">
                      <span className="text-[12px] font-medium text-white/75">{group.label}</span>
                      <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/50">
                        {group.count}
                      </span>
                    </div>
                    <InitiativeOrbit initiatives={group.initiatives} />
                  </div>
                ))}
              </div>
            ) : (
              <InitiativeOrbit initiatives={filteredInitiatives} />
            )}
          </div>
        </div>
      </div>

      {/* Entity detail modal */}
      <EntityDetailModal target={modalTarget} onClose={closeModal} />
    </div>
  );
}
