import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LiveDecision } from '@/types';
import { formatRelativeTime } from '@/lib/time';
import { colors } from '@/lib/tokens';
import { PremiumCard } from '@/components/shared/PremiumCard';

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
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

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
  const allVisibleSelected = sorted.length > 0 && selectedCount === sorted.length;

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
      if (sorted.length === 0) return prev;
      if (prev.size === sorted.length) {
        return new Set();
      }
      return new Set(sorted.map((decision) => decision.id));
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

  return (
    <PremiumCard className="flex flex-col fade-in-up">
      <div className="space-y-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[13px] font-semibold text-white">Decisions</h2>
            <p className="text-[10px] text-white/45">
              Select multiple items to bulk review and approve
            </p>
          </div>

          <button
            onClick={handleApproveAll}
            disabled={sorted.length === 0 || isApprovingAll}
            className="rounded-lg px-2.5 py-1.5 text-[10px] font-semibold transition-colors"
            style={{
              backgroundColor:
                sorted.length === 0 || isApprovingAll ? 'rgba(255,255,255,0.08)' : colors.lime,
              color: sorted.length === 0 || isApprovingAll ? 'rgba(255,255,255,0.45)' : '#000',
            }}
          >
            {isApprovingAll ? 'Approving…' : `Approve all (${sorted.length})`}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={toggleSelectAll}
            disabled={sorted.length === 0 || isApprovingAll}
            className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2 py-1 text-[10px] text-white/70 transition-colors hover:bg-white/[0.07] disabled:opacity-45"
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </button>
          <button
            onClick={handleApproveSelected}
            disabled={selectedCount === 0 || isApprovingAll}
            className="rounded-md border border-lime/25 bg-lime/10 px-2 py-1 text-[10px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
          >
            {isApprovingAll ? 'Approving…' : `Approve selected (${selectedCount})`}
          </button>
          <span className="text-[10px] text-white/45">
            {selectedCount > 0 ? `${selectedCount} selected` : 'No selection'}
          </span>
        </div>
      </div>

      <div className="max-h-[28vh] space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
            <svg
              width="20"
              height="20"
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
            <p className="text-[11px] text-white/45">No pending decisions.</p>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {sorted.map((decision) => {
            const isApproving = approving.has(decision.id);
            const urgency = urgencyAccent(decision.waitingMinutes);
            const isSelected = selected.has(decision.id);
            return (
              <motion.article
                key={decision.id}
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                layout
                className="rounded-xl border bg-white/[0.03] px-3 py-2.5 transition-[border-color,box-shadow]"
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
                    className="mt-1 h-3.5 w-3.5 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-white">{decision.title}</p>
                        {decision.context && (
                          <p className="mt-1 line-clamp-2 text-[10px] text-white/55">
                            {decision.context}
                          </p>
                        )}
                        <p className="mt-1.5 text-[9px] text-white/40">
                          {decision.agentName ?? 'System'} · Waiting {decision.waitingMinutes}m
                          {decision.requestedAt
                            ? ` · ${formatRelativeTime(decision.requestedAt)}`
                            : ''}
                        </p>
                      </div>

                      <button
                        onClick={() => handleApproveOne(decision.id)}
                        disabled={isApproving || isApprovingAll}
                        className="rounded-md border border-lime/25 bg-lime/10 px-2.5 py-1 text-[10px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.08] disabled:text-white/45"
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
      </div>

      {notice && (
        <div className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-white/55">{notice}</div>
      )}
    </PremiumCard>
  );
});
