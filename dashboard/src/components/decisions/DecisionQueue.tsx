import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LiveDecision } from '@/types';
import { formatRelativeTime, formatDurationWithUrgency } from '@/lib/time';
import { colors } from '@/lib/tokens';
import { cn } from '@/lib/utils';
import { humanizeWarning } from '@/lib/humanize';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { DecisionDetailModal } from '@/components/decisions/DecisionDetailModal';
import { useUndoToast } from '@/components/shared/UndoToast';

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

type DecisionBulkActionId =
  | 'approve_selected'
  | 'reject_selected'
  | 'approve_visible'
  | 'reject_visible';
type DecisionBulkScope = 'selected' | 'visible';

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
}

function composeBulkActionId(
  action: 'approve' | 'reject',
  scope: DecisionBulkScope
): DecisionBulkActionId {
  return `${action}_${scope}` as DecisionBulkActionId;
}

function urgencyAccent(waitingMinutes: number): { border: string; glow: string } {
  if (waitingMinutes >= 15) return { border: colors.red, glow: `0 0 16px ${colors.red}20` };
  if (waitingMinutes >= 5) return { border: colors.amber, glow: `0 0 12px ${colors.amber}18` };
  return { border: colors.teal, glow: 'none' };
}

export const DecisionQueue = memo(function DecisionQueue({
  decisions,
  focusDecisionId = null,
  onFocusDecisionHandled,
  onApproveDecision,
  onRejectDecision,
  onApproveAll,
  onBulkDecisionAction,
}: DecisionQueueProps) {
  const prefersReducedMotion = useReducedMotion();
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [swipedIds, setSwipedIds] = useState<Set<string>>(new Set());
  const { enqueue: enqueueUndo, ToastRenderer: UndoToastRenderer } = useUndoToast();
  const [bulkAction, setBulkAction] = useState<DecisionBulkActionId>('approve_selected');
  const [bulkNote, setBulkNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailDecisionId, setDetailDecisionId] = useState<string | null>(null);
  const focusHandledRef = useRef<string | null>(null);

  const sorted = useMemo(
    () =>
      [...decisions].sort((a, b) => {
        if (a.waitingMinutes !== b.waitingMinutes) {
          return b.waitingMinutes - a.waitingMinutes;
        }
        const aEpoch = Date.parse(a.requestedAt ?? a.updatedAt ?? '');
        const bEpoch = Date.parse(b.requestedAt ?? b.updatedAt ?? '');
        const safeA = Number.isFinite(aEpoch) ? aEpoch : 0;
        const safeB = Number.isFinite(bEpoch) ? bEpoch : 0;
        return safeB - safeA;
      }),
    [decisions]
  );

  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(sorted.map((decision) => decision.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
      }
      return next;
    });
  }, [sorted]);

  const selectedCount = selected.size;
  const visible = useMemo(
    () => sorted.filter((d) => !swipedIds.has(d.id)).slice(0, visibleCount),
    [sorted, visibleCount, swipedIds]
  );
  const allVisibleSelected = useMemo(() => {
    if (visible.length === 0) return false;
    for (const decision of visible) {
      if (!selected.has(decision.id)) return false;
    }
    return true;
  }, [selected, visible]);

  const detailDecision = useMemo(
    () => (detailDecisionId ? sorted.find((decision) => decision.id === detailDecisionId) ?? null : null),
    [detailDecisionId, sorted]
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
      if (sorted.length === 0) return 0;
      return Math.min(Math.max(PAGE_SIZE, prev), sorted.length);
    });
  }, [sorted.length]);

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

  const toggleSelect = (decisionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(decisionId)) {
        next.delete(decisionId);
      } else {
        next.add(decisionId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (visible.length === 0) return prev;
      const next = new Set(prev);
      const shouldClear = allVisibleSelected;
      for (const decision of visible) {
        if (shouldClear) {
          next.delete(decision.id);
        } else {
          next.add(decision.id);
        }
      }
      return next;
    });
  };

  const bulkOptions = useMemo(() => {
    const selectedIds = sorted
      .map((decision) => decision.id)
      .filter((id) => selected.has(id));
    const visibleIds = visible.map((decision) => decision.id);
    return [
      {
        id: 'approve_selected' as const,
        label: `Approve selected (${selectedIds.length})`,
        action: 'approve' as const,
        ids: selectedIds,
      },
      {
        id: 'reject_selected' as const,
        label: `Reject selected (${selectedIds.length})`,
        action: 'reject' as const,
        ids: selectedIds,
        hidden: !onRejectDecision,
      },
      {
        id: 'approve_visible' as const,
        label: `Approve visible (${visibleIds.length})`,
        action: 'approve' as const,
        ids: visibleIds,
      },
      {
        id: 'reject_visible' as const,
        label: `Reject visible (${visibleIds.length})`,
        action: 'reject' as const,
        ids: visibleIds,
        hidden: !onRejectDecision,
      },
    ].filter((option) => !option.hidden);
  }, [onRejectDecision, selected, sorted, visible]);

  const selectedBulkOption = useMemo(
    () => bulkOptions.find((option) => option.id === bulkAction) ?? bulkOptions[0] ?? null,
    [bulkAction, bulkOptions]
  );

  const runBulkFallback = async (
    ids: string[],
    action: 'approve' | 'reject',
    note?: string
  ): Promise<DecisionActionSummary> => {
    if (ids.length === 0) return { updated: 0, failed: 0 };
    if (action === 'approve' && ids.length === sorted.length && !note) {
      return onApproveAll();
    }

    let updated = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const decisionId of ids) {
      try {
        const result =
          action === 'approve'
            ? await onApproveDecision(decisionId, note ? { note } : undefined)
            : onRejectDecision
              ? await onRejectDecision(decisionId, note ? { note } : undefined)
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

  const handleApplyBulkAction = async () => {
    if (!selectedBulkOption || isApprovingAll) return;
    const ids = selectedBulkOption.ids;
    if (ids.length === 0) {
      setNotice('No decisions selected for this action.');
      return;
    }

    setNotice(null);
    setIsApprovingAll(true);
    setApproving(new Set(ids));
    const note = bulkNote.trim();

    try {
      const result = onBulkDecisionAction
        ? await onBulkDecisionAction(
            ids,
            selectedBulkOption.action,
            note.length > 0 ? note : undefined
          )
        : await runBulkFallback(
            ids,
            selectedBulkOption.action,
            note.length > 0 ? note : undefined
          );
      const verb = selectedBulkOption.action === 'approve' ? 'Approved' : 'Rejected';
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
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setNotice(formatDecisionError(raw, 'Bulk decision action failed.'));
    } finally {
      setIsApprovingAll(false);
      setApproving(new Set());
    }
  };

  const handleApproveOne = async (decisionId: string) => {
    if (approving.has(decisionId) || isApprovingAll) return;

    setNotice(null);
    setApproving((prev) => {
      const next = new Set(prev);
      next.add(decisionId);
      return next;
    });

    try {
      const result = await onApproveDecision(decisionId);
      if (result.failed > 0) {
        setNotice(formatDecisionFailureNotice('approve', result.failed, result.firstError));
      } else if (result.updated > 0) {
        setNotice('Decision approved.');
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setNotice(formatDecisionError(raw, 'Decision approval failed.'));
    } finally {
      setApproving((prev) => {
        const next = new Set(prev);
        next.delete(decisionId);
        return next;
      });
      setSelected((prev) => {
        if (!prev.has(decisionId)) return prev;
        const next = new Set(prev);
        next.delete(decisionId);
        return next;
      });
    }
  };

  const handleSwipeApprove = useCallback(
    (decision: LiveDecision) => {
      if (approving.has(decision.id) || isApprovingAll) return;
      setSwipedIds((prev) => new Set(prev).add(decision.id));
      enqueueUndo({
        message: `Approved '${decision.title.length > 40 ? decision.title.slice(0, 40) + '…' : decision.title}'`,
        onUndo: () => {
          setSwipedIds((prev) => {
            const next = new Set(prev);
            next.delete(decision.id);
            return next;
          });
        },
        onCommit: () => {
          setSwipedIds((prev) => {
            const next = new Set(prev);
            next.delete(decision.id);
            return next;
          });
          void onApproveDecision(decision.id).catch(() => {
            setNotice('Approval failed. Try again from the decision panel.');
          });
        },
      });
    },
    [approving, isApprovingAll, enqueueUndo, onApproveDecision]
  );

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
  const selectedEnabled = selectedBulkOption !== null && selectedBulkOption.ids.length > 0 && !isApprovingAll;
  const pendingCount = sorted.length;
  const longestWaitMinutes = sorted[0]?.waitingMinutes ?? 0;
  const selectedScope: DecisionBulkScope =
    selectedBulkOption?.id.includes('visible') ? 'visible' : 'selected';
  const selectedVerb: 'approve' | 'reject' = selectedBulkOption?.action ?? 'approve';

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
      <DecisionDetailModal
        open={detailDecisionId !== null}
        decision={detailDecision}
        onClose={() => setDetailDecisionId(null)}
        onApprove={handleApproveFromDetail}
        onReject={handleRejectFromDetail}
      />
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
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {sorted.length > 0 && (
            <button
              onClick={toggleSelectAll}
              disabled={hasInFlightMutations}
              className="control-pill h-8 px-3 text-caption font-semibold disabled:opacity-45"
            >
              {allVisibleSelected ? 'Clear all' : 'Select all'}
            </button>
          )}
          {selectedCount > 0 && (
            <>
              <button
                onClick={handleApplyBulkAction}
                disabled={!selectedEnabled || hasInFlightMutations}
                data-state={selectedEnabled ? 'active' : 'idle'}
                className="control-pill h-8 flex-shrink-0 px-3 text-caption font-semibold disabled:opacity-45"
              >
                {isApprovingAll ? 'Approving…' : `Approve ${selectedCount} selected`}
              </button>
              {onRejectDecision && (
                <button
                  type="button"
                  onClick={() => setBulkAction(composeBulkActionId('reject', selectedScope))}
                  disabled={hasInFlightMutations}
                  data-state={selectedVerb === 'reject' ? 'active' : 'idle'}
                  className={cn(
                    'control-pill h-8 px-2.5 text-caption font-semibold disabled:opacity-45',
                    selectedVerb === 'reject' && 'border-amber-300/35 bg-amber-400/[0.12] text-amber-100'
                  )}
                >
                  Reject
                </button>
              )}
            </>
          )}
        </div>

        <div
          aria-live="polite"
          className={cn(
            'flex min-h-[32px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-caption transition-colors',
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
          <span className="min-w-0 truncate">
            {statusMessage ?? 'Resolve decisions here. Status will remain visible until sync settles.'}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-subtle bg-white/[0.02] p-4 text-center">
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
                {noticeIsSuccess && statusMessage ? (
                  <p className="text-caption text-lime">{statusMessage}</p>
                ) : null}
              </>
            )}
          </div>
        )}

        {enableMotion ? (
          <AnimatePresence mode="popLayout">
            {visible.map((decision, idx) => {
              const isApproving = approving.has(decision.id);
              const urgency = urgencyAccent(decision.waitingMinutes);
              const isSelected = selected.has(decision.id);
              return (
                <motion.article
                  key={decision.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailDecisionId(decision.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDetailDecisionId(decision.id);
                    }
                  }}
                  drag={!hasInFlightMutations && !isApproving ? 'x' : false}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.3}
                  onDragEnd={(_e, info) => {
                    if (info.offset.x > 120) {
                      handleSwipeApprove(decision);
                    }
                  }}
                  initial={isApprovingAll ? { opacity: 0, x: 300 } : { opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 300, scale: 0.95 }}
                  transition={{
                    duration: 0.25,
                    ease: [0.22, 1, 0.36, 1],
                    ...(isApprovingAll ? { delay: idx * 0.04 } : {}),
                  }}
                  layout
                  className="rounded-xl border bg-white/[0.03] px-3 py-2.5 transition-[border-color,box-shadow] cv-auto"
                  style={{
                    borderColor: isSelected ? `${colors.lime}50` : `${urgency.border}35`,
                    borderLeftWidth: 3,
                    borderLeftColor: `${urgency.border}80`,
                    boxShadow: urgency.glow,
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(decision.id)}
                      disabled={isApproving || hasInFlightMutations}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-start gap-1.5 text-body font-medium text-white" title={decision.title}>
                          <EntityIcon type="decision" size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                          <span className="line-clamp-2">{decision.title}</span>
                        </p>
                        {decision.context && (
                          <p className="mt-1 line-clamp-2 text-caption text-secondary" title={decision.context}>
                            {decision.context}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <p className={`min-w-0 truncate text-micro ${(() => { const u = formatDurationWithUrgency(decision.waitingMinutes); return u.tone === 'urgent' ? 'text-red-400' : u.tone === 'attention' ? 'text-amber-400' : 'text-muted'; })()}`} title={`${decision.agentName ?? 'OrgX Autopilot'} · ${formatDurationWithUrgency(decision.waitingMinutes).text}`}>
                            {decision.agentName ?? 'OrgX Autopilot'} · {formatDurationWithUrgency(decision.waitingMinutes).text}
                          </p>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleApproveOne(decision.id);
                            }}
                            disabled={isApproving || hasInFlightMutations}
                            className="flex-shrink-0 rounded-md border border-lime/25 bg-lime/10 px-2.5 py-1 text-micro font-semibold text-lime transition-colors hover:bg-lime/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.08] disabled:text-secondary"
                          >
                            {isApproving ? 'Approving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        ) : (
          <>
            {visible.map((decision) => {
              const isApproving = approving.has(decision.id);
              const urgency = urgencyAccent(decision.waitingMinutes);
              const isSelected = selected.has(decision.id);
              return (
                <article
                  key={decision.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailDecisionId(decision.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDetailDecisionId(decision.id);
                    }
                  }}
                  className="rounded-xl border bg-white/[0.03] px-3 py-2.5 transition-[border-color,box-shadow] cv-auto"
                  style={{
                    borderColor: isSelected ? `${colors.lime}50` : `${urgency.border}35`,
                    borderLeftWidth: 3,
                    borderLeftColor: `${urgency.border}80`,
                    boxShadow: urgency.glow,
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(decision.id)}
                      disabled={isApproving || hasInFlightMutations}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-start gap-1.5 text-body font-medium text-white" title={decision.title}>
                          <EntityIcon type="decision" size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                          <span className="line-clamp-2">{decision.title}</span>
                        </p>
                        {decision.context && (
                          <p className="mt-1 line-clamp-2 text-caption text-secondary" title={decision.context}>
                            {decision.context}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <p className={`min-w-0 truncate text-micro ${(() => { const u = formatDurationWithUrgency(decision.waitingMinutes); return u.tone === 'urgent' ? 'text-red-400' : u.tone === 'attention' ? 'text-amber-400' : 'text-muted'; })()}`} title={`${decision.agentName ?? 'OrgX Autopilot'} · ${formatDurationWithUrgency(decision.waitingMinutes).text}`}>
                            {decision.agentName ?? 'OrgX Autopilot'} · {formatDurationWithUrgency(decision.waitingMinutes).text}
                          </p>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleApproveOne(decision.id);
                            }}
                            disabled={isApproving || hasInFlightMutations}
                            className="flex-shrink-0 rounded-md border border-lime/25 bg-lime/10 px-2.5 py-1 text-micro font-semibold text-lime transition-colors hover:bg-lime/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.08] disabled:text-secondary"
                          >
                            {isApproving ? 'Approving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </>
        )}

        {visible.length < sorted.length && (
          <button
            onClick={() => setVisibleCount((prev) => Math.min(sorted.length, prev + PAGE_SIZE))}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-caption text-secondary transition-colors hover:bg-white/[0.05]"
          >
            Load more ({sorted.length - visible.length} remaining)
          </button>
        )}
      </div>

      <UndoToastRenderer />
    </PremiumCard>
  );
});
