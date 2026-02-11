import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Initiative } from '@/types';
import {
  useMissionControl,
  type MissionControlDateField,
  type MissionControlDatePreset,
  type GroupByOption,
  type SortByOption,
} from './MissionControlContext';

interface MissionControlFiltersProps {
  initiatives: Initiative[];
  visibleCount: number;
}

function toStatusKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function statusLabel(statusKey: string): string {
  return statusKey
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

const DEFAULT_STATUS_ORDER = [
  'active',
  'in_progress',
  'not_started',
  'planned',
  'blocked',
  'at_risk',
  'paused',
  'completed',
  'done',
  'backlog',
  'todo',
  'pending',
  'draft',
];

const DATE_FIELD_OPTIONS: Array<{ value: MissionControlDateField; label: string }> = [
  { value: 'target', label: 'Target date' },
  { value: 'created', label: 'Created at' },
  { value: 'updated', label: 'Updated at' },
];

const DATE_PRESETS_TARGET: Array<{ value: MissionControlDatePreset; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'missing', label: 'No target date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'next_7_days', label: 'Next 7 days' },
  { value: 'next_30_days', label: 'Next 30 days' },
  { value: 'custom_range', label: 'Custom range' },
];

const DATE_PRESETS_ACTIVITY: Array<{ value: MissionControlDatePreset; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'missing', label: 'No timestamp' },
  { value: 'today', label: 'Today' },
  { value: 'past_7_days', label: 'Past 7 days' },
  { value: 'past_30_days', label: 'Past 30 days' },
  { value: 'custom_range', label: 'Custom range' },
];

