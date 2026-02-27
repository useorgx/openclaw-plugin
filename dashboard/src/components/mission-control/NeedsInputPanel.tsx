import { memo, useMemo, useState, useCallback, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type {
  Initiative,
  SliceRunProjection,
  LiveTriageItem,
  TriageSeverity,
  TriageActionType,
} from '@/types';
import type { DedupedTriageGroup } from '@/hooks/useTriageQueue';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { formatRelativeTime } from '@/lib/time';
import { humanizeId, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';

interface NeedsInputPanelProps {
  sliceRuns: SliceRunProjection[];
  initiatives?: Initiative[];
  /** Optional triage groups from useTriageQueue for blocker/decision display. */
  triageGroups?: DedupedTriageGroup[];
  /** Called when a triage action button is clicked. */
  onTriageAction?: (itemId: string, action: string) => void;
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

// ---------------------------------------------------------------------------
// Severity helpers for triage items
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<TriageSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function severityBorderClass(severity: TriageSeverity): string {
  if (severity === 'critical' || severity === 'high') return 'border-l-4 border-l-[#FF6B88]';
  if (severity === 'medium') return 'border-l-4 border-l-[#F5B700]';
  return 'border-l-4 border-l-white/20';
}

/** Infer severity from a triage item when the field is missing. */
function inferSeverity(item: LiveTriageItem): TriageSeverity {
  if (item.severity) return item.severity;
  const totalImpact =
    (item.impact?.initiativeCount ?? 0) +
    (item.impact?.workstreamCount ?? 0) +
    (item.impact?.downstreamBlockedCount ?? 0);
  if (item.blocking || totalImpact >= 3) return 'high';
  if (item.kind === 'review_required') return 'low';
  return 'medium';
}

function triageActionLabel(action: TriageActionType | string): string {
  if (action === 'approve') return 'Approve';
  if (action === 'reject') return 'Reject';
  if (action === 'retry') return 'Retry';
  if (action === 'autofix') return 'Autofix';
  if (action === 'defer') return 'Defer';
  if (action === 'snooze') return 'Snooze';
  if (action === 'dismiss') return 'Dismiss';
  // Map common semantic types from the spec
  if (action === 'choose') return 'Choose Option';
  if (action === 'provide_info') return 'Provide Info';
  if (action === 'review') return 'Review';
  return 'Resolve';
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
  triageGroups = [],
  onTriageAction,
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
  const allRows = useMemo(() => selectNeedsInputRows(sliceRuns), [sliceRuns]);
  const [optimisticallyAccepted, setOptimisticallyAccepted] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [resolvingItems, setResolvingItems] = useState<Set<string>>(new Set());

  // Reset optimistic state when fresh data arrives
  useEffect(() => {
    setOptimisticallyAccepted(new Set());
  }, [sliceRuns]);

  const rows = useMemo(
    () => allRows.filter((r) => !optimisticallyAccepted.has(r.item.sliceRunId)),
    [allRows, optimisticallyAccepted],
  );

  // Sort triage groups: high severity first, then medium, then low. Within same severity, newest first.
  const sortedTriageGroups = useMemo(() => {
    if (!triageGroups || triageGroups.length === 0) return [];
    return [...triageGroups].sort((a, b) => {
      const sevA = SEVERITY_ORDER[inferSeverity(a.item)] ?? 3;
      const sevB = SEVERITY_ORDER[inferSeverity(b.item)] ?? 3;
      if (sevA !== sevB) return sevA - sevB;
      return (
        new Date(b.item.lastSeenAt).getTime() -
        new Date(a.item.lastSeenAt).getTime()
      );
    });
  }, [triageGroups]);

  const toggleGroupExpanded = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const handleTriageAction = useCallback(
    async (itemId: string, action: string) => {
      setResolvingItems((prev) => new Set(prev).add(itemId));
      setLastAction(`Resolving ${itemId.slice(0, 8)}...`);
      try {
        await onTriageAction?.(itemId, action);
        setLastAction(`Resolved ${itemId.slice(0, 8)}`);
      } catch {
        setLastAction(`Failed to resolve ${itemId.slice(0, 8)}`);
      } finally {
        // Keep in resolving state briefly for exit animation
        setTimeout(() => {
          setResolvingItems((prev) => {
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        }, 400);
      }
    },
    [onTriageAction]
  );

  const totalCount = rows.length + sortedTriageGroups.length;

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

  const acceptOne = useCallback(async (item: SliceRunProjection, note?: string) => {
    const id = item.sliceRunId ?? item.id ?? '';
    try {
      setLastAction(`Accepting ${id.slice(0, 8)}…`);
      setPending((prev) => new Set(prev).add(id));

      // Delegate to parent callback which calls the API and triggers refetch
      try { await onAcceptSlice?.(item, note); } catch { /* ignore */ }
      setOptimisticallyAccepted((prev) => new Set(prev).add(id));
      setLastAction(`Accepted ${id.slice(0, 8)}`);
    } catch (err) {
      setLastAction(`Failed: ${err instanceof Error ? err.message : 'network error'}`);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [onAcceptSlice]);

  const handleBulkAccept = useCallback(() => {
    const reviewable = rows.filter(
      (r) => selected.has(r.item.sliceRunId) && r.item.status === 'needs_review'
    );
    if (reviewable.length === 0) return;
    setLastAction(`Accepting ${reviewable.length} items…`);
    for (const row of reviewable) {
      acceptOne(row.item);
    }
    setSelected(new Set());
  }, [rows, selected, acceptOne]);

  const runPrimaryAction = useCallback((item: SliceRunProjection) => {
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
              {totalCount}
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

      {/* Inline action indicator — visible proof that handlers fire */}
      {lastAction && (
        <div className="flex items-center gap-1.5 border-b border-white/[0.04] px-4 py-1 text-[10px] text-[#0AD4C4]/70 animate-pulse">
          <span className="h-1 w-1 rounded-full bg-[#0AD4C4]" />
          {lastAction}
        </div>
      )}

      {totalCount === 0 ? (
        <div className="px-4 py-6 text-center text-caption text-white/30">
          Nothing needs attention right now.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* ── Triage blocker / decision cards ── */}
          {sortedTriageGroups.length > 0 && (
            <AnimatePresence mode="popLayout">
              {sortedTriageGroups.map((group, groupIndex) => {
                const triageItem = group.item;
                const severity = inferSeverity(triageItem);
                const borderClass = severityBorderClass(severity);
                const isExpanded = expandedGroups.has(triageItem.id);
                const isResolving = resolvingItems.has(triageItem.id);
                const primaryAction = triageItem.actionContract.find((a) => a.available);

                return (
                  <motion.div
                    key={triageItem.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: isResolving ? 0.4 : 1, y: 0 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      type: 'spring',
                      stiffness: 400,
                      damping: 35,
                      delay: Math.min(groupIndex, 5) * 0.015,
                    }}
                    className={`${borderClass} border-b border-b-white/[0.06] bg-[#08090D] px-4 py-3 transition-colors hover:bg-white/[0.02]`}
                  >
                    {/* Title row */}
                    <div className="flex items-center gap-2">
                      <span
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            severity === 'critical' || severity === 'high'
                              ? '#FF6B88'
                              : severity === 'medium'
                                ? '#F5B700'
                                : 'rgba(255,255,255,0.35)',
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-white/90">
                        {triageItem.title}
                      </span>
                      <span className="flex-shrink-0 text-[10px] tabular-nums text-white/25">
                        {formatRelativeTime(triageItem.lastSeenAt)}
                      </span>
                    </div>

                    {/* Context / summary */}
                    {triageItem.summary && (
                      <div className="mt-1 pl-[14px] text-[11px] text-white/50">
                        {triageItem.summary.length > 120
                          ? `${triageItem.summary.slice(0, 117)}...`
                          : triageItem.summary}
                      </div>
                    )}

                    {/* Scope context (initiative / workstream) */}
                    {(triageItem.initiativeTitle || triageItem.workstreamTitle) && (
                      <div className="mt-px flex items-center gap-1 pl-[14px] text-[10px] text-white/20">
                        {triageItem.initiativeTitle && (
                          <>
                            <EntityIcon type="initiative" size={8} className="opacity-50" />
                            <span className="truncate">{triageItem.initiativeTitle}</span>
                          </>
                        )}
                        {triageItem.initiativeTitle && triageItem.workstreamTitle && (
                          <span className="text-white/10">/</span>
                        )}
                        {triageItem.workstreamTitle && (
                          <span className="truncate">{triageItem.workstreamTitle}</span>
                        )}
                      </div>
                    )}

                    {/* Duplicate grouping badge */}
                    {group.count > 1 && (
                      <button
                        type="button"
                        onClick={() => toggleGroupExpanded(triageItem.id)}
                        className="mt-1.5 ml-[14px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 text-[10px] font-mono text-white/50 hover:bg-white/8 transition-colors"
                      >
                        {group.count} similar
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    )}

                    {/* Expanded duplicates */}
                    <AnimatePresence>
                      {isExpanded && group.members.length > 1 && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                          className="mt-1.5 ml-[14px] overflow-hidden"
                        >
                          {group.members.slice(1).map((member) => (
                            <div
                              key={member.id}
                              className="border-l border-white/[0.06] pl-2 py-1 text-[11px] text-white/35"
                            >
                              <span className="truncate">{member.title}</span>
                              <span className="ml-2 text-[10px] text-white/20">
                                {formatRelativeTime(member.lastSeenAt)}
                              </span>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Action row */}
                    {onTriageAction && (
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.06]">
                        {primaryAction && (
                          <button
                            type="button"
                            disabled={isResolving}
                            onClick={() => handleTriageAction(triageItem.id, primaryAction.action)}
                            className="px-3 py-1 rounded-full text-[11px] font-medium bg-[#BFFF00]/10 text-[#BFFF00] border border-[#BFFF00]/20 hover:bg-[#BFFF00]/20 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                          >
                            {triageActionLabel(primaryAction.action)}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isResolving}
                          onClick={() => handleTriageAction(triageItem.id, 'dismiss')}
                          className="px-3 py-1 rounded-full text-[11px] font-medium border border-white/10 text-white/50 hover:text-white/70 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}

          {/* ── Existing slice-run rows ── */}
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
                  key={item.sliceRunId}
                  className="group relative cursor-pointer border-b border-subtle transition-colors hover:bg-white/[0.02]"
                  style={{
                    backgroundColor: isSelected ? 'rgba(191,255,0,0.03)' : undefined,
                    opacity: isPending ? 0.5 : undefined,
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    // Only open detail if clicked on the row content (not buttons/checkbox)
                    const target = e.target as HTMLElement;
                    if (target.closest('button, input, [data-stop-row]')) return;
                    setLastAction(`Opening detail…`);
                    onOpenSliceDetail?.(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenSliceDetail?.(item);
                    }
                  }}
                >
                  <div className="flex items-start gap-2 py-2.5 pl-2.5 pr-2.5 sm:gap-2.5 sm:pl-3 sm:pr-3">
                    {/* Checkbox — compact */}
                    <div className="flex-shrink-0 pt-0.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.sliceRunId)}
                        className="h-4 w-4 rounded-sm border-white/15 bg-transparent text-[#BFFF00] focus:ring-0 focus:ring-offset-0 cursor-pointer"
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
                        <span className="hidden sm:inline flex-shrink-0 text-[10px] tabular-nums text-white/25">
                          {when ? formatRelativeTime(when) : statusLabel(item.status)}
                        </span>
                      </div>

                      {/* Line 2: summary + meta */}
                      <div className="mt-0.5 flex items-baseline gap-1 sm:gap-1.5 pl-3 sm:pl-[14px] overflow-hidden">
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
                      <div className="mt-px flex items-center gap-1 pl-3 sm:pl-[14px] text-[10px] text-white/20 overflow-hidden">
                        <EntityIcon type="initiative" size={8} className="opacity-50" />
                        <span className="truncate">{initiativeText}</span>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-shrink-0 items-center gap-1 self-center">
                      {isReview && onAcceptSlice ? (
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => acceptOne(item)}
                          className="flex h-6 items-center gap-0.5 sm:gap-1 rounded-md bg-[#BFFF00]/8 px-1.5 sm:px-2 text-[11px] font-medium text-[#BFFF00]/70 transition-all hover:bg-[#BFFF00]/15 hover:text-[#BFFF00] disabled:opacity-40"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          {isPending ? 'Accepting...' : 'Accept'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => runPrimaryAction(item)}
                          className="flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-white/45 opacity-100 transition-all md:opacity-0 md:group-hover:opacity-100 hover:bg-white/[0.04] hover:text-white/70"
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
