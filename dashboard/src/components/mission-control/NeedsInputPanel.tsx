import { memo, useMemo } from 'react';
import type { SliceRunProjection } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { formatRelativeTime } from '@/lib/time';

interface NeedsInputPanelProps {
  sliceRuns: SliceRunProjection[];
  title?: string;
  className?: string;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  onOpenDecisions?: () => void;
  onFocusRunId?: (runId: string) => void;
}

const NEEDS_INPUT_STATES = new Set(['awaiting_input', 'needs_review', 'failed']);

function statusTone(status: SliceRunProjection['status']): string {
  if (status === 'failed') return 'border-red-400/30 bg-red-500/[0.10] text-red-100';
  if (status === 'needs_review') return 'border-amber-300/30 bg-amber-300/[0.10] text-amber-100';
  return 'border-[#BFFF00]/30 bg-[#BFFF00]/12 text-[#E1FFB2]';
}

function statusLabel(status: SliceRunProjection['status']): string {
  if (status === 'awaiting_input') return 'Needs input';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'failed') return 'Failed';
  return status.replace(/_/g, ' ');
}

function actionLabel(item: SliceRunProjection): string {
  if (item.primaryAction === 'resolve_decision') return 'Review decisions';
  if (item.primaryAction === 'open_artifact') return 'Open artifact';
  if (item.primaryAction === 'retry_slice') return 'Open timeline';
  if (item.primaryAction === 'review_output') return 'Review output';
  return 'Open details';
}

export const NeedsInputPanel = memo(function NeedsInputPanel({
  sliceRuns,
  title = 'Needs Input',
  className,
  showHeader = true,
  panelStyle = 'card',
  onOpenDecisions,
  onFocusRunId,
}: NeedsInputPanelProps) {
  const rows = useMemo(() => {
    const filtered = sliceRuns.filter((item) => NEEDS_INPUT_STATES.has(item.status));
    return filtered.sort((a, b) => {
      const aEpoch = Date.parse(a.updatedAt ?? a.lastEventAt ?? '');
      const bEpoch = Date.parse(b.updatedAt ?? b.lastEventAt ?? '');
      const safeA = Number.isFinite(aEpoch) ? aEpoch : 0;
      const safeB = Number.isFinite(bEpoch) ? bEpoch : 0;
      return safeB - safeA;
    });
  }, [sliceRuns]);

  const runPrimaryAction = (item: SliceRunProjection) => {
    if (item.primaryAction === 'resolve_decision') {
      onOpenDecisions?.();
      return;
    }
    if (item.primaryAction === 'open_artifact') {
      const firstUrl = item.artifacts.find((artifact) => artifact.url)?.url;
      if (firstUrl && typeof window !== 'undefined') {
        window.open(firstUrl, '_blank', 'noopener,noreferrer');
        return;
      }
    }
    if (item.runId) {
      onFocusRunId?.(item.runId);
      return;
    }
    if (item.sliceRunId) {
      onFocusRunId?.(item.sliceRunId);
    }
  };

  return (
    <PremiumCard
      surface={panelStyle === 'card'}
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        panelStyle === 'flat' ? '!rounded-none !border-none !bg-transparent !shadow-none' : ''
      } ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip text-micro">{rows.length}</span>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="px-4 py-4 text-body text-secondary">
          No slices need intervention right now.
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
          {rows.map((item) => {
            const label = item.workstreamTitle ?? item.workstreamId ?? item.sliceRunId;
            const subtitle =
              item.statusExplainer?.trim().length
                ? item.statusExplainer
                : 'Review this slice to continue execution.';
            const when = item.updatedAt ?? item.lastEventAt ?? null;
            return (
              <div
                key={item.sliceRunId}
                className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-body font-semibold leading-snug text-white" title={label}>
                      {label}
                    </p>
                    <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={subtitle}>
                      {subtitle}
                    </p>
                  </div>
                  <span
                    className={`inline-flex h-6 items-center rounded-full border px-2 text-micro font-semibold uppercase tracking-[0.08em] ${statusTone(item.status)}`}
                  >
                    {statusLabel(item.status)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                  {typeof item.decisionCount === 'number' && item.decisionCount > 0 && (
                    <span className="chip text-micro">{item.decisionCount} decision{item.decisionCount === 1 ? '' : 's'}</span>
                  )}
                  {typeof item.artifactCount === 'number' && item.artifactCount > 0 && (
                    <span className="chip text-micro">{item.artifactCount} artifact{item.artifactCount === 1 ? '' : 's'}</span>
                  )}
                  {when && <span>Updated {formatRelativeTime(when)}</span>}
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => runPrimaryAction(item)}
                    className="control-pill h-7 px-2.5 text-micro font-semibold"
                  >
                    {actionLabel(item)}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PremiumCard>
  );
});

