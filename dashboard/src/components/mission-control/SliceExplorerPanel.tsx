import { Reorder } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { SearchInput } from '@/components/shared/SearchInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { InlineToast } from '@/components/shared/InlineToast';
import { useMissionControlSlices } from '@/hooks/useMissionControlSlices';
import { useMissionControlSliceOrdering } from '@/hooks/useMissionControlSliceOrdering';
import type {
  MissionControlSliceItem,
  MissionControlSliceLevel,
  MissionControlSliceOrderMode,
} from '@/types';
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
  return 'border-[#BFFF00]/24 bg-[#BFFF00]/[0.08] text-[#E8FFD0]/92';
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function sliceTitle(item: MissionControlSliceItem): string {
  if (item.title.trim().length > 0) return item.title;
  if (item.taskTitle?.trim()) return item.taskTitle.trim();
  if (item.milestoneTitle?.trim()) return item.milestoneTitle.trim();
  if (item.workstreamTitle?.trim()) return item.workstreamTitle.trim();
  if (item.initiativeTitle?.trim()) return item.initiativeTitle.trim();
  return item.sliceId;
}

function sliceSubtitle(item: MissionControlSliceItem): string {
  const parts = [
    item.initiativeTitle,
    item.workstreamTitle,
    item.milestoneTitle,
    item.taskTitle,
  ].filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
  if (parts.length === 0) return item.sliceId;
  return parts.join(' / ');
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
        message:
          error instanceof Error ? error.message : 'Failed to save slice order.',
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
        message:
          error instanceof Error
            ? error.message
            : `Failed to set ${nextMode} ordering.`,
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
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-[#BFFF00]/70" />
          <h3 className="text-caption font-semibold uppercase tracking-[0.1em] text-secondary">
            {title}
          </h3>
          <span className="ml-auto rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-micro text-secondary">
            {visibleTotal}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {LEVEL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setLevel(option.value)}
              className={cn(
                'control-pill h-8 px-2 text-micro font-semibold',
                level === option.value
                  ? 'border-[#BFFF00]/34 bg-[#BFFF00]/[0.12] text-[#E8FFD0]'
                  : 'text-secondary'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn(
              'control-pill h-8 px-2.5 text-micro font-semibold',
              effectiveOrderMode === 'manual'
                ? 'border-[#BFFF00]/34 bg-[#BFFF00]/[0.12] text-[#E8FFD0]'
                : 'text-secondary'
            )}
            disabled={ordering.isSettingOrderMode}
            onClick={() => applyOrderMode('manual')}
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
            onClick={() => applyOrderMode('algorithmic')}
          >
            Algorithmic
          </button>
          {effectiveOrderMode === 'manual' && (
            <button
              type="button"
              className="control-pill ml-auto h-8 px-2.5 text-micro font-semibold disabled:opacity-45"
              disabled={!manualOrderDirty || !canManualReorder}
              onClick={saveManualOrder}
            >
              Save order
            </button>
          )}
        </div>

        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search slices, entities, or IDs..."
        />

        {(source === 'local_fallback' || slicesQuery.degraded.length > 0) && (
          <div className="rounded-xl border border-amber-300/24 bg-amber-400/[0.08] px-2.5 py-2 text-micro text-amber-100/90">
            {source === 'local_fallback'
              ? 'Canonical slices unavailable; showing local fallback.'
              : slicesQuery.degraded[0]}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-2">
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
              return (
                <Reorder.Item
                  key={item.sliceId}
                  value={item.sliceId}
                  className="rounded-xl border border-strong bg-white/[0.03] px-3 py-2"
                >
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
                        <span className="rounded-md border border-[#BFFF00]/22 bg-[#BFFF00]/[0.08] px-1.5 py-0.5 text-micro font-semibold text-[#DFFFB5]">
                          #{rank}
                        </span>
                        <p className="min-w-0 flex-1 truncate text-caption font-medium text-primary">
                          {sliceTitle(item)}
                        </p>
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.08em]',
                            statusTone(item.status)
                          )}
                        >
                          {item.status}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-micro text-secondary">{sliceSubtitle(item)}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                        <span>ROI/token {formatMetric(item.roiPerToken, 3)}</span>
                        <span>Obj {formatMetric(item.objectiveScore, 2)}</span>
                        <span>Tokens {formatMetric(item.expectedTokens, 0)}</span>
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
                      {factors.length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-micro text-secondary">
                            IWMT factors
                          </summary>
                          <div className="mt-1 space-y-1 text-micro text-secondary">
                            {factors.slice(0, 4).map((factor, factorIndex) => (
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
              return (
                <article
                  key={item.sliceId}
                  className="rounded-xl border border-strong bg-white/[0.03] px-3 py-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="rounded-md border border-[#BFFF00]/22 bg-[#BFFF00]/[0.08] px-1.5 py-0.5 text-micro font-semibold text-[#DFFFB5]">
                      #{rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-caption font-medium text-primary">
                        {sliceTitle(item)}
                      </p>
                      <p className="mt-1 truncate text-micro text-secondary">{sliceSubtitle(item)}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                        <span>ROI/token {formatMetric(item.roiPerToken, 3)}</span>
                        <span>Obj {formatMetric(item.objectiveScore, 2)}</span>
                        <span>Tokens {formatMetric(item.expectedTokens, 0)}</span>
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]',
                            statusTone(item.status)
                          )}
                        >
                          {item.status}
                        </span>
                      </div>
                      {factors.length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-micro text-secondary">
                            IWMT factors
                          </summary>
                          <div className="mt-1 space-y-1 text-micro text-secondary">
                            {factors.slice(0, 4).map((factor, factorIndex) => (
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
                </article>
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
