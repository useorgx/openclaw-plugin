import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { DecisionMutationState, LiveDecision } from '@/types';
import { formatDurationWithUrgency } from '@/lib/time';
import { colors } from '@/lib/tokens';
import { cn } from '@/lib/utils';
import { humanizeWarning } from '@/lib/humanize';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { DecisionDetailModal } from '@/components/decisions/DecisionDetailModal';

const PAGE_SIZE = 40;

interface DecisionActionSummary {
  updated: number;
  failed: number;
  firstError?: string;
}

interface DecisionActionInput {
  note?: string;
  optionId?: string;
}

function formatDecisionError(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  const message = humanizeWarning(raw.trim());
  return message || fallback;
}

function formatDecisionFailureNotice(
  action: 'approve' | 'reject',
  failed: number,
  firstError?: string
): string {
  const fallback =
    action === 'approve'
      ? `Approval failed for ${failed} decision${failed === 1 ? '' : 's'}.`
      : `Rejection failed for ${failed} decision${failed === 1 ? '' : 's'}.`;
  return formatDecisionError(firstError, fallback);
}

interface DecisionCluster {
  key: string;
  representative: LiveDecision;
  decisions: LiveDecision[];
  duplicateCount: number;
}

interface DecisionQueueProps {
  decisions: LiveDecision[];
  focusDecisionId?: string | null;
  onFocusDecisionHandled?: (decisionId: string) => void;
  onApproveDecision: (
    decisionId: string,
    input?: DecisionActionInput
  ) => Promise<DecisionActionSummary>;
  onRejectDecision?: (
    decisionId: string,
    input?: DecisionActionInput
  ) => Promise<DecisionActionSummary>;
  onApproveAll: () => Promise<DecisionActionSummary>;
  onBulkDecisionAction?: (
    decisionIds: string[],
    action: 'approve' | 'reject',
    note?: string
  ) => Promise<DecisionActionSummary>;
  mutationState?: DecisionMutationState;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  className?: string;
  /** Map of initiativeId -> display name for group headers. Falls back to shortened ID. */
  initiativeNames?: Record<string, string>;
}

interface InitiativeGroup {
  initiativeId: string;
  label: string;
  clusters: DecisionCluster[];
  worstWaitingMinutes: number;
}

function getGroupUrgency(minutes: number): 'overdue' | 'urgent' | 'normal' {
  if (minutes >= 1440) return 'overdue';
  if (minutes >= 60) return 'urgent';
  return 'normal';
}

function shortenId(id: string): string {
  // UUID-like -> first 8 chars
  if (id.length >= 32) return id.slice(0, 8);
  return id;
}

function InitiativeGroupHeader({
  group,
}: {
  group: InitiativeGroup;
}) {
  const urgency = getGroupUrgency(group.worstWaitingMinutes);
  const count = group.clusters.length;
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-2 px-1 pb-1 pt-2.5 first:pt-0"
    >
      <span className="text-caption font-semibold text-white/70 truncate">
        {group.label}
      </span>
      <span className="text-micro text-muted whitespace-nowrap">
        ({count} decision{count === 1 ? '' : 's'})
      </span>
      {urgency === 'overdue' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/[0.12] px-1.5 py-0.5 text-micro font-medium text-red-400">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-400" />
          overdue
        </span>
      )}
      {urgency === 'urgent' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/[0.12] px-1.5 py-0.5 text-micro font-medium text-amber-400">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          urgent
        </span>
      )}
    </motion.div>
  );
}

function clusterDecisionKey(decision: LiveDecision): string {
  const dedupe = (decision.dedupeKey ?? '').trim();
  return dedupe.length > 0 ? dedupe : decision.id;
}

function clusterDecisionLabel(cluster: DecisionCluster): string {
  if (cluster.duplicateCount <= 1) return cluster.representative.title;
  return `${cluster.representative.title}`;
}

