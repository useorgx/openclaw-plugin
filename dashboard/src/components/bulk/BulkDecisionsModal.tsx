import { useMemo } from 'react';
import type { LiveDecision } from '@/types';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { colors } from '@/lib/tokens';
import { DecisionQueue } from '@/components/decisions/DecisionQueue';

interface DecisionActionSummary {
  updated: number;
  failed: number;
}

export function BulkDecisionsModal({
  open,
  onClose,
  decisions,
  onApproveDecision,
  onApproveAll,
}: {
  open: boolean;
  onClose: () => void;
  decisions: LiveDecision[];
  onApproveDecision: (decisionId: string) => Promise<DecisionActionSummary>;
  onApproveAll: () => Promise<DecisionActionSummary>;
}) {
  const longestWaitMinutes = useMemo(
    () => (decisions.length > 0 ? Math.max(0, ...decisions.map((d) => d.waitingMinutes)) : 0),
    [decisions]
  );

  const urgencyColor = useMemo(() => {
    if (decisions.length >= 20 || longestWaitMinutes >= 15) return colors.red;
    if (decisions.length > 0) return colors.amber;
    return colors.textMuted;
  }, [decisions.length, longestWaitMinutes]);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex h-full w-full flex-col">
        <div className="border-b border-white/[0.06] px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="inline-flex items-center gap-2 text-[15px] font-semibold text-white">
                <EntityIcon type="decision" size={14} />
                <span className="truncate">Decisions</span>
                <span
                  className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    borderColor: `${urgencyColor}30`,
                    backgroundColor: `${urgencyColor}14`,
                    color: urgencyColor,
                  }}
                >
                  {decisions.length}
                </span>
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-white/45">
                Bulk review and resolve pending decisions.
              </p>
              {decisions.length > 0 && (
                <p className="mt-2 text-[11px] text-white/55">
                  Longest waiting: <span className="font-semibold text-white">{longestWaitMinutes}m</span>
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08]"
              aria-label="Close decisions modal"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <DecisionQueue
            decisions={decisions}
            onApproveDecision={onApproveDecision}
            onApproveAll={onApproveAll}
          />
        </div>
      </div>
    </Modal>
  );
}

