import { motion, Reorder } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchInput } from '@/components/shared/SearchInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { InlineToast } from '@/components/shared/InlineToast';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { useMissionControlSlices } from '@/hooks/useMissionControlSlices';
import { useMissionControlSliceOrdering } from '@/hooks/useMissionControlSliceOrdering';
import type {
  MissionControlSliceItem,
  MissionControlSliceLevel,
  MissionControlSliceOrderMode,
} from '@/types';
import { humanizeId, humanizeWarning, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { cn } from '@/lib/utils';

interface SliceExplorerPanelProps {
  workspaceId?: string | null;
  initiativeId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  className?: string;
  title?: string;
  compact?: boolean;
  onOpenInitiative?: (initiativeId: string, initiativeTitle?: string) => void;
}

const LEVEL_OPTIONS: Array<{
  value: MissionControlSliceLevel;
  label: string;
}> = [
  { value: 'initiative', label: 'Initiative' },
  { value: 'workstream', label: 'Workstream' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'task', label: 'Task' },
];

function levelLabel(value: MissionControlSliceLevel): string {
  return LEVEL_OPTIONS.find((option) => option.value === value)?.label ?? 'Workstream';
}

function statusTone(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === 'running' ||
    normalized === 'active' ||
    normalized === 'in_progress'
  ) {
    return 'border-teal-300/28 bg-teal-400/[0.09] text-teal-100/90';
  }
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'border-red-400/26 bg-red-500/[0.08] text-red-100/90';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'resolved') {
    return 'border-strong bg-white/[0.05] text-secondary';
  }
  return 'border-lime/24 bg-lime/[0.08] text-lime/92';
}

function statusHighlight(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === 'running' ||
    normalized === 'active' ||
    normalized === 'in_progress'
  ) {
    return 'from-teal-300/0 via-teal-300/65 to-teal-300/0';
  }
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'from-red-300/0 via-red-300/65 to-red-300/0';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'resolved') {
    return 'from-white/0 via-white/45 to-white/0';
  }
  return 'from-lime/0 via-lime/70 to-lime/0';
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function compactOpaque(value: string | null | undefined, prefix: string): string {
  if (!value) return prefix;
  const trimmed = value.trim();
  if (!trimmed) return prefix;
  return isOpaqueId(trimmed) ? `${prefix} ${humanizeId(trimmed)}` : trimmed;
}

function sliceTitle(item: MissionControlSliceItem): string {
  const preferred =
    item.title.trim() ||
    item.taskTitle?.trim() ||
    item.milestoneTitle?.trim() ||
    item.workstreamTitle?.trim() ||
    item.initiativeTitle?.trim() ||
    '';
  if (preferred && !isOpaqueId(preferred)) return sanitizeDisplayText(preferred);

  if (item.level === 'task') return compactOpaque(item.taskId ?? item.sliceId, 'Task');
  if (item.level === 'milestone') return compactOpaque(item.milestoneId ?? item.sliceId, 'Milestone');
  if (item.level === 'initiative') return compactOpaque(item.initiativeId ?? item.sliceId, 'Initiative');
  return compactOpaque(item.workstreamId ?? item.sliceId, 'Workstream');
}

function sliceSubtitle(item: MissionControlSliceItem): string {
  const parts = [
    item.initiativeTitle,
    item.workstreamTitle,
    item.milestoneTitle,
    item.taskTitle,
  ].filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
  if (parts.length === 0) {
    return sanitizeDisplayText(compactOpaque(item.sliceId, 'Slice'));
  }
  const cleaned = parts
    .map((entry) => sanitizeDisplayText(entry))
    .filter((entry) => entry.length > 0);
  return cleaned.join(' / ');
}

function normalizeRunnerName(item: MissionControlSliceItem): string {
  const raw = item.runnerAgentName?.trim() ?? '';
  const idRaw = item.runnerAgentId?.trim().toLowerCase() ?? '';
  if (!raw) return idRaw && idRaw !== 'main' ? sanitizeDisplayText(idRaw) : 'Unassigned';
  const normalized = raw.toLowerCase();
  if (normalized === 'undefined' || normalized === 'null') return 'Unassigned';
  if (normalized === 'main' && (idRaw === 'main' || item.runnerSource === 'fallback')) {
    return 'Unassigned';
  }
  return sanitizeDisplayText(raw);
}

