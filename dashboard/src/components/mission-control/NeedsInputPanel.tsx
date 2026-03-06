import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { Initiative, SliceRunProjection } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { formatRelativeTime } from '@/lib/time';
import { humanizeId, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { EmptyState } from '@/components/shared/EmptyState';

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
  return item.sliceRunId;
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

function statusTone(status: SliceRunProjection['status']): string {
  if (status === 'failed') return 'border-red-400/30 bg-red-500/[0.10] text-red-100';
  if (status === 'needs_review') return 'border-amber-300/30 bg-amber-300/[0.10] text-amber-100';
  return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
}

function statusLabel(status: SliceRunProjection['status']): string {
  if (status === 'awaiting_input') return 'Needs input';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'failed') return 'Failed';
  return status.replace(/_/g, ' ');
}

function statusHighlight(status: SliceRunProjection['status']): string {
  if (status === 'failed') return 'from-red-300/0 via-red-300/65 to-red-300/0';
  if (status === 'needs_review') return 'from-amber-300/0 via-amber-300/65 to-amber-300/0';
  return 'from-[#BFFF00]/0 via-[#BFFF00]/70 to-[#BFFF00]/0';
}

function actionLabel(item: SliceRunProjection): string {
  if (item.primaryAction === 'resolve_decision') return 'Review choices';
  if (item.primaryAction === 'open_artifact') return 'Open result';
  if (item.primaryAction === 'retry_slice') return 'Review and retry';
  if (item.primaryAction === 'review_output') return 'Review activity';
  return 'Open details';
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
}: NeedsInputPanelProps) {
  const rows = useMemo(() => selectNeedsInputRows(sliceRuns), [sliceRuns]);
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

  return (
    <PremiumCard
      surface={panelStyle === 'card'}
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        panelStyle === 'flat' ? '!rounded-none !border-none !bg-transparent !shadow-none' : ''
      } ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip text-micro">{rows.length}</span>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          headline="No slices need attention"
          description="All workstreams are running smoothly. Decisions will appear here when agents need your input."
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
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
            const subtitle =
              item.statusExplainer?.trim().length
                ? item.statusExplainer
                : 'Review this slice to continue execution.';
            const summaryText = sanitizeDisplayText(valueSummary(item));
            const subtitleText = sanitizeDisplayText(subtitle);
            const initiativeText = sanitizeDisplayText(initiativeLabel);
            const scopeText = item.scope ? item.scope.replace(/_/g, ' ') : null;
            const when = item.updatedAt ?? item.lastEventAt ?? null;
            return (
              <motion.article
                initial={{ opacity: 0, y: 10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  duration: 0.24,
                  delay: Math.min(index, 7) * 0.022,
                  ease: [0.22, 1, 0.36, 1],
                }}
                key={item.sliceRunId}
                className={`group hover-lift relative overflow-visible rounded-2xl border bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/[0.14] ${
                  item.status === 'failed'
                    ? 'border-red-400/20'
                    : item.blockingDecisionCount > 0
                      ? 'border-amber-400/20'
                      : 'border-white/[0.08]'
                }`}
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
                  <div
                    className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${statusHighlight(item.status)}`}
                    aria-hidden
                  />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                      <p className="inline-flex min-w-0 items-center gap-1 text-micro uppercase tracking-[0.08em] text-muted">
                        <EntityIcon type="initiative" size={10} className="flex-shrink-0 opacity-80" />
                        <span className="truncate">{initiativeText}</span>
                      </p>
                      <p className="mt-0.5 inline-flex min-w-0 items-start gap-1.5 text-body font-semibold leading-snug text-white" title={label}>
                        <EntityIcon type="workstream" size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                        <span className="line-clamp-2">{label}</span>
                      </p>
                      <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={summaryText}>
                        {summaryText}
                      </p>
                      {subtitleText && subtitleText !== summaryText && (
                        <p className="mt-1 line-clamp-2 text-micro leading-snug text-muted" title={subtitleText}>
                          {subtitleText}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                      <span
                        className={`inline-flex h-6 items-center rounded-full border px-2 text-micro font-semibold uppercase tracking-[0.08em] ${statusTone(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                      {scopeText ? (
                        <span className="chip text-micro capitalize">{scopeText}</span>
                      ) : null}
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                  {duplicateCount > 1 && (
                    <span className="chip text-micro">
                      {duplicateCount} similar updates
                    </span>
                  )}
                  {typeof item.blockingDecisionCount === 'number' && item.blockingDecisionCount > 0 && (
                    <span className="chip text-micro border-red-400/30 bg-red-500/[0.1] text-red-200/90">
                      Blocks {item.blockingDecisionCount} task{item.blockingDecisionCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {typeof item.decisionCount === 'number' && item.decisionCount > 0 && (
                    <span className="chip text-micro">{item.decisionCount} decision{item.decisionCount === 1 ? '' : 's'}</span>
                  )}
                  {typeof item.artifactCount === 'number' && item.artifactCount > 0 && (
                    <span className="chip text-micro">{item.artifactCount} artifact{item.artifactCount === 1 ? '' : 's'}</span>
                  )}
                  {when && <span>Updated {formatRelativeTime(when)}</span>}
                </div>
                {/* Quick decision options */}
                {item.decisionOptions && item.decisionOptions.length > 0 && item.decisionOptions.length <= 3 && (
                  <div className="mt-2 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
                    {item.decisionOptions.slice(0, 3).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onOpenSliceDetail?.(item)}
                        className="chip text-micro font-medium hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title={option.description ?? option.label}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => onOpenSliceDetail?.(item)}
                    className="control-pill h-7 px-2.5 text-micro font-semibold"
                  >
                    Details
                  </button>
                  <button
                    type="button"
                    onClick={() => runPrimaryAction(item)}
                    className="control-pill h-7 px-2.5 text-micro font-semibold"
                    data-tone={item.status === 'failed' ? 'teal' : undefined}
                  >
                    {actionLabel(item)}
                  </button>
                </div>
              </motion.article>
            );
          })}
        </div>
      )}
    </PremiumCard>
  );
});
