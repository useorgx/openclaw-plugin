import { memo, useMemo } from 'react';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import type { HandoffSummary } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';

interface HandoffPanelProps {
  handoffs: HandoffSummary[];
}

const MAX_VISIBLE_HANDOFFS = 80;

function progressForStatus(status: string) {
  if (status === 'fulfilled' || status === 'completed') return 100;
  if (status === 'claimed') return 66;
  return 33;
}

function statusColor(status: string): string {
  if (status === 'fulfilled' || status === 'completed') return colors.lime;
  if (status === 'claimed') return colors.teal;
  return colors.amber;
}

export const HandoffPanel = memo(function HandoffPanel({ handoffs }: HandoffPanelProps) {
  const ordered = useMemo(() => {
    if (handoffs.length <= 1) {
      return handoffs;
    }

    return [...handoffs].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }, [handoffs]);

  const visible = ordered.slice(0, MAX_VISIBLE_HANDOFFS);
  const truncatedCount = Math.max(0, ordered.length - visible.length);

  return (
    <PremiumCard className="flex min-h-0 flex-col fade-in-up">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-white">Handoffs</h2>
        <span className="chip">{handoffs.length}</span>
      </div>

      <div className="max-h-[38vh] space-y-2 overflow-y-auto p-3">
        {visible.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] text-white/45">
            No open handoffs.
          </div>
        )}

        {visible.map((handoff) => {
          const color = statusColor(handoff.status);
          const progress = progressForStatus(handoff.status);

          return (
            <article
              key={handoff.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.05]"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-medium text-white">{handoff.title}</p>
                <span className="text-[9px] uppercase tracking-[0.1em] text-white/45">
                  {handoff.priority ?? 'normal'}
                </span>
              </div>

              {handoff.summary && (
                <p className="mt-1 text-[10px] text-white/55">{handoff.summary}</p>
              )}

              <div className="mt-2 h-1.5 rounded-full bg-white/[0.08]">
                <div
                  className="h-1.5 rounded-full"
                  style={{
                    width: `${progress}%`,
                    background: `linear-gradient(90deg, ${color}, ${colors.teal})`,
                  }}
                />
              </div>

              <div className="mt-2 flex items-center justify-between text-[9px] text-white/35">
                <span className="uppercase tracking-[0.1em]">{handoff.status}</span>
                <span>Updated {formatRelativeTime(handoff.updatedAt)}</span>
              </div>
            </article>
          );
        })}

        {truncatedCount > 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/45">
            Showing latest {visible.length} handoffs ({truncatedCount} older handoffs omitted).
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
