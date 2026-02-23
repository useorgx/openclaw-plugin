import { cn } from '@/lib/utils';
import { useUsageControlPlane } from '@/hooks/useUsageControlPlane';
import type { UsageBreakdownBucket, UsageControlPlaneSummary, UsageRiskLevel } from '@/types';

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value)));
}

function formatCurrency(cents: number): string {
  const usd = (Math.max(0, cents) / 100).toFixed(2);
  return `$${usd}`;
}

function formatPercent(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.max(0, Math.round(value))}%`;
}

function riskClasses(risk: UsageRiskLevel): string {
  if (risk === 'over_limit') return 'border-rose-300/30 bg-rose-400/12 text-rose-100';
  if (risk === 'at_risk') return 'border-amber-300/30 bg-amber-400/12 text-amber-100';
  if (risk === 'watch') return 'border-teal-300/25 bg-teal-400/10 text-teal-100';
  return 'border-lime/30 bg-lime/[0.14] text-[#D8FFA1]';
}

function topBuckets(values: UsageBreakdownBucket[] | undefined, limit = 4): UsageBreakdownBucket[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  return [...values]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

function summaryUpdatedLabel(summary: UsageControlPlaneSummary): string {
  const epoch = Date.parse(summary.generatedAt);
  if (!Number.isFinite(epoch)) return 'Updated just now';
  const minutes = Math.max(0, Math.round((Date.now() - epoch) / 60_000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `Updated ${hours}h ago`;
}

export function UsageControlPlanePanel({
  authToken = null,
  embedMode = false,
  enabled = true,
}: {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}) {
  const usage = useUsageControlPlane({ authToken, embedMode, enabled });
  const summary = usage.summary;

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-heading font-semibold text-white">Usage control plane</h3>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            Actual vs predicted token, runtime, and cost usage for this billing period.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void usage.refetch()}
          disabled={usage.isFetching}
          className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {usage.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {usage.error ? (
        <div className="mt-3 rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-2.5 text-body text-rose-100">
          {usage.error}
        </div>
      ) : null}

      {!summary && usage.isLoading ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={`usage-loading-${index}`}
              className="h-[92px] animate-pulse rounded-xl border border-white/[0.08] bg-white/[0.03]"
            />
          ))}
        </div>
      ) : null}

      {summary ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full border px-2.5 py-1 text-caption font-semibold', riskClasses(summary.risk))}>
              {summary.risk.replace('_', ' ')}
            </span>
            <span className="chip">{summary.plan.name}</span>
            {summary.source ? <span className="chip">source: {summary.source}</span> : null}
            <span className="text-caption text-muted">{summaryUpdatedLabel(summary)}</span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Agent runs</p>
              <p className="mt-1 text-heading font-semibold text-white">
                {formatNumber(summary.actual.agentRuns)}
                <span className="ml-1 text-caption text-secondary">
                  / {summary.plan.agentRunsLimit > 0 ? formatNumber(summary.plan.agentRunsLimit) : '∞'}
                </span>
              </p>
              <p className="mt-1 text-caption text-muted">Forecast {formatNumber(summary.predicted.agentRuns)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Agent minutes</p>
              <p className="mt-1 text-heading font-semibold text-white">
                {formatNumber(summary.actual.agentMinutes)}
                <span className="ml-1 text-caption text-secondary">
                  / {summary.plan.agentMinutesLimit > 0 ? formatNumber(summary.plan.agentMinutesLimit) : '∞'}
                </span>
              </p>
              <p className="mt-1 text-caption text-muted">Forecast {formatNumber(summary.predicted.agentMinutes)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Tokens</p>
              <p className="mt-1 text-heading font-semibold text-white">{formatNumber(summary.actual.tokens)}</p>
              <p className="mt-1 text-caption text-muted">Forecast {formatNumber(summary.predicted.tokens)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Spend</p>
              <p className="mt-1 text-heading font-semibold text-white">
                {formatCurrency(summary.actual.costCents)}
                <span className="ml-1 text-caption text-secondary">
                  / {summary.plan.includedBudgetCents > 0 ? formatCurrency(summary.plan.includedBudgetCents) : '—'}
                </span>
              </p>
              <p className="mt-1 text-caption text-muted">Forecast {formatCurrency(summary.predicted.costCents)}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Run utilization</p>
              <p className="mt-1 text-caption font-semibold text-primary">{formatPercent(summary.utilization.runsPct)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Minute utilization</p>
              <p className="mt-1 text-caption font-semibold text-primary">{formatPercent(summary.utilization.minutesPct)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Budget utilization</p>
              <p className="mt-1 text-caption font-semibold text-primary">{formatPercent(summary.utilization.budgetPct)}</p>
            </div>
          </div>

          {topBuckets(summary.breakdown.sourceClient, 4).length > 0 ? (
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/20 p-3">
              <p className="text-caption font-semibold text-primary">Runtime client mix</p>
              <div className="mt-2 space-y-2">
                {topBuckets(summary.breakdown.sourceClient, 4).map((bucket) => {
                  const ratio =
                    summary.actual.tokens > 0
                      ? Math.max(0, Math.min(100, Math.round((bucket.tokens / summary.actual.tokens) * 100)))
                      : 0;
                  return (
                    <div key={`usage-source-${bucket.key}`} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-caption text-secondary">{bucket.label}</span>
                        <span className="text-caption text-primary">
                          {formatNumber(bucket.tokens)} tokens · {formatNumber(bucket.runs)} runs
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/[0.08]">
                        <div
                          className="h-1.5 rounded-full bg-lime/80 transition-all"
                          style={{ width: `${Math.max(6, ratio)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {Array.isArray(summary.warnings) && summary.warnings.length > 0 ? (
            <div className="mt-3 rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2.5">
              <p className="text-caption font-semibold text-amber-100">Usage warnings</p>
              <ul className="mt-1 space-y-1">
                {summary.warnings.slice(0, 3).map((warning, index) => (
                  <li key={`usage-warning-${index}`} className="text-caption text-amber-100/90">
                    • {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

