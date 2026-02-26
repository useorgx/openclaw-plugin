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
  onAcceptSlice?: (sliceRun: SliceRunProjection) => void;
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
  if (status === 'awaiting_input') return 'Needs input';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'failed') return 'Failed';
  return status.replace(/_/g, ' ');
}

function actionLabel(item: SliceRunProjection): string {
  if (item.primaryAction === 'resolve_decision') return 'Review choices';
  if (item.primaryAction === 'open_artifact') return 'Open result';
  if (item.primaryAction === 'retry_slice') return 'Retry';
  if (item.primaryAction === 'review_output') return 'Review';
  return 'Details';
}

function valueSummary(item: SliceRunProjection): string {
  if (item.artifactCount > 0) {
    return `${item.artifactCount} artifact${item.artifactCount === 1 ? '' : 's'} ready to review.`;
  }
  if (item.blockingDecisionCount > 0 || item.decisionCount > 0) {
    const count = Math.max(item.blockingDecisionCount, item.decisionCount);
    return `${count} decision${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your input.`;
  }
  if (item.status === 'failed') return 'Execution stopped before finishing.';
  if (item.status === 'needs_review') return 'Output is available and needs a quick review.';
  return 'This work needs your attention to continue.';
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

  const handleBulkAccept = useCallback(() => {
    if (!onAcceptSlice) return;
    for (const row of rows) {
      if (selected.has(row.item.sliceRunId) && row.item.status === 'needs_review') {
        onAcceptSlice(row.item);
      }
    }
    setSelected(new Set());
  }, [onAcceptSlice, rows, selected]);

  const runPrimaryAction = (item: SliceRunProjection) => {
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
  };

  // Group rows by status for visual scanning
  const reviewRows = useMemo(() => rows.filter((r) => r.item.status === 'needs_review'), [rows]);
  const failedRows = useMemo(() => rows.filter((r) => r.item.status === 'failed'), [rows]);
  const inputRows = useMemo(() => rows.filter((r) => r.item.status === 'awaiting_input'), [rows]);
  const selectedReviewCount = useMemo(
    () => reviewRows.filter((r) => selected.has(r.item.sliceRunId)).length,
    [reviewRows, selected]
  );

  const Wrapper = panelStyle === 'card' ? PremiumCard : 'div';

  return (
    <Wrapper
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        panelStyle === 'flat' ? '' : ''
      } ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip text-micro">{rows.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {rows.length > 0 && (
              <button
                type="button"
                onClick={toggleSelectAll}
                className="control-pill h-7 px-2.5 text-micro font-semibold"
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            )}
            {selectedCount > 0 && selectedReviewCount > 0 && onAcceptSlice && (
              <button
                type="button"
                onClick={handleBulkAccept}
                className="control-pill h-7 px-2.5 text-micro font-semibold"
                data-tone="teal"
              >
                Accept {selectedReviewCount} reviewed
              </button>
            )}
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-4 py-4 text-body text-secondary">
          No slices need intervention right now.
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

              return (
                <motion.article
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 200, scale: 0.95 }}
                  transition={{
                    duration: 0.22,
                    delay: Math.min(index, 7) * 0.02,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  layout
                  key={item.sliceRunId}
                  className="group flex items-start gap-3 border-b border-white/[0.04] px-4 py-3 transition-colors hover:bg-white/[0.02] cursor-pointer"
                  style={{
                    borderLeftWidth: 3,
                    borderLeftColor: `${accent}60`,
                    backgroundColor: isSelected ? 'rgba(191,255,0,0.04)' : undefined,
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
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(item.sliceRunId)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 h-3.5 w-3.5 flex-shrink-0 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                  />

                  {/* Content — flat, no nested card */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex min-w-0 items-center gap-1.5 text-body font-semibold leading-snug text-white">
                          <span className="line-clamp-1">{label}</span>
                        </p>
                        <p className="mt-0.5 text-caption text-secondary line-clamp-1">
                          {summaryText}
                        </p>
                      </div>
                      <span
                        className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{
                          color: accent,
                          backgroundColor: `${accent}18`,
                          borderWidth: 1,
                          borderColor: `${accent}30`,
                        }}
                      >
                        {statusLabel(item.status)}
                      </span>
                    </div>

                    {/* Meta row — flat inline */}
                    <div className="mt-1.5 flex items-center gap-2 text-micro text-muted">
                      <span className="flex items-center gap-1 truncate">
                        <EntityIcon type="initiative" size={9} className="opacity-70" />
                        {initiativeText}
                      </span>
                      {duplicateCount > 1 && (
                        <span className="text-micro text-muted">
                          +{duplicateCount - 1} similar
                        </span>
                      )}
                      {when && <span>{formatRelativeTime(when)}</span>}
                    </div>
                  </div>

                  {/* Inline actions — no border, no card */}
                  <div
                    className="flex flex-shrink-0 items-center gap-1.5 self-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.status === 'needs_review' && onAcceptSlice && (
                      <button
                        type="button"
                        onClick={() => onAcceptSlice(item)}
                        className="rounded-md border border-lime/25 bg-lime/10 px-2 py-1 text-micro font-semibold text-lime transition-colors hover:bg-lime/20"
                      >
                        Accept
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => runPrimaryAction(item)}
                      className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-micro font-semibold text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      {actionLabel(item)}
                    </button>
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