function taskLoadLabel(item: MissionControlSliceItem): string {
  const count =
    typeof item.sliceTaskCount === 'number' && Number.isFinite(item.sliceTaskCount)
      ? Math.max(0, Math.floor(item.sliceTaskCount))
      : 0;
  if (count <= 0) return 'No task';
  if (count === 1) return '1 task';
  return `${count} tasks`;
}

function formatSliceExplorerError(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const message = humanizeWarning(raw.trim());
  return message || fallback;
}

export function SliceExplorerPanel({
  workspaceId = null,
  initiativeId = null,
  authToken = null,
  embedMode = false,
  className = '',
  title = 'Slice Explorer',
  compact = false,
  onOpenInitiative,
}: SliceExplorerPanelProps) {
  const [level, setLevel] = useState<MissionControlSliceLevel>('workstream');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(compact ? 18 : 28);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null
  );
  const [manualOrderIds, setManualOrderIds] = useState<string[]>([]);
  const [manualOrderDirty, setManualOrderDirty] = useState(false);
  const [pendingOrderMode, setPendingOrderMode] =
    useState<MissionControlSliceOrderMode | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement | null>(null);

  const slicesQuery = useMissionControlSlices({
    workspaceId,
    initiativeId,
    level,
    orderMode: pendingOrderMode,
    includeCompleted: false,
    search,
    offset,
    limit,
    authToken,
    embedMode,
    enabled: Boolean(workspaceId || initiativeId),
  });

  const ordering = useMissionControlSliceOrdering({
    workspaceId,
    initiativeId,
    level,
    authToken,
    embedMode,
  });

  const slices = slicesQuery.slices;
  const source = slicesQuery.source;
  const pagination = slicesQuery.pagination;
  const effectiveOrderMode: MissionControlSliceOrderMode =
    slicesQuery.orderMode ?? 'manual';
  const visibleOffset = pagination?.offset ?? offset;
  const visibleTotal = pagination?.total ?? slicesQuery.data?.total ?? slices.length;
  const pageStart = slices.length === 0 ? 0 : visibleOffset + 1;
  const pageEnd = slices.length === 0 ? 0 : visibleOffset + slices.length;

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!filtersOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (filtersRef.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [filtersOpen]);

  useEffect(() => {
    setOffset(0);
  }, [level, search]);

  const sliceOrderSignature = useMemo(
    () => slices.map((item) => item.sliceId).join('|'),
    [slices]
  );

  useEffect(() => {
    setManualOrderIds(slices.map((item) => item.sliceId));
    setManualOrderDirty(false);
  }, [sliceOrderSignature, effectiveOrderMode]);

  const slicesById = useMemo(
    () => new Map(slices.map((item) => [item.sliceId, item])),
    [slices]
  );

  const orderedSlices = useMemo(() => {
    if (!manualOrderDirty || manualOrderIds.length !== slices.length) return slices;
    const ordered = manualOrderIds
      .map((sliceId) => slicesById.get(sliceId) ?? null)
      .filter((item): item is MissionControlSliceItem => Boolean(item));
    if (ordered.length !== slices.length) return slices;
    return ordered;
  }, [manualOrderDirty, manualOrderIds, slices, slicesById]);

  const canManualReorder =
    effectiveOrderMode === 'manual' &&
    slices.length > 1 &&
    !ordering.isReordering &&
    visibleOffset === 0 &&
    !(pagination?.hasMore ?? false);

  const saveManualOrder = async () => {
    if (!canManualReorder || !manualOrderDirty) return;
    try {
      await ordering.reorder(manualOrderIds);
      setManualOrderDirty(false);
      setNotice({
        tone: 'success',
        message: `Saved ${manualOrderIds.length} slice positions.`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: formatSliceExplorerError(
          error instanceof Error ? error.message : '',
          'Failed to save slice order.'
        ),
      });
    }
  };

  const applyOrderMode = async (nextMode: MissionControlSliceOrderMode) => {
    if (nextMode === effectiveOrderMode && pendingOrderMode === null) return;
    setPendingOrderMode(nextMode);
    try {
      await ordering.setOrderMode(nextMode);
      setNotice({
        tone: 'success',
        message: `Slice ordering set to ${nextMode}.`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: formatSliceExplorerError(
          error instanceof Error ? error.message : '',
          `Failed to set ${nextMode} ordering.`
        ),
      });
    } finally {
      setPendingOrderMode(null);
    }
  };

  const openInitiative = (item: MissionControlSliceItem) => {
    if (!onOpenInitiative || !item.initiativeId) return;
    onOpenInitiative(item.initiativeId, item.initiativeTitle ?? undefined);
  };

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-2xl border border-strong bg-[#070b12]/88',
        className
      )}
    >
      <div className="flex flex-col gap-2 border-b border-strong px-3 py-3">
        <div className="flex min-h-[34px] items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-lime/70" />
          <h3 className="text-caption font-semibold uppercase tracking-[0.1em] text-secondary">
            {title}
          </h3>
          <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
            {visibleTotal}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <div ref={filtersRef} className="relative">
              <button
                type="button"
                onClick={() => setFiltersOpen((previous) => !previous)}
                className="control-pill h-8 px-2.5 text-micro font-semibold"
                aria-haspopup="menu"
                aria-expanded={filtersOpen}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-85"
                  aria-hidden
                >
                  <path d="M4 6h16" />
                  <path d="M7 12h10" />
                  <path d="M10 18h4" />
                </svg>
                <span>Filters</span>
              </button>
              {filtersOpen ? (
                <div className="surface-tier-2 absolute right-0 top-[calc(100%+8px)] z-[260] w-[300px] max-w-[88vw] rounded-xl p-3 shadow-[0_16px_40px_rgba(0,0,0,0.46)] backdrop-blur-xl">
                  <div className="space-y-2.5">
                    <div>
                      <p className="section-kicker">Entity level</p>
                      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                        {LEVEL_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              setLevel(option.value);
                              setFiltersOpen(false);
                            }}
                            className={cn(
                              'control-pill flex h-8 items-center gap-1.5 px-2 text-micro font-semibold',
                              level === option.value
                                ? 'border-lime/34 bg-lime/[0.12] text-lime'
                                : 'text-secondary'
                            )}
                          >
                            <EntityIcon type={option.value} size={10} className="opacity-80" />
                            <span>{option.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="section-kicker">Ordering</p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          className={cn(
                            'control-pill h-8 px-2.5 text-micro font-semibold',
                            effectiveOrderMode === 'manual'
                              ? 'border-lime/34 bg-lime/[0.12] text-lime'
                              : 'text-secondary'
                          )}
                          disabled={ordering.isSettingOrderMode}
                          onClick={() => void applyOrderMode('manual')}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'control-pill h-8 px-2.5 text-micro font-semibold',
                            effectiveOrderMode === 'algorithmic'
                              ? 'border-teal-300/34 bg-teal-400/[0.13] text-teal-100'
                              : 'text-secondary'
                          )}
                          disabled={ordering.isSettingOrderMode}
                          onClick={() => void applyOrderMode('algorithmic')}
                        >
                          Algorithmic
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            {effectiveOrderMode === 'manual' && (
              <button
                type="button"
                className="control-pill h-8 px-2.5 text-micro font-semibold disabled:opacity-45"
                disabled={!manualOrderDirty || !canManualReorder}
                onClick={() => void saveManualOrder()}
              >
                Save order
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search slices, entities, or IDs..."
            />
          </div>
          <span className="chip whitespace-nowrap text-micro">
            {LEVEL_OPTIONS.find((option) => option.value === level)?.label ?? 'Workstream'}
          </span>
        </div>

        {(source === 'local_fallback' || slicesQuery.degraded.length > 0) && (
          <div className="rounded-xl border border-amber-300/24 bg-amber-400/[0.08] px-2.5 py-1.5 text-micro text-amber-100/90">
            {source === 'local_fallback'
              ? 'Canonical slices unavailable; showing local fallback.'
              : slicesQuery.degraded[0]}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain scroll-smooth px-2 pb-2 pt-2">
        {slicesQuery.isLoading ? (
          <div className="space-y-2 px-1">
            {Array.from({ length: compact ? 4 : 7 }).map((_, index) => (
              <div
                key={`slice-loading-${index}`}
                className="rounded-xl border border-strong bg-white/[0.02] px-3 py-2"
              >
                <Skeleton className="h-3.5 w-1/2 rounded-full" />
                <Skeleton className="mt-2 h-3 w-4/5 rounded-full" />
              </div>
            ))}
          </div>
        ) : orderedSlices.length === 0 ? (
          <div className="rounded-xl border border-strong bg-white/[0.02] px-3 py-3 text-caption text-secondary">
            No slices match this view.
          </div>
        ) : canManualReorder ? (
          <Reorder.Group
            axis="y"
            values={manualOrderIds}
            onReorder={(nextOrder) => {
              setManualOrderIds(nextOrder);
              setManualOrderDirty(true);
            }}
            className="space-y-2"
          >
            {manualOrderIds.map((sliceId, index) => {
              const item = slicesById.get(sliceId);
              if (!item) return null;
              const rank =
                item.finalRank ??
                item.manualRank ??
                item.algorithmRank ??
                index + 1;
              const factors = item.iwmt?.factors ?? [];
              const scoredFactors = factors.filter(
                (factor) => typeof factor.value === 'number' && Number.isFinite(factor.value)
              );
              const hasRoi = typeof item.roiPerToken === 'number' && Number.isFinite(item.roiPerToken);
              const hasObjective =
                typeof item.objectiveScore === 'number' && Number.isFinite(item.objectiveScore);
              const runnerName = normalizeRunnerName(item);
              const subtitle = sliceSubtitle(item);
              return (
                <Reorder.Item
                  key={item.sliceId}
                  value={item.sliceId}
                  className="group hover-lift relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/[0.14]"
                >
                  <div
                    className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${statusHighlight(item.status)}`}
                    aria-hidden
                  />
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-strong bg-white/[0.04] text-caption text-secondary"
                      aria-label="Drag to reorder"
                      title="Drag to reorder"
                    >
                      ⋮⋮
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <span className="rounded-md border border-lime/22 bg-lime/[0.08] px-1.5 py-0.5 text-micro font-semibold text-[#DFFFB5]">
                          #{rank}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-start gap-1.5">
                            <EntityIcon type={item.level} size={11} className="mt-0.5 flex-shrink-0 opacity-80" />
                            <p className="min-w-0 flex-1 line-clamp-2 text-caption font-semibold leading-snug text-primary">
                              {sliceTitle(item)}
                            </p>
                          </div>
                        </div>
                        <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.08em]',
                              statusTone(item.status)
                            )}
                          >
                            {item.status.replace(/_/g, ' ')}
                          </span>
                          {item.initiativeId && onOpenInitiative ? (
                            <button
                              type="button"
                              className="control-pill h-6 px-2 text-micro font-semibold"
                              onClick={() => openInitiative(item)}
                            >
                              Open
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1 inline-flex min-w-0 items-center gap-1 truncate text-micro text-secondary" title={subtitle}>
                        <span className="truncate">{subtitle}</span>
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                        <span className="chip text-micro">{levelLabel(item.level)}</span>
                        <span className="chip text-micro">{taskLoadLabel(item)}</span>
                        <span className="chip text-micro">Agent {runnerName}</span>
                        {hasRoi ? (
                          <span className="chip text-micro">ROI/token {formatMetric(item.roiPerToken, 3)}</span>
                        ) : null}
                        {hasObjective ? (
                          <span className="chip text-micro">Obj {formatMetric(item.objectiveScore, 2)}</span>
                        ) : null}
                      </div>
                      {scoredFactors.length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-micro text-secondary">
                            Why this slice
                          </summary>
                          <div className="mt-1 space-y-1 text-micro text-secondary">
                            {scoredFactors.slice(0, 3).map((factor, factorIndex) => (
                              <p key={`${item.sliceId}-factor-${factorIndex}`}>
                                {(factor.label ?? factor.key ?? 'factor').replace(/_/g, ' ')}:{' '}
                                {formatMetric(factor.value, 2)}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        ) : (
          <div className="space-y-2">
            {orderedSlices.map((item, index) => {
              const rank =
                item.finalRank ??
                item.manualRank ??
                item.algorithmRank ??
                index + 1;
              const factors = item.iwmt?.factors ?? [];
              const scoredFactors = factors.filter(
                (factor) => typeof factor.value === 'number' && Number.isFinite(factor.value)
              );
              const hasRoi = typeof item.roiPerToken === 'number' && Number.isFinite(item.roiPerToken);
              const hasObjective =
                typeof item.objectiveScore === 'number' && Number.isFinite(item.objectiveScore);
              const runnerName = normalizeRunnerName(item);
              const subtitle = sliceSubtitle(item);
              return (
                <motion.article
                  initial={{ opacity: 0, y: 10, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{
                    duration: 0.22,
                    delay: Math.min(index, 7) * 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  key={item.sliceId}
                  className="group hover-lift relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/[0.14]"
                >
                  <div
                    className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${statusHighlight(item.status)}`}
                    aria-hidden
                  />
                  <div className="flex items-start gap-2">
                    <span className="rounded-md border border-lime/22 bg-lime/[0.08] px-1.5 py-0.5 text-micro font-semibold text-[#DFFFB5]">
                      #{rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start gap-1.5">
                        <EntityIcon type={item.level} size={11} className="mt-0.5 flex-shrink-0 opacity-80" />
                        <p className="min-w-0 flex-1 line-clamp-2 text-caption font-semibold leading-snug text-primary">
                          {sliceTitle(item)}
                        </p>
                      </div>
                      <p className="mt-1 inline-flex min-w-0 items-center gap-1 truncate text-micro text-secondary" title={subtitle}>
                        <span className="truncate">{subtitle}</span>
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                        <span className="chip text-micro">{levelLabel(item.level)}</span>
                        <span className="chip text-micro">{taskLoadLabel(item)}</span>
                        <span className="chip text-micro">Agent {runnerName}</span>
                        {hasRoi ? (
                          <span className="chip text-micro">ROI/token {formatMetric(item.roiPerToken, 3)}</span>
                        ) : null}
                        {hasObjective ? (
                          <span className="chip text-micro">Obj {formatMetric(item.objectiveScore, 2)}</span>
                        ) : null}
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]',
                            statusTone(item.status)
                          )}
                        >
                          {item.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {scoredFactors.length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-micro text-secondary">
                            Why this slice
                          </summary>
                          <div className="mt-1 space-y-1 text-micro text-secondary">
                            {scoredFactors.slice(0, 3).map((factor, factorIndex) => (
                              <p key={`${item.sliceId}-factor-static-${factorIndex}`}>
                                {(factor.label ?? factor.key ?? 'factor').replace(/_/g, ' ')}:{' '}
                                {formatMetric(factor.value, 2)}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                    {item.initiativeId && onOpenInitiative ? (
                      <button
                        type="button"
                        className="control-pill h-7 px-2 text-micro font-semibold"
                        onClick={() => openInitiative(item)}
                      >
                        Open
                      </button>
                    ) : null}
                  </div>
                </motion.article>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-strong px-3 py-2">
        <p className="text-micro text-secondary">
          {pageStart}-{pageEnd} of {visibleTotal}
        </p>
        <button
          type="button"
          className="control-pill ml-auto h-7 px-2 text-micro font-semibold disabled:opacity-40"
          disabled={visibleOffset === 0}
          onClick={() => setOffset(Math.max(0, visibleOffset - limit))}
        >
          Prev
        </button>
        <button
          type="button"
          className="control-pill h-7 px-2 text-micro font-semibold disabled:opacity-40"
          disabled={!(pagination?.hasMore ?? false)}
          onClick={() => setOffset(visibleOffset + limit)}
        >
          Next
        </button>
      </div>

      {notice && (
        <div className="border-t border-strong px-3 py-2">
          <InlineToast
            open
            tone={notice.tone === 'error' ? 'error' : 'success'}
            title={notice.tone === 'error' ? 'Slice explorer error' : 'Slice explorer updated'}
            message={notice.message}
            onDismiss={() => setNotice(null)}
            autoDismissMs={4200}
          />
        </div>
      )}
    </section>
  );
}
