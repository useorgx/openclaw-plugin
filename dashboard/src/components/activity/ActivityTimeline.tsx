import { memo, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import type { LiveActivityItem, LiveActivityType } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';

interface ActivityTimelineProps {
  activity: LiveActivityItem[];
  selectedRunId: string | null;
  onClearSelection: () => void;
}

const MAX_RENDERED_ACTIVITY = 180;

const filters: Array<{
  id: string;
  label: string;
  types: LiveActivityType[] | null;
}> = [
  { id: 'all', label: 'All', types: null },
  {
    id: 'decisions',
    label: 'Decisions',
    types: ['decision_requested', 'decision_resolved'],
  },
  {
    id: 'handoffs',
    label: 'Handoffs',
    types: ['handoff_requested', 'handoff_claimed', 'handoff_fulfilled', 'delegation'],
  },
  { id: 'artifacts', label: 'Artifacts', types: ['artifact_created'] },
  { id: 'failures', label: 'Failures', types: ['run_failed', 'blocker_created'] },
];

const typeColor: Record<LiveActivityType, string> = {
  run_started: colors.teal,
  run_completed: colors.lime,
  run_failed: colors.red,
  artifact_created: colors.cyan,
  decision_requested: colors.amber,
  decision_resolved: colors.lime,
  handoff_requested: colors.iris,
  handoff_claimed: colors.teal,
  handoff_fulfilled: colors.lime,
  blocker_created: colors.red,
  milestone_completed: colors.cyan,
  delegation: colors.iris,
};

function groupByDay(items: LiveActivityItem[]) {
  const today: LiveActivityItem[] = [];
  const earlier: LiveActivityItem[] = [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (const item of items) {
    const timestamp = new Date(item.timestamp);
    if (timestamp >= todayStart) {
      today.push(item);
    } else {
      earlier.push(item);
    }
  }

  return { today, earlier };
}

function labelForType(type: LiveActivityType): string {
  return type.split('_').join(' ');
}

export const ActivityTimeline = memo(function ActivityTimeline({
  activity,
  selectedRunId,
  onClearSelection,
}: ActivityTimelineProps) {
  const [activeFilter, setActiveFilter] = useState(filters[0]);
  const [collapsed, setCollapsed] = useState(false);

  const { filtered, truncatedCount } = useMemo(() => {
    const selectedTypes = activeFilter.types ? new Set(activeFilter.types) : null;
    const visible: LiveActivityItem[] = [];
    let overflow = 0;

    for (const item of activity) {
      if (selectedRunId && item.runId !== selectedRunId) {
        continue;
      }

      if (selectedTypes && !selectedTypes.has(item.type)) {
        continue;
      }

      if (visible.length < MAX_RENDERED_ACTIVITY) {
        visible.push(item);
      } else {
        overflow += 1;
      }
    }

    return {
      filtered: visible,
      truncatedCount: overflow,
    };
  }, [activity, activeFilter.types, selectedRunId]);

  const grouped = useMemo(() => groupByDay(filtered), [filtered]);

  const renderItem = (item: LiveActivityItem) => {
    const color = typeColor[item.type] ?? colors.iris;

    return (
      <article
        key={item.id}
        className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-start gap-2.5">
          <span
            className="mt-1.5 h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: color,
              boxShadow: `0 0 16px ${color}77`,
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] text-white/90">
                <span className="font-semibold text-white">
                  {item.agentName ?? 'System'}
                </span>{' '}
                {item.title}
              </p>
              <span className="text-[9px] uppercase tracking-[0.1em] text-white/35">
                {labelForType(item.type)}
              </span>
            </div>

            {item.description && (
              <p className="mt-1 text-[10px] leading-relaxed text-white/55">
                {item.description}
              </p>
            )}

            <p className="mt-1.5 text-[9px] text-white/35">
              {formatRelativeTime(item.timestamp)}
            </p>
          </div>
        </div>
      </article>
    );
  };

  return (
    <PremiumCard className="flex min-h-0 flex-col fade-in-up">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-[13px] font-semibold text-white">Activity</h2>
            <span className="relative flex h-1.5 w-1.5">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                style={{ backgroundColor: colors.lime }}
              />
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: colors.lime }}
              />
            </span>

            {selectedRunId && (
              <button onClick={onClearSelection} className="chip text-[10px]">
                Clear session filter
              </button>
            )}
          </div>

          <button
            onClick={() => setCollapsed((prev) => !prev)}
            className="text-[10px] text-white/55 transition-colors hover:text-white"
          >
            {collapsed ? 'Expand groups' : 'Collapse groups'}
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setActiveFilter(filter)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors',
                activeFilter.id === filter.id
                  ? 'bg-white/[0.12] text-white'
                  : 'bg-white/[0.03] text-white/50 hover:bg-white/[0.06] hover:text-white/80'
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-5 text-center text-[11px] text-white/45">
            No matching activity right now.
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-4">
            {(['today', 'earlier'] as const).map((groupKey) => {
              const items = grouped[groupKey];
              if (items.length === 0) return null;

              const visibleItems = collapsed ? items.slice(0, 4) : items;

              return (
                <section key={groupKey}>
                  <h3 className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/35">
                    {groupKey === 'today' ? 'Today' : 'Earlier'}
                  </h3>
                  <div className="space-y-2">{visibleItems.map(renderItem)}</div>
                  {collapsed && items.length > visibleItems.length && (
                    <p className="mt-1.5 text-[10px] text-white/35">
                      +{items.length - visibleItems.length} more
                    </p>
                  )}
                </section>
              );
            })}

            {truncatedCount > 0 && (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/45">
                Showing most recent {filtered.length} events ({truncatedCount} older events omitted for smooth rendering).
              </p>
            )}
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