export function MissionControlFilters({
  initiatives,
  visibleCount,
}: MissionControlFiltersProps) {
  const {
    statusFilters,
    dateField,
    datePreset,
    dateStart,
    dateEnd,
    activeFilterCount,
    hasActiveFilters,
    groupBy,
    setGroupBy,
    sortBy,
    setSortBy,
    setStatusFilters,
    toggleStatusFilter,
    setDateField,
    setDatePreset,
    setDateStart,
    setDateEnd,
    clearFilters,
  } = useMissionControl();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const statusOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const initiative of initiatives) {
      const keys = new Set<string>([
        toStatusKey(initiative.status),
        toStatusKey(initiative.rawStatus),
      ]);
      for (const key of keys) {
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    for (const key of DEFAULT_STATUS_ORDER) {
      if (!counts.has(key)) counts.set(key, 0);
    }

    const ordered = Array.from(counts.entries()).sort((a, b) => {
      const aIndex = DEFAULT_STATUS_ORDER.indexOf(a[0]);
      const bIndex = DEFAULT_STATUS_ORDER.indexOf(b[0]);
      if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
      if (aIndex >= 0) return -1;
      if (bIndex >= 0) return 1;
      return a[0].localeCompare(b[0]);
    });

    return ordered.map(([key, count]) => ({ key, count }));
  }, [initiatives]);

  const selectedStatusCount = statusFilters.length;
  const datePresetOptions = useMemo(
    () => (dateField === 'target' ? DATE_PRESETS_TARGET : DATE_PRESETS_ACTIVITY),
    [dateField]
  );

  useEffect(() => {
    if (datePresetOptions.some((option) => option.value === datePreset)) return;
    setDatePreset('any');
  }, [datePreset, datePresetOptions, setDatePreset]);

  const GROUP_BY_OPTIONS: Array<{ value: GroupByOption; label: string }> = [
    { value: 'none', label: 'None' },
    { value: 'status', label: 'Status' },
    { value: 'date', label: 'Date' },
    { value: 'category', label: 'Category' },
  ];

  const SORT_BY_OPTIONS: Array<{ value: SortByOption; label: string }> = [
    { value: 'default', label: 'Default' },
    { value: 'date_asc', label: 'Date (earliest)' },
    { value: 'date_desc', label: 'Date (latest)' },
  ];

  const hasNonDefaultViewOptions = groupBy !== 'none' || sortBy !== 'default';
  const totalActiveCount = activeFilterCount + (hasNonDefaultViewOptions ? 1 : 0);

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        data-state={open || totalActiveCount > 0 ? 'active' : 'idle'}
        className="control-pill flex items-center gap-1.5 px-2.5 text-[11px] font-semibold"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
        <span>Filters</span>
        {totalActiveCount > 0 && (
          <span className="inline-flex min-w-[16px] items-center justify-center rounded-full border border-current/30 bg-black/25 px-1 text-[10px] leading-4">
            {totalActiveCount}
          </span>
        )}
      </button>

      {visibleCount < initiatives.length && (
        <span className="text-[10px] text-white/35 whitespace-nowrap">
          {visibleCount}/{initiatives.length}
        </span>
      )}

      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-[10px] text-white/40 hover:text-white/70 transition-colors whitespace-nowrap"
        >
          Clear
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="surface-tier-2 absolute right-0 top-12 z-30 w-[340px] max-w-[92vw] rounded-xl p-3 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          >
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">Group</span>
                <select
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value as GroupByOption)}
                  className="h-9 rounded-lg border border-white/[0.08] bg-black/30 px-2 text-[11px] text-white/80 focus:border-[#BFFF00]/40 focus:outline-none"
                >
                  {GROUP_BY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">Sort</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as SortByOption)}
                  className="h-9 rounded-lg border border-white/[0.08] bg-black/30 px-2 text-[11px] text-white/80 focus:border-[#BFFF00]/40 focus:outline-none"
                >
                  {SORT_BY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 section-divider" />

            <div className="mt-3 text-[10px] uppercase tracking-[0.08em] text-white/35">Status</div>
            <div className="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
              {statusOptions.map((option) => {
                const checked = statusFilters.includes(option.key);
                return (
                  <label
                    key={option.key}
                    className="flex cursor-pointer items-center justify-between rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-white/80 hover:border-white/[0.14]"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleStatusFilter(option.key)}
                        className="h-3.5 w-3.5 accent-[#BFFF00]"
                      />
                      <span>{statusLabel(option.key)}</span>
                    </span>
                    <span className="text-[10px] text-white/50">{option.count}</span>
                  </label>
                );
              })}
            </div>

            <div className="mt-2 flex justify-between">
              <button
                type="button"
                onClick={() => setStatusFilters([])}
                className={`text-[10px] uppercase tracking-[0.08em] ${
                  selectedStatusCount > 0 ? 'text-white/70 hover:text-white' : 'text-white/35'
                }`}
                disabled={selectedStatusCount === 0}
              >
                Clear status
              </button>
              <div className="text-[10px] text-white/45">{selectedStatusCount} selected</div>
            </div>

            <div className="mt-3 border-t border-white/[0.08] pt-3">
              <div className="text-[10px] uppercase tracking-[0.1em] text-white/45">Date</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">
                    Field
                  </span>
                  <select
                    value={dateField}
                    onChange={(event) =>
                      setDateField(event.target.value as MissionControlDateField)
                    }
                    className="h-9 rounded-lg border border-white/[0.12] bg-black/30 px-2 text-[11px] text-white focus:border-[#BFFF00]/40 focus:outline-none"
                  >
                    {DATE_FIELD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">
                    Condition
                  </span>
                  <select
                    value={datePreset}
                    onChange={(event) =>
                      setDatePreset(event.target.value as MissionControlDatePreset)
                    }
                    className="h-9 rounded-lg border border-white/[0.12] bg-black/30 px-2 text-[11px] text-white focus:border-[#BFFF00]/40 focus:outline-none"
                  >
                    {datePresetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {datePreset === 'custom_range' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">
                      Start
                    </span>
                    <input
                      type="date"
                      value={dateStart}
                      onChange={(event) => setDateStart(event.target.value)}
                      className="h-9 rounded-lg border border-white/[0.12] bg-black/30 px-2 text-[11px] text-white focus:border-[#BFFF00]/40 focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">
                      End
                    </span>
                    <input
                      type="date"
                      value={dateEnd}
                      onChange={(event) => setDateEnd(event.target.value)}
                      className="h-9 rounded-lg border border-white/[0.12] bg-black/30 px-2 text-[11px] text-white focus:border-[#BFFF00]/40 focus:outline-none"
                    />
                  </label>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
