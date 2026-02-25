import type { LiveActivityItem } from '@/types';
import { humanizeActivitySummary } from '@/lib/humanize';
import { useMemo } from 'react';

interface ActivityDetailSummaryProps {
  item: LiveActivityItem;
  className?: string;
}

function resolveTone(item: LiveActivityItem): 'teal' | 'amber' | 'red' | 'neutral' {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const phase = item.phase ?? item.state ?? (meta.phase as string | undefined) ?? '';
  const state = item.state ?? '';
  const eventName = (meta.event ?? meta.event_name ?? '') as string;

  if (
    phase === 'completed' ||
    eventName === 'auto_continue_started' ||
    state === 'completed'
  ) {
    return 'teal';
  }
  if (
    phase === 'blocked' ||
    state === 'blocked' ||
    state === 'error' ||
    eventName === 'auto_continue_stopped'
  ) {
    const stopReason = (meta.stop_reason ?? '') as string;
    if (stopReason === 'error' || stopReason === 'blocked') return 'red';
    if (stopReason === 'budget_exhausted' || stopReason === 'stopped') return 'amber';
    if (phase === 'blocked' || state === 'error') return 'red';
    return 'amber';
  }
  if (item.decisionRequired || state === 'needs_input') {
    return 'amber';
  }
  return 'neutral';
}

const TONE_STYLES = {
  teal: {
    border: 'border-[#0AD4C4]/30',
    bg: 'bg-[#0AD4C4]/[0.06]',
    dot: 'bg-[#0AD4C4]',
    label: 'text-[#7AEDE5]',
  },
  amber: {
    border: 'border-[#F5B700]/30',
    bg: 'bg-[#F5B700]/[0.06]',
    dot: 'bg-[#F5B700]',
    label: 'text-[#FFE7A8]',
  },
  red: {
    border: 'border-[#FF6B6B]/30',
    bg: 'bg-[#FF6B6B]/[0.06]',
    dot: 'bg-[#FF6B6B]',
    label: 'text-[#FFA8A8]',
  },
  neutral: {
    border: 'border-white/[0.08]',
    bg: 'bg-white/[0.03]',
    dot: 'bg-white/40',
    label: 'text-secondary',
  },
} as const;

export function ActivityDetailSummary({ item, className }: ActivityDetailSummaryProps) {
  const summary = useMemo(() => humanizeActivitySummary(item), [item]);
  const tone = resolveTone(item);
  const styles = TONE_STYLES[tone];

  // Don't render if we have no meaningful content
  if (!summary.taskDescription && !summary.outcomeDescription && !summary.nextStep) {
    return null;
  }

  return (
    <div
      className={`rounded-lg border ${styles.border} ${styles.bg} p-3 space-y-2.5 ${className ?? ''}`}
    >
      {summary.taskDescription && (
        <SummaryRow label="Task" value={summary.taskDescription} styles={styles} />
      )}
      {summary.outcomeDescription && (
        <SummaryRow label="Outcome" value={summary.outcomeDescription} styles={styles} />
      )}
      {summary.nextStep && (
        <SummaryRow label="Next step" value={summary.nextStep} styles={styles} />
      )}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: (typeof TONE_STYLES)[keyof typeof TONE_STYLES];
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${styles.dot}`}
      />
      <div className="min-w-0 flex-1">
        <span className={`text-micro font-semibold uppercase tracking-wider ${styles.label}`}>
          {label}
        </span>
        <p className="text-body leading-snug text-primary mt-0.5">{value}</p>
      </div>
    </div>
  );
}
