import { memo, useMemo, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Initiative, SliceRunProjection } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { formatRelativeTime } from '@/lib/time';
import { humanizeId, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';

interface NeedsInputPanelProps {
  sliceRuns: SliceRunProjection[];
  initiatives?: Initiative[];
  title?: string;
  className?: string;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  onOpenDecisions?: () => void;
  onFocusRunId?: (runId: string) => void;
  onReviewActivity?: (sliceRun: SliceRunProjection) => void;
  onOpenSliceDetail?: (sliceRun: SliceRunProjection) => void;
  onAcceptSlice?: (sliceRun: SliceRunProjection, note?: string) => void;
}

const NEEDS_INPUT_STATES = new Set(['awaiting_input', 'needs_review', 'failed']);

export interface NeedsInputRow {
  item: SliceRunProjection;
  duplicateCount: number;
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeKey(item: SliceRunProjection): string {
  const initiativeId = item.initiativeId ?? item.initiativeIds?.[0] ?? 'none';
  const workstreamId = item.workstreamId ?? item.workstreamIds?.[0] ?? 'none';
  const explainer = (item.statusExplainer ?? '').trim().toLowerCase();
  return [initiativeId, workstreamId, item.status, item.primaryAction, explainer].join('|');
}

export function selectNeedsInputRows(sliceRuns: SliceRunProjection[]): NeedsInputRow[] {
  const filtered = sliceRuns
    .filter((item) => NEEDS_INPUT_STATES.has(item.status))
    .sort((a, b) => toEpoch(b.updatedAt ?? b.lastEventAt ?? '') - toEpoch(a.updatedAt ?? a.lastEventAt ?? ''));

  const grouped = new Map<string, NeedsInputRow>();
  for (const item of filtered) {
    const key = dedupeKey(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { item, duplicateCount: 1 });
      continue;
    }
    existing.duplicateCount += 1;
  }

  return Array.from(grouped.values());
}

function statusAccentColor(status: SliceRunProjection['status']): string {
  if (status === 'failed') return '#FF6B88';
  if (status === 'needs_review') return '#F5B700';
  return '#BFFF00';
}

function statusLabel(status: SliceRunProjection['status']): string {
  if (status === 'awaiting_input') return 'Input';
  if (status === 'needs_review') return 'Review';
  if (status === 'failed') return 'Failed';
  return status.replace(/_/g, ' ');
}

function valueSummary(item: SliceRunProjection): string {
  if (item.artifactCount > 0) {
    return `${item.artifactCount} artifact${item.artifactCount === 1 ? '' : 's'} ready`;
  }
  if (item.blockingDecisionCount > 0 || item.decisionCount > 0) {
    const count = Math.max(item.blockingDecisionCount, item.decisionCount);
    return `${count} decision${count === 1 ? '' : 's'} pending`;
  }
  if (item.status === 'failed') return 'Execution stopped';
  if (item.status === 'needs_review') return 'Output ready for review';
  return 'Needs your attention';
}

function compactEntityLabel(value: string | null | undefined, prefix: string): string {
  if (!value || value.trim().length === 0) return prefix;
  const trimmed = value.trim();
  return isOpaqueId(trimmed)
    ? `${prefix} ${humanizeId(trimmed)}`
    : trimmed;
}

function summarizeExplainer(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = sanitizeDisplayText(value);
  if (!cleaned || cleaned.length < 12) return null;
  return cleaned.length > 96 ? `${cleaned.slice(0, 93)}…` : cleaned;
}

function derivePrimaryLabel(
  item: SliceRunProjection,
  preferredLabel: string | null,
  fallbackWorkstreamId: string | null
): string {
  const preferredRaw = preferredLabel?.trim() ?? '';
  if (preferredRaw && !isOpaqueId(preferredRaw)) {
    const safePreferred = sanitizeDisplayText(preferredRaw);
    if (safePreferred && safePreferred !== 'Untitled session') return safePreferred;
  }

  const explainerSummary = summarizeExplainer(item.statusExplainer);
  if (explainerSummary) return explainerSummary;

  if (fallbackWorkstreamId) {
    return compactEntityLabel(fallbackWorkstreamId, 'Workstream');
  }
  return compactEntityLabel(item.sliceRunId, 'Slice');
}

export const NeedsInputPanel = memo(function NeedsInputPanel({
  sliceRuns,
  initiatives = [],
  title = 'Needs Input',
  className,
  showHeader = true,
  panelStyle = 'card',
  onOpenDecisions,
  onFocusRunId,
  onReviewActivity,
  onOpenSliceDetail,
  onAcceptSlice,
}: NeedsInputPanelProps) {
  const rows = useMemo(() => selectNeedsInputRows(sliceRuns), [sliceRuns]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  const initiativeTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const initiative of initiatives) {
      if (!initiative.id) continue;
      map.set(initiative.id, initiative.name ?? initiative.id);
    }
    return map;
  }, [initiatives]);
  const workstreamTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const initiative of initiatives) {
      for (const workstream of initiative.workstreams ?? []) {
        if (!workstream.id) continue;
        if (!map.has(workstream.id)) {
          map.set(workstream.id, workstream.name ?? workstream.id);
        }
      }
    }
    return map;
  }, [initiatives]);

  const toggleSelect = useCallback((sliceRunId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sliceRunId)) next.delete(sliceRunId);
      else next.add(sliceRunId);
      return next;
    });
  }, []);

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.has(r.item.sliceRunId)),
    [rows, selected]
  );

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set(rows.map((r) => r.item.sliceRunId));
    });
  }, [allSelected, rows]);

  const selectedCount = selected.size;

  const acceptOne = useCallback((item: SliceRunProjection, note?: string) => {
    if (!onAcceptSlice) return;
    const id = item.sliceRunId;
    setPending((prev) => new Set(prev).add(id));
    // Fire the async action; the parent refetch will remove from list
    Promise.resolve(onAcceptSlice(item, note)).finally(() => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }, [onAcceptSlice]);

  const handleBulkAccept = useCallback(() => {
    if (!onAcceptSlice) return;
    for (const row of rows) {
      if (selected.has(row.item.sliceRunId) && row.item.status === 'needs_review') {
        acceptOne(row.item);
      }
    }
    setSelected(new Set());
  }, [onAcceptSlice, rows, selected, acceptOne]);

  const runPrimaryAction = useCallback((item: SliceRunProjection, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.primaryAction === 'resolve_decision') {
      onOpenDecisions?.();
      return;
    }
    if (item.primaryAction === 'review_output' || item.primaryAction === 'retry_slice') {
      onReviewActivity?.(item);
      return;
    }
    if (item.primaryAction === 'open_artifact') {
      const firstUrl = item.artifacts.find((artifact) => artifact.url)?.url;
      if (firstUrl && typeof window !== 'undefined') {
        window.open(firstUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      onReviewActivity?.(item);
      return;
    }
    if (item.runId) {
      onFocusRunId?.(item.runId);
      return;
    }
    if (item.sliceRunId) {
      onFocusRunId?.(item.sliceRunId);
    }
  }, [onOpenDecisions, onReviewActivity, onFocusRunId]);

  const reviewRows = useMemo(() => rows.filter((r) => r.item.status === 'needs_review'), [rows]);
  const selectedReviewCount = useMemo(
    () => reviewRows.filter((r) => selected.has(r.item.sliceRunId)).length,
    [reviewRows, selected]
  );

  const Wrapper = panelStyle === 'card' ? PremiumCard : 'div';

  return (
    <Wrapper
      className={`flex h-full min-h-0 flex-col overflow-hidden ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-body font-semibold text-white/90">{title}</h2>
            <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-white/40">
              {rows.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {rows.length > 1 && (
              <button
                type="button"
                onClick={toggleSelectAll}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/60"
              >
                {allSelected ? 'Clear' : 'Select all'}
              </button>
            )}
            {selectedCount > 0 && selectedReviewCount > 0 && onAcceptSlice && (
              <button
                type="button"
                disabled={pending.size > 0}
                onClick={handleBulkAccept}
                className="rounded-md bg-[#BFFF00]/10 px-2.5 py-1 text-[11px] font-semibold text-[#BFFF00] transition-colors hover:bg-[#BFFF00]/18 disabled:opacity-40 disabled:pointer-events-none"
              >
                {pending.size > 0 ? 'Accepting...' : `Accept ${selectedReviewCount}`}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-caption text-white/30">
          Nothing needs attention right now.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="popLayout">
            {rows.map(({ item, duplicateCount }, index) => {
              const primaryInitiativeId =
                (Array.isArray(item.initiativeIds) && item.initiativeIds.length > 0
                  ? item.initiativeIds[0]
                  : item.initiativeId) ?? null;
              const primaryWorkstreamId =
                (Array.isArray(item.workstreamIds) && item.workstreamIds.length > 0
                  ? item.workstreamIds[0]
                  : item.workstreamId) ?? null;
              const initiativeLabel =
                (primaryInitiativeId
                  ? initiativeTitleById.get(primaryInitiativeId)
                  : null) ?? compactEntityLabel(primaryInitiativeId, 'Initiative');
              const workstreamLabel =
                item.workstreamTitle ??
                (primaryWorkstreamId
                  ? workstreamTitleById.get(primaryWorkstreamId) ?? null
                  : null);
              const label = derivePrimaryLabel(item, workstreamLabel, primaryWorkstreamId);
              const summaryText = sanitizeDisplayText(valueSummary(item));
              const initiativeText = sanitizeDisplayText(initiativeLabel);
              const when = item.updatedAt ?? item.lastEventAt ?? null;
              const accent = statusAccentColor(item.status);
              const isSelected = selected.has(item.sliceRunId);
              const isPending = pending.has(item.sliceRunId);
              const isReview = item.status === 'needs_review';

              return (
                <motion.article
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 120, scale: 0.97 }}
                  transition={{
                    duration: 0.2,
                    delay: Math.min(index, 5) * 0.015,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  layout
                  key={item.sliceRunId}
                  className="group relative cursor-pointer border-b border-white/[0.04] transition-colors hover:bg-white/[0.02]"
                  style={{
                    backgroundColor: isSelected ? 'rgba(191,255,0,0.03)' : undefined,
                    opacity: isPending ? 0.5 : undefined,
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenSliceDetail?.(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenSliceDetail?.(item);
                    }
                  }}
                >
                  {/* Left accent — 2px strip */}
                  <div
                    className="absolute left-0 top-0 bottom-0 w-[2px]"
                    style={{ backgroundColor: `${accent}50` }}
                  />

                  <div className="flex items-start gap-2.5 py-2.5 pl-4 pr-3">
                    {/* Checkbox — compact */}
                    <div
                      className="flex-shrink-0 pt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.sliceRunId)}
                        className="h-3 w-3 rounded-sm border-white/15 bg-transparent text-[#BFFF00] focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      {/* Line 1: status dot + label + time */}
                      <div className="flex items-center gap-2">
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: accent }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-white/90">
                          {label}
                        </span>
                        <span className="flex-shrink-0 text-[10px] tabular-nums text-white/25">
                          {when ? formatRelativeTime(when) : statusLabel(item.status)}
                        </span>
                      </div>

                      {/* Line 2: summary + meta */}
                      <div className="mt-0.5 flex items-baseline gap-1.5 pl-[14px]">
                        <span className="min-w-0 truncate text-[11px] leading-relaxed text-white/35">
                          {summaryText}
                        </span>
                        {duplicateCount > 1 && (
                          <span className="flex-shrink-0 text-[10px] text-white/20">
                            +{duplicateCount - 1}
                          </span>
                        )}
                      </div>

                      {/* Line 3: initiative */}
                      <div className="mt-px flex items-center gap-1 pl-[14px] text-[10px] text-white/20">
                        <EntityIcon type="initiative" size={8} className="opacity-50" />
                        <span className="truncate">{initiativeText}</span>
                      </div>
                    </div>

                    {/* Action — appears on hover, accept is always hinted for review */}
                    <div
                      className="flex flex-shrink-0 items-center gap-1 self-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isReview && onAcceptSlice ? (
                        <button
                          type="button"
                          disabled={pending.has(item.sliceRunId)}
                          onClick={(e) => {
                            e.stopPropagation();
                            acceptOne(item);
                          }}
                          className="flex h-6 items-center gap-1 rounded-md bg-[#BFFF00]/8 px-2 text-[11px] font-medium text-[#BFFF00]/70 transition-all hover:bg-[#BFFF00]/15 hover:text-[#BFFF00] disabled:opacity-40 disabled:pointer-events-none"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          {pending.has(item.sliceRunId) ? 'Accepting...' : 'Accept'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => runPrimaryAction(item, e)}
                          className="flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-white/30 opacity-0 transition-all group-hover:opacity-100 hover:bg-white/[0.04] hover:text-white/50"
                        >
                          {item.status === 'failed' ? 'Retry' : 'View'}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </Wrapper>
  );
});