function formatDecisionType(decisionType: string): string {
  return decisionType
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export const DecisionQueue = memo(function DecisionQueue({
  decisions,
  focusDecisionId = null,
  onFocusDecisionHandled,
  onApproveDecision,
  onRejectDecision,
  onApproveAll,
  onBulkDecisionAction,
  mutationState,
  showHeader = true,
  panelStyle = 'card',
  className,
  initiativeNames,
}: DecisionQueueProps) {
  const prefersReducedMotion = useReducedMotion();
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailDecisionId, setDetailDecisionId] = useState<string | null>(null);
  const focusHandledRef = useRef<string | null>(null);

  const sorted = useMemo(
    () => {
      const seen = new Set<string>();
      return [...decisions]
        .filter((d) => {
          if (seen.has(d.id)) return false;
          seen.add(d.id);
          return true;
        })
        .sort((a, b) => {
          if (a.waitingMinutes !== b.waitingMinutes) {
            return b.waitingMinutes - a.waitingMinutes;
          }
          const aEpoch = Date.parse(a.requestedAt ?? a.updatedAt ?? '');
          const bEpoch = Date.parse(b.requestedAt ?? b.updatedAt ?? '');
          const safeA = Number.isFinite(aEpoch) ? aEpoch : 0;
          const safeB = Number.isFinite(bEpoch) ? bEpoch : 0;
          return safeB - safeA;
        });
    },
    [decisions]
  );

  const clusters = useMemo((): DecisionCluster[] => {
    const grouped = new Map<string, LiveDecision[]>();
    const order: string[] = [];
    for (const decision of sorted) {
      const key = clusterDecisionKey(decision);
      const existing = grouped.get(key);
      if (existing) {
        existing.push(decision);
      } else {
        grouped.set(key, [decision]);
        order.push(key);
      }
    }
    return order.map((key) => {
      const decisions = grouped.get(key) ?? [];
      return {
        key,
        representative: decisions[0]!,
        decisions,
        duplicateCount: decisions.length,
      };
    });
  }, [sorted]);

  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(clusters.map((cluster) => cluster.key));
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
      }
      return next;
    });
  }, [clusters]);

  const selectedCount = selected.size;
  const visible = useMemo(() => clusters.slice(0, visibleCount), [clusters, visibleCount]);
  const initiativeGroups = useMemo((): InitiativeGroup[] => {
    const groupMap = new Map<string, DecisionCluster[]>();
    const order: string[] = [];
    for (const cluster of visible) {
      const key = cluster.representative.initiativeId ?? '_unscoped';
      let list = groupMap.get(key);
      if (!list) {
        list = [];
        groupMap.set(key, list);
        order.push(key);
      }
      list.push(cluster);
    }
    // Sort groups by their worst (longest) waiting time descending
    const groups: InitiativeGroup[] = order.map((key) => {
      const items = groupMap.get(key)!;
      const worstWaitingMinutes = Math.max(0, ...items.map((cluster) => cluster.representative.waitingMinutes));
      const label =
        key === '_unscoped'
          ? 'General'
          : initiativeNames?.[key] ?? shortenId(key);
      return {
        initiativeId: key,
        label,
        clusters: items,
        worstWaitingMinutes,
      };
    });
    groups.sort((a, b) => b.worstWaitingMinutes - a.worstWaitingMinutes);
    return groups;
  }, [initiativeNames, visible]);

  const allVisibleSelected = useMemo(() => {
    if (visible.length === 0) return false;
    for (const cluster of visible) {
      if (!selected.has(cluster.key)) return false;
    }
    return true;
  }, [selected, visible]);

  const detailDecision = useMemo(
    () => (detailDecisionId ? sorted.find((decision) => decision.id === detailDecisionId) ?? null : null),
    [detailDecisionId, sorted]
  );

  const detailIndex = useMemo(
    () => (detailDecisionId ? sorted.findIndex((d) => d.id === detailDecisionId) : -1),
    [detailDecisionId, sorted]
  );

  const handleNavigateDecision = useCallback(
    (dir: 1 | -1) => {
      const next = detailIndex + dir;
      if (next >= 0 && next < sorted.length) {
        setDetailDecisionId(sorted[next].id);
      }
    },
    [detailIndex, sorted]
  );

  const handleApproveFromDetail = async (
    decisionId: string,
    input?: DecisionActionInput
  ) => {
    setNotice(null);
    setApproving((prev) => {
      const next = new Set(prev);
      next.add(decisionId);
      return next;
    });
    const result = await onApproveDecision(decisionId, input);
    if (result.failed > 0) {
      setNotice(formatDecisionFailureNotice('approve', result.failed, result.firstError));
    } else if (result.updated > 0) {
      setNotice('Decision approved. Changes synced.');
    }
    setApproving((prev) => {
      const next = new Set(prev);
      next.delete(decisionId);
      return next;
    });
    // Auto-close is handled by the detail modal's success state
    return result;
  };

  const handleRejectFromDetail = onRejectDecision
    ? async (decisionId: string, input?: DecisionActionInput) => {
        setNotice(null);
        setApproving((prev) => {
          const next = new Set(prev);
          next.add(decisionId);
          return next;
        });
        const result = await onRejectDecision(decisionId, input);
        if (result.failed > 0) {
          setNotice(formatDecisionFailureNotice('reject', result.failed, result.firstError));
        } else if (result.updated > 0) {
          setNotice('Decision rejected. Changes synced.');
        }
        setApproving((prev) => {
          const next = new Set(prev);
          next.delete(decisionId);
          return next;
        });
        return result;
      }
    : undefined;

  useEffect(() => {
    setVisibleCount((prev) => {
      if (clusters.length === 0) return 0;
      return Math.min(Math.max(PAGE_SIZE, prev), clusters.length);
    });
  }, [clusters.length]);

  useEffect(() => {
    const targetId = (focusDecisionId ?? '').trim();
    if (!targetId) {
      focusHandledRef.current = null;
      return;
    }
    if (focusHandledRef.current === targetId) return;
    const exists = sorted.some((decision) => decision.id === targetId);
    if (!exists) return;
    focusHandledRef.current = targetId;
    setDetailDecisionId(targetId);
    onFocusDecisionHandled?.(targetId);
  }, [focusDecisionId, onFocusDecisionHandled, sorted]);

  const toggleSelect = (clusterKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clusterKey)) {
        next.delete(clusterKey);
      } else {
        next.add(clusterKey);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (visible.length === 0) return prev;
      const next = new Set(prev);
      const shouldClear = allVisibleSelected;
      for (const cluster of visible) {
        if (shouldClear) {
          next.delete(cluster.key);
        } else {
          next.add(cluster.key);
        }
      }
      return next;
    });
  };

  const selectedClusters = useMemo(
    () => visible.filter((cluster) => selected.has(cluster.key)),
    [selected, visible]
  );
  const selectedDecisionIds = useMemo(
    () => selectedClusters.flatMap((cluster) => cluster.decisions.map((decision) => decision.id)),
    [selectedClusters]
  );
  const selectedDecisionTotal = selectedDecisionIds.length;
  const selectedInitiativeTotal = useMemo(() => {
    return new Set(
      selectedClusters.map((cluster) => cluster.representative.initiativeId ?? '_unscoped')
    ).size;
  }, [selectedClusters]);
  const selectedRecommendedTotal = useMemo(() => {
    return selectedClusters.filter((cluster) => Boolean(cluster.representative.recommendedAction)).length;
  }, [selectedClusters]);
  const selectedReviewLabel = useMemo(() => {
    if (selectedClusters.length === 0) return 'No decisions selected';
    if (selectedClusters.length === 1) {
      return `Reviewing ${selectedClusters[0].representative.title}`;
    }
    return `${selectedClusters.length} decision groups selected`;
  }, [selectedClusters]);
  const selectionChips = useMemo(() => {
    const chips: string[] = [];
    if (selectedDecisionTotal > 0) {
      chips.push(
        `${selectedDecisionTotal} decision${selectedDecisionTotal === 1 ? '' : 's'}`
      );
    }
    if (selectedInitiativeTotal > 0) {
      chips.push(
        `${selectedInitiativeTotal} initiative${selectedInitiativeTotal === 1 ? '' : 's'}`
      );
    }
    if (selectedRecommendedTotal > 0) {
      chips.push(
        `${selectedRecommendedTotal} recommended path${
          selectedRecommendedTotal === 1 ? '' : 's'
        }`
      );
    }
    return chips;
  }, [selectedDecisionTotal, selectedInitiativeTotal, selectedRecommendedTotal]);

  const runBulkFallback = async (
    ids: string[],
    action: 'approve' | 'reject'
  ): Promise<DecisionActionSummary> => {
    if (ids.length === 0) return { updated: 0, failed: 0 };
    if (action === 'approve' && ids.length === sorted.length) {
      return onApproveAll();
    }

    let updated = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const decisionId of ids) {
      try {
        const result =
          action === 'approve'
            ? await onApproveDecision(decisionId)
            : onRejectDecision
              ? await onRejectDecision(decisionId)
              : { updated: 0, failed: 1 };
        updated += result.updated;
        failed += result.failed;
        if (!firstError && result.firstError) {
          firstError = result.firstError;
        }
      } catch {
        failed += 1;
      }
    }
    return { updated, failed, firstError };
  };

  const handleApplyBulkAction = async (action: 'approve' | 'reject') => {
    if (isApprovingAll) return;
    const ids = selectedDecisionIds;
    if (ids.length === 0) {
      setNotice('No decisions selected for this action.');
      return;
    }

    setNotice(null);
    setIsApprovingAll(true);
    setApproving(new Set(ids));

    try {
      const result = onBulkDecisionAction
        ? await onBulkDecisionAction(
            ids,
            action
          )
        : await runBulkFallback(ids, action);
      const verb = action === 'approve' ? 'Approved' : 'Rejected';
      if (result.failed > 0) {
        const base = `${verb} ${result.updated}; ${result.failed} failed.`;
        const reason = formatDecisionError(result.firstError, base);
        setNotice(reason === base ? base : `${base} ${reason}`);
      } else if (result.updated > 0) {
        setNotice(`${verb} ${result.updated} decision${result.updated === 1 ? '' : 's'}.`);
      } else {
        setNotice('No decisions were updated.');
      }
      setSelected(new Set());
      setSelectionMode(false);
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setNotice(formatDecisionError(raw, 'Bulk decision action failed.'));
    } finally {
      setIsApprovingAll(false);
      setApproving(new Set());
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const noticeIsSuccess = notice !== null && !notice.toLowerCase().includes('fail');
  const hasInFlightMutations = isApprovingAll || approving.size > 0;
  const inFlightCount = Math.max(approving.size, isApprovingAll ? selectedCount : 0);
  const statusMessage = hasInFlightMutations
    ? `Applying ${inFlightCount} decision action${inFlightCount === 1 ? '' : 's'}…`
    : notice ?? null;
  const statusTone: 'processing' | 'success' | 'warning' | 'idle' = hasInFlightMutations
    ? 'processing'
    : notice
      ? noticeIsSuccess
        ? 'success'
        : 'warning'
      : 'idle';
  const enableMotion = !prefersReducedMotion && visible.length <= 32;
  const selectedEnabled = selectedDecisionIds.length > 0 && !isApprovingAll;
  const pendingCount = sorted.length;
  const longestWaitMinutes = sorted[0]?.waitingMinutes ?? 0;
  const showStatusBanner = statusMessage !== null || statusTone !== 'idle';
  const Wrapper = panelStyle === 'card' ? PremiumCard : 'div';
  const selectionControls =
    sorted.length > 0 ? (
      selectionMode ? (
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleSelectAll}
            disabled={hasInFlightMutations}
            className="control-pill h-8 px-3 text-caption font-semibold disabled:opacity-45"
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectionMode(false);
              setSelected(new Set());
            }}
            className="control-pill h-8 px-3 text-caption font-semibold"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSelectionMode(true)}
          className="control-pill h-8 px-3 text-caption font-semibold"
        >
          Select
        </button>
      )
    ) : null;
  const statusBanner = showStatusBanner ? (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      aria-live="polite"
      className={cn(
        'flex min-h-[32px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-caption transition-colors overflow-hidden',
        statusTone === 'processing'
          ? 'border-amber-300/25 bg-amber-400/[0.08] text-amber-100'
          : statusTone === 'success'
            ? 'border-lime/30 bg-lime/10 text-lime'
            : statusTone === 'warning'
              ? 'border-red-400/25 bg-red-500/[0.08] text-red-100'
              : 'border-strong bg-white/[0.02] text-secondary'
      )}
    >
      {statusTone === 'processing' ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-full border-2 border-amber-200/45 border-t-transparent animate-spin"
        />
      ) : statusTone === 'success' ? (
        <EntityIcon type="decision" size={12} className="opacity-90" />
      ) : statusTone === 'warning' ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-90"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" x2="12" y1="9" y2="13" />
          <line x1="12" x2="12.01" y1="17" y2="17" />
        </svg>
      ) : (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/35" />
      )}
      <span className="min-w-0 truncate">{statusMessage}</span>
    </motion.div>
  ) : null;
  const selectionTray = selectionMode && selectedCount > 0 ? (
    <div
      className={cn(
        showHeader
          ? 'mt-3 px-3 pb-3'
          : 'border-t border-subtle bg-black/40 px-2 pt-2 pb-2 backdrop-blur-xl'
      )}
    >
      <div className="rounded-xl border border-white/[0.08] bg-black/70 px-3 py-3 backdrop-blur-xl">
        <div className="space-y-3">
          <div className="min-w-0 space-y-1">
            <p className="text-caption font-semibold text-white">{selectedReviewLabel}</p>
            <p className="text-micro leading-relaxed text-secondary">
              Review the selected decision basket before applying a shared outcome.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="chip text-micro">
              {selectedCount} selected card{selectedCount === 1 ? '' : 's'}
            </span>
            {selectionChips.map((chip) => (
              <span key={chip} className="chip text-micro">
                {chip}
              </span>
            ))}
          </div>
          <p className="text-micro leading-relaxed text-white/45">
            {selectedRecommendedTotal > 0
              ? 'Recommended paths are present in this selection. Confirm the grouped consequence before approving. '
              : ''}
            Bulk actions apply only to the selected decision groups in this rail.
          </p>
          <div className="grid grid-cols-1 gap-2">
            {onRejectDecision ? (
              <button
                type="button"
                onClick={() => void handleApplyBulkAction('reject')}
                disabled={!selectedEnabled || hasInFlightMutations}
                className="control-pill h-9 w-full justify-center px-3 text-caption font-semibold disabled:opacity-45"
              >
                Reject {selectedDecisionTotal || selectedCount} selected
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleApplyBulkAction('approve')}
              disabled={!selectedEnabled || hasInFlightMutations}
              className="control-pill h-9 w-full justify-center px-3 text-caption font-semibold disabled:opacity-45"
              data-tone={selectedEnabled ? 'lime' : undefined}
            >
              {isApprovingAll
                ? 'Applying…'
                : `Approve ${selectedDecisionTotal || selectedCount} selected`}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <Wrapper
      className={cn(
        'flex h-full min-h-0 flex-col',
        panelStyle === 'card' && 'card-enter',
        className
      )}
    >
      <DecisionDetailModal
        open={detailDecisionId !== null}
        decision={detailDecision}
        onClose={() => setDetailDecisionId(null)}
        onApprove={handleApproveFromDetail}
        onReject={handleRejectFromDetail}
        onNavigate={handleNavigateDecision}
        currentIndex={detailIndex >= 0 ? detailIndex : undefined}
        totalCount={sorted.length}
      />
      {showHeader ? (
        <div className="space-y-2.5 border-b border-subtle px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="inline-flex items-center gap-2 text-heading font-semibold text-white">
                <EntityIcon type="decision" size={14} />
                Decisions
              </h2>
              <p className="mt-0.5 text-caption text-secondary">
                {pendingCount > 0
                  ? `${pendingCount} decision${pendingCount === 1 ? '' : 's'} need${pendingCount === 1 ? 's' : ''} your input`
                  : 'All clear — no decisions pending'}
              </p>
              {longestWaitMinutes > 0 ? (
                <p className="mt-1 text-micro text-white/35">
                  Longest waiting: {formatDurationWithUrgency(longestWaitMinutes).text}
                </p>
              ) : null}
            </div>
            {selectionControls}
          </div>
          {statusBanner}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1 space-y-2 overflow-y-auto',
          showHeader ? 'p-3' : 'p-0',
          selectionMode && 'pb-20'
        )}
      >
        {!showHeader && (selectionControls || statusBanner) ? (
          <div className="space-y-2 border-b border-subtle px-2 pb-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-micro uppercase tracking-[0.12em] text-white/40">
                  Decision controls
                </p>
                <p className="mt-1 text-caption text-secondary">
                  Review or batch-resolve the visible decision groups.
                </p>
              </div>
              {selectionControls}
            </div>
            {statusBanner}
          </div>
        ) : null}

        {sorted.length === 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col items-center gap-2.5 rounded-xl border border-subtle bg-white/[0.02] p-4 text-center"
          >
            {hasInFlightMutations ? (
              <>
                <span
                  aria-hidden
                  className="h-5 w-5 rounded-full border-2 border-amber-200/45 border-t-transparent animate-spin"
                />
                <p className="text-body text-secondary">Finalizing decision updates…</p>
              </>
            ) : (
              <>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-faint"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <p className="text-body text-secondary">No pending decisions. All clear.</p>
              </>
            )}
          </motion.div>
        )}

        {(enableMotion ? (
          <AnimatePresence mode="popLayout">
            {initiativeGroups.map((group) => (
              <div key={group.initiativeId}>
                {initiativeGroups.length > 1 ? <InitiativeGroupHeader group={group} /> : null}
                {group.clusters.map((cluster, idx) => {
                  const decision = cluster.representative;
                  const isApproving = cluster.decisions.some((entry) => approving.has(entry.id));
                  const isSelected = selected.has(cluster.key);
                  const urgency = getGroupUrgency(decision.waitingMinutes);
                  const transition = {
                    duration: 0.24,
                    ease: [0.22, 1, 0.36, 1] as const,
                    ...(isApprovingAll ? { delay: idx * 0.04 } : {}),
                  };
                  const content = (
                    <div className="flex items-start gap-2.5">
                      {selectionMode ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(cluster.key)}
                          disabled={isApproving || hasInFlightMutations}
                          onClick={(event) => event.stopPropagation()}
                          className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                          aria-label={`Select ${decision.title}`}
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-1.5">
                          {urgency !== 'normal' ? (
                            <span
                              aria-label={urgency === 'overdue' ? 'Overdue' : 'Urgent'}
                              className={cn(
                                'mt-[5px] h-2 w-2 flex-shrink-0 rounded-full',
                                urgency === 'overdue' ? 'bg-red-400' : 'bg-amber-400'
                              )}
                            />
                          ) : null}
                          <p className="flex min-w-0 items-start gap-1.5 text-body font-medium text-white" title={clusterDecisionLabel(cluster)}>
                            <EntityIcon type="decision" size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                            <span className="line-clamp-2">{clusterDecisionLabel(cluster)}</span>
                          </p>
                        </div>
                        {decision.context ? (
                          <p className="mt-1 line-clamp-2 text-caption text-secondary" title={decision.context}>
                            {decision.context}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                          <span
                            className={cn(
                              'truncate',
                              urgency === 'overdue'
                                ? 'text-red-400'
                                : urgency === 'urgent'
                                  ? 'text-amber-400'
                                  : 'text-muted'
                            )}
                            title={`${decision.agentName ?? 'OrgX Autopilot'} · ${formatDurationWithUrgency(decision.waitingMinutes).text}`}
                          >
                            {decision.agentName ?? 'OrgX Autopilot'} · {formatDurationWithUrgency(decision.waitingMinutes).text}
                          </span>
                          {cluster.duplicateCount > 1 ? (
                            <span className="chip text-micro">
                              {cluster.duplicateCount} similar requests
                            </span>
                          ) : null}
                          {decision.recommendedAction ? (
                            <span className="chip text-micro border-[#14B8A6]/28 bg-[#14B8A6]/10 text-[#7AEDE5]">
                              Recommended path
                            </span>
                          ) : null}
                          {decision.decisionType ? (
                            <span className="chip text-micro">
                              {formatDecisionType(decision.decisionType)}
                            </span>
                          ) : null}
                        </div>
                        {!selectionMode ? (
                          <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-2">
                            <p className="text-micro text-white/40">
                              {cluster.duplicateCount > 1
                                ? 'Open the cluster to inspect the lead decision and related duplicates.'
                                : 'Open the full decision context before taking action.'}
                            </p>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDetailDecisionId(decision.id);
                              }}
                              className="control-pill h-7 px-2.5 text-micro font-semibold"
                              aria-label={`Review ${decision.title}`}
                            >
                              Review
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );

                  if (enableMotion) {
                    return (
                      <motion.article
                        key={cluster.key}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (selectionMode) {
                            toggleSelect(cluster.key);
                            return;
                          }
                          setDetailDecisionId(decision.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          if (selectionMode) {
                            toggleSelect(cluster.key);
                            return;
                          }
                          setDetailDecisionId(decision.id);
                        }}
                        initial={isApprovingAll ? { opacity: 0, x: 300 } : { opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.96, y: -6 }}
                        transition={transition}
                        layout
                        className="mt-1.5 rounded-xl border bg-white/[0.03] px-3 py-2.5 transition-[border-color,box-shadow] cv-auto"
                        style={{
                          borderColor: isSelected ? `${colors.lime}50` : 'rgba(255, 255, 255, 0.1)',
                          boxShadow: isSelected ? '0 0 0 1px rgba(191, 255, 0, 0.14)' : 'none',
                        }}
                      >
                        {content}
                      </motion.article>
                    );
                  }

                  return null;
                })}
              </div>
            ))}
          </AnimatePresence>
        ) : (
          initiativeGroups.map((group) => (
            <div key={group.initiativeId}>
              {initiativeGroups.length > 1 ? <InitiativeGroupHeader group={group} /> : null}
              {group.clusters.map((cluster) => {
                const decision = cluster.representative;
                const isApproving = cluster.decisions.some((entry) => approving.has(entry.id));
                const isSelected = selected.has(cluster.key);
                const urgency = getGroupUrgency(decision.waitingMinutes);
                return (
                  <article
                    key={cluster.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (selectionMode) {
                        toggleSelect(cluster.key);
                        return;
                      }
                      setDetailDecisionId(decision.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (selectionMode) {
                        toggleSelect(cluster.key);
                        return;
                      }
                      setDetailDecisionId(decision.id);
                    }}
                    className="mt-1.5 rounded-xl border bg-white/[0.03] px-3 py-2.5 transition-[border-color,box-shadow] cv-auto"
                    style={{
                      borderColor: isSelected ? `${colors.lime}50` : 'rgba(255, 255, 255, 0.1)',
                      boxShadow: isSelected ? '0 0 0 1px rgba(191, 255, 0, 0.14)' : 'none',
                    }}
                  >
                    <div className="flex items-start gap-2.5">
                      {selectionMode ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(cluster.key)}
                          disabled={isApproving || hasInFlightMutations}
                          onClick={(event) => event.stopPropagation()}
                          className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                          aria-label={`Select ${decision.title}`}
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-1.5">
                          {urgency !== 'normal' ? (
                            <span
                              aria-label={urgency === 'overdue' ? 'Overdue' : 'Urgent'}
                              className={cn(
                                'mt-[5px] h-2 w-2 flex-shrink-0 rounded-full',
                                urgency === 'overdue' ? 'bg-red-400' : 'bg-amber-400'
                              )}
                            />
                          ) : null}
                          <p className="flex min-w-0 items-start gap-1.5 text-body font-medium text-white" title={clusterDecisionLabel(cluster)}>
                            <EntityIcon type="decision" size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                            <span className="line-clamp-2">{clusterDecisionLabel(cluster)}</span>
                          </p>
                        </div>
                        {decision.context ? (
                          <p className="mt-1 line-clamp-2 text-caption text-secondary" title={decision.context}>
                            {decision.context}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                          <span>{decision.agentName ?? 'OrgX Autopilot'} · {formatDurationWithUrgency(decision.waitingMinutes).text}</span>
                          {cluster.duplicateCount > 1 ? (
                            <span className="chip text-micro">
                              {cluster.duplicateCount} similar requests
                            </span>
                          ) : null}
                          {decision.recommendedAction ? (
                            <span className="chip text-micro border-[#14B8A6]/28 bg-[#14B8A6]/10 text-[#7AEDE5]">
                              Recommended path
                            </span>
                          ) : null}
                        </div>
                        {!selectionMode ? (
                          <div className="mt-2 flex items-center justify-end border-t border-white/[0.07] pt-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDetailDecisionId(decision.id);
                              }}
                              className="control-pill h-7 px-2.5 text-micro font-semibold"
                              aria-label={`Review ${decision.title}`}
                            >
                              Review
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ))
        ))}

        {visible.length < clusters.length && (
          <button
            onClick={() => setVisibleCount((prev) => Math.min(clusters.length, prev + PAGE_SIZE))}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.05]"
          >
            Load more ({clusters.length - visible.length} remaining)
          </button>
        )}
      </div>
      {selectionTray}
    </Wrapper>
  );
});
