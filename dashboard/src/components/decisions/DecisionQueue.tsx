import { memo, useMemo, useState } from 'react';
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

export const DecisionQueue = memo(function DecisionQueue({
  decisions,
  onApproveDecision,
  onApproveAll,
}: DecisionQueueProps) {
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [approving, setApproving] = useState<Set<string>>(new Set());
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
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Bulk approval failed.');
    } finally {
      setIsApprovingAll(false);
    }
  };

  const handleApproveOne = async (decisionId: string) => {
    if (approving.has(decisionId)) return;

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
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Decision approval failed.');
    } finally {
      setApproving((prev) => {
        const next = new Set(prev);
        next.delete(decisionId);
        return next;
      });
    }
  };

  return (
    <PremiumCard className="flex flex-col fade-in-up">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-white">Decisions</h2>
          <p className="text-[10px] text-white/45">Pending approvals from active runs</p>
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

      <div className="max-h-[28vh] space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] text-white/45">
            No pending decisions.
          </div>
        )}

        {sorted.map((decision) => {
          const isApproving = approving.has(decision.id);
          return (
            <article
              key={decision.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-white">{decision.title}</p>
                  {decision.context && (
                    <p className="mt-1 line-clamp-2 text-[10px] text-white/55">{decision.context}</p>
                  )}
                  <p className="mt-1.5 text-[9px] text-white/40">
                    {decision.agentName ?? 'System'} · Waiting {decision.waitingMinutes}m
                    {decision.requestedAt ? ` · ${formatRelativeTime(decision.requestedAt)}` : ''}
                  </p>
                </div>

                <button
                  onClick={() => handleApproveOne(decision.id)}
                  disabled={isApproving || isApprovingAll}
                  className="rounded-md bg-white/[0.08] px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-white/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isApproving ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {notice && (
        <div className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-white/55">{notice}</div>
      )}
    </PremiumCard>
  );
});
