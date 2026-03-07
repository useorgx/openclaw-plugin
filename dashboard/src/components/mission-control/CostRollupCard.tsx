import { colors } from '@/lib/tokens';
import type { UsageControlPlaneSummary } from '@/types';

interface CostRollupCardProps {
  usage: UsageControlPlaneSummary | null;
  className?: string;
}

function formatCents(cents: number): string {
  if (cents >= 100_00) return `$${(cents / 100).toFixed(0)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function CostRollupCard({ usage, className }: CostRollupCardProps) {
  if (!usage) return null;

  const spent = usage.actual.costCents;
  const budget = usage.plan.includedBudgetCents;
  const remaining = usage.headroom.budgetRemainingCents;
  const utilization = usage.utilization.budgetPct ?? 0;
  const dailyAvg = usage.velocity.dailyAvgCostCents;

  const barColor =
    utilization > 85 ? colors.red : utilization > 60 ? colors.amber : colors.lime;
  const remainingColor =
    utilization > 85 ? colors.red : utilization > 60 ? colors.amber : colors.lime;

  return (
    <div className={`subsection-shell rounded-2xl px-5 py-4 ${className ?? ''}`}>
      <p className="section-kicker font-semibold mb-3">Budget & Spend</p>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">Spent</p>
          <p className="mt-1 text-title font-light tabular-nums text-primary">
            {formatCents(spent)}
          </p>
        </div>
        <div>
          <p className="text-micro font-semibold uppercase tracking-[0.08em] text-muted">Remaining</p>
          <p
            className="mt-1 text-title font-light tabular-nums"
            style={{ color: remainingColor }}
          >
            {formatCents(remaining)}
          </p>
        </div>
      </div>
      {/* Budget bar */}
      {budget > 0 && (
        <div className="mt-3">
          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(utilization, 100)}%`,
                background: `linear-gradient(90deg, ${barColor}, ${barColor}cc)`,
              }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-micro text-muted">
            <span className="tabular-nums">{Math.round(utilization)}% utilized</span>
            {dailyAvg > 0 && (
              <span className="tabular-nums">~{formatCents(dailyAvg)}/day</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
