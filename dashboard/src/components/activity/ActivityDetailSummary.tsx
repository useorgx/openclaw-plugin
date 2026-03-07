import type { LiveActivityItem } from '@/types';
import { humanizeActivitySummary } from '@/lib/humanize';
import { useMemo } from 'react';
import { motion } from 'framer-motion';

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
    border: 'border-[#0AD4C4]/20',
    bg: 'bg-[#0AD4C4]/[0.04]',
    dot: 'bg-[#0AD4C4]',
    label: 'text-[#7AEDE5]',
  },
  amber: {
    border: 'border-[#F5B700]/20',
    bg: 'bg-[#F5B700]/[0.04]',
    dot: 'bg-[#F5B700]',
    label: 'text-[#FFE7A8]',
  },
  red: {
    border: 'border-[#FF6B6B]/20',
    bg: 'bg-[#FF6B6B]/[0.04]',
    dot: 'bg-[#FF6B6B]',
    label: 'text-[#FFA8A8]',
  },
  neutral: {
    border: 'border-white/[0.04]',
    bg: 'bg-white/[0.02]',
    dot: 'bg-white/40',
    label: 'text-secondary',
  },
} as const;

export function ActivityDetailSummary({ item, className }: ActivityDetailSummaryProps) {
  const summary = useMemo(() => humanizeActivitySummary(item), [item]);
  const tone = resolveTone(item);
  const styles = TONE_STYLES[tone];

  // Synthesize fallback content — never return null
  const agentName = (
    typeof (item.metadata as Record<string, unknown>)?.agent_name === 'string'
      ? (item.metadata as Record<string, unknown>).agent_name as string
      : typeof (item.metadata as Record<string, unknown>)?.agentName === 'string'
        ? (item.metadata as Record<string, unknown>).agentName as string
        : item.agentName ?? 'OrgX'
  );
  const eventType = item.type?.replace(/_/g, ' ') ?? 'activity';
  const hasMeaningfulContent = summary.taskDescription || summary.outcomeDescription || summary.nextStep;
  const fallbackTask = !hasMeaningfulContent
    ? `${agentName} recorded a ${eventType}`
    : null;

  const rows = [
    (summary.taskDescription || fallbackTask) ? { label: 'Task', value: summary.taskDescription ?? fallbackTask! } : null,
    summary.outcomeDescription ? { label: 'Outcome', value: summary.outcomeDescription } : null,
    summary.nextStep ? { label: 'Next step', value: summary.nextStep } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={`rounded-lg border ${styles.border} ${styles.bg} p-6 space-y-5 ${className ?? ''}`}
    >
      {rows.map((row, i) => (
        <motion.div
          key={row.label}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.08 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
        >
          <SummaryRow label={row.label} value={row.value} styles={styles} />
        </motion.div>
      ))}
    </motion.div>
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
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <span className={`text-micro font-semibold uppercase tracking-wider ${styles.label}`}>
          {label}
        </span>
        <p className="text-body leading-relaxed text-primary mt-1">{value}</p>
      </div>
    </div>
  );
}
