import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LiveDecision } from '@/types';
import { formatRelativeTime } from '@/lib/time';
import { colors } from '@/lib/tokens';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { DecisionDetailModal } from '@/components/decisions/DecisionDetailModal';

const PAGE_SIZE = 40;

interface DecisionActionSummary {
  updated: number;
  failed: number;
}

interface DecisionQueueProps {
  decisions: LiveDecision[];
  onApproveDecision: (decisionId: string) => Promise<DecisionActionSummary>;
  onApproveAll: () => Promise<DecisionActionSummary>;
}

function urgencyAccent(waitingMinutes: number): { border: string; glow: string } {
  if (waitingMinutes >= 15) return { border: colors.red, glow: `0 0 16px ${colors.red}20` };
  if (waitingMinutes >= 5) return { border: colors.amber, glow: `0 0 12px ${colors.amber}18` };
  return { border: colors.teal, glow: 'none' };
}

export const DecisionQueue = memo(function DecisionQueue({
  decisions,
  onApproveDecision,
  onApproveAll,
}: DecisionQueueProps) {
  const prefersReducedMotion = useReducedMotion();
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [detailDecisionId, setDetailDecisionId] = useState<string | null>(null);

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
  const visible = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
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

  const handleApproveFromDetail = async (decisionId: string) => {
    const result = await onApproveDecision(decisionId);
    if (result.failed === 0 && result.updated > 0) {
      setDetailDecisionId(null);
    }
    return result;
  };

  useEffect(() => {
    setVisibleCount((prev) => {
      if (sorted.length === 0) return 0;
      return Math.min(Math.max(PAGE_SIZE, prev), sorted.length);
    });
  }, [sorted.length]);

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

  const handleApproveAll = async () => {
    if (sorted.length === 0 || isApprovingAll) return;
    setNotice(null);
    setIsApprovingAll(true);
    try {
      const result = await onApproveAll();
      if (result.failed > 0) {
        setNotice(`Approved ${result.updated}; ${result.failed} failed.`);
      } else if (result.updated > 0) {
        setNotice(`Approved ${result.updated} decision${result.updated === 1 ? '' : 's'}.`);
      } else {
        setNotice('No decisions were updated.');
      }
      setSelected(new Set());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Bulk approval failed.');
    } finally {
      setIsApprovingAll(false);
    }
  };

  const handleApproveSelected = async () => {
    if (selectedCount === 0 || isApprovingAll) return;
    setNotice(null);
    setIsApprovingAll(true);
    let updated = 0;
    let failed = 0;

    try {
      const selectedIds = sorted
        .map((decision) => decision.id)
        .filter((id) => selected.has(id));

      for (const decisionId of selectedIds) {
        setApproving((prev) => new Set(prev).add(decisionId));
        try {
          const result = await onApproveDecision(decisionId);
          updated += result.updated;
          failed += result.failed;
        } catch {
          failed += 1;
        } finally {
          setApproving((prev) => {
            const next = new Set(prev);
            next.delete(decisionId);
            return next;
          });
        }
      }

      if (failed > 0) {
        setNotice(`Approved ${updated}; ${failed} failed.`);
      } else {
        setNotice(`Approved ${updated} selected decision${updated === 1 ? '' : 's'}.`);
      }
      setSelected(new Set());
    } finally {
      setIsApprovingAll(false);
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
        setNotice(`Approval failed for ${result.failed} decision.`);
      } else if (result.updated > 0) {
        setNotice('Decision approved.');
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Decision approval failed.');
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

  const noticeIsSuccess = notice !== null && !notice.toLowerCase().includes('fail');
  const enableMotion = !prefersReducedMotion && visible.length <= 32;
  const allEnabled = sorted.length > 0 && !isApprovingAll;
  const selectedEnabled = selectedCount > 0 && !isApprovingAll;

  return (
    <PremiumCard className="flex h-full min-h-0 flex-col card-enter">
      <DecisionDetailModal
        open={detailDecisionId !== null}
        decision={detailDecision}
        onClose={() => setDetailDecisionId(null)}
        onApprove={handleApproveFromDetail}
      />
      <div className="space-y-2 border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-white">
              <EntityIcon type="decision" size={14} />
              Decisions
            </h2>
            <p className="hidden text-[12px] text-white/45 sm:block">
              Select multiple items to bulk review and approve
            </p>
          </div>

          <button
            onClick={handleApproveAll}
            disabled={!allEnabled}
            data-state={allEnabled ? 'active' : 'idle'}
            className="control-pill flex-shrink-0 px-3 text-[11px] font-semibold disabled:opacity-45"
          >
            {isApprovingAll ? (
              'Approving…'
            ) : (
              <>
                <span className="hidden sm:inline">Approve all</span>
                <span className="sm:hidden">Approve</span>
                <span className="inline-flex h-5 items-center rounded-full border border-white/[0.16] bg-white/[0.04] px-2 text-[10px] text-white/70 tabular-nums">
                  {sorted.length}
                </span>
              </>
            )}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={toggleSelectAll}
            disabled={sorted.length === 0 || isApprovingAll}
            className="control-pill px-3 text-[11px] font-semibold disabled:opacity-45"
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </button>
          <button
            onClick={handleApproveSelected}
            disabled={!selectedEnabled}
            data-state={selectedEnabled ? 'active' : 'idle'}
            className="control-pill px-3 text-[11px] font-semibold disabled:opacity-45"
          >
            {isApprovingAll ? (
              'Approving…'
            ) : (
              <>
                <span className="hidden sm:inline">Approve selected</span>
                <span className="sm:hidden">Approve sel.</span>
                <span className="inline-flex h-5 items-center rounded-full border border-white/[0.16] bg-white/[0.04] px-2 text-[10px] text-white/70 tabular-nums">
                  {selectedCount}
                </span>
              </>
            )}
          </button>
          <span className="text-[11px] text-white/45">
            {selectedCount > 0 ? `${selectedCount} selected` : 'No selection'}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/25"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="text-[12px] text-white/45">No pending decisions. All clear.</p>
          </div>
        )}

        {enableMotion ? (
          <AnimatePresence mode="popLayout">
            {visible.map((decision) => {
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
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
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
                      disabled={isApproving || isApprovingAll}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-white">
                            <EntityIcon type="decision" size={12} className="flex-shrink-0 opacity-90" />
                            <span className="truncate">{decision.title}</span>
                          </p>
                          {decision.context && (
                            <p className="mt-1 line-clamp-2 text-[11px] text-white/55">
                              {decision.context}
                            </p>
                          )}
                          <p className="mt-1.5 text-[10px] text-white/40">
                            {decision.agentName ?? 'System'} · Waiting {decision.waitingMinutes}m
                            {decision.requestedAt
                              ? ` · ${formatRelativeTime(decision.requestedAt)}`
                              : ''}
                          </p>
                        </div>

                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleApproveOne(decision.id);
                          }}
                          disabled={isApproving || isApprovingAll}
                          className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-[11px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.08] disabled:text-white/45"
                        >
                          {isApproving ? 'Approving…' : 'Approve'}
                        </button>
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
                      disabled={isApproving || isApprovingAll}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-white">
                            <EntityIcon type="decision" size={12} className="flex-shrink-0 opacity-90" />
                            <span className="truncate">{decision.title}</span>
                          </p>
                          {decision.context && (
                            <p className="mt-1 line-clamp-2 text-[11px] text-white/55">
                              {decision.context}
                            </p>
                          )}
                          <p className="mt-1.5 text-[10px] text-white/40">
                            {decision.agentName ?? 'System'} · Waiting {decision.waitingMinutes}m
                            {decision.requestedAt
                              ? ` · ${formatRelativeTime(decision.requestedAt)}`
                              : ''}
                          </p>
                        </div>

                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleApproveOne(decision.id);
                          }}
                          disabled={isApproving || isApprovingAll}
                          className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-[11px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.08] disabled:text-white/45"
                        >
                          {isApproving ? 'Approving…' : 'Approve'}
                        </button>
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
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[11px] text-white/55 transition-colors hover:bg-white/[0.05]"
          >
            Load more ({sorted.length - visible.length} remaining)
          </button>
        )}
      </div>

      {notice && (
        <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5 text-[12px] text-white/55">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={noticeIsSuccess ? 'text-lime' : 'text-amber-400'}
          >
            {noticeIsSuccess ? (
              <>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </>
            ) : (
              <>
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" x2="12" y1="9" y2="13" />
                <line x1="12" x2="12.01" y1="17" y2="17" />
              </>
            )}
          </svg>
          {notice}
        </div>
      )}
    </PremiumCard>
  );
});
