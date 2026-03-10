import type { LiveActivityItem } from '@/types';
import { humanizeActivityNarrative } from '@/lib/humanize';
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
  const narrative = useMemo(() => humanizeActivityNarrative(item), [item]);
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
  const hasMeaningfulContent =
    narrative.scope ||
    narrative.update ||
    narrative.status ||
    narrative.artifacts.length > 0 ||
    narrative.outcomes.length > 0 ||
    narrative.nextUp.length > 0;
  const fallbackTask = !hasMeaningfulContent
    ? `${agentName} recorded a ${eventType}`
    : null;

  const rows = [
    narrative.update ? { label: 'Update', value: narrative.update } : null,
    (narrative.scope || fallbackTask) ? { label: 'Scope', value: narrative.scope ?? fallbackTask! } : null,
    narrative.status ? { label: 'Status', value: narrative.status } : null,
    narrative.artifacts.length > 0 ? { label: 'Artifacts', values: narrative.artifacts } : null,
    narrative.outcomes.length > 0 ? { label: 'Outcomes', values: narrative.outcomes } : null,
    narrative.nextUp.length > 0 ? { label: 'Next up', values: narrative.nextUp } : null,
  ].filter(Boolean) as Array<{ label: string; value?: string; values?: string[] }>;

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
          <SummaryRow label={row.label} value={row.value} values={row.values} styles={styles} />
        </motion.div>
      ))}
    </motion.div>
  );
}

function SummaryRow({
  label,
  value,
  values,
  styles,
}: {
  label: string;
  value?: string;
  values?: string[];
  styles: (typeof TONE_STYLES)[keyof typeof TONE_STYLES];
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <span className={`text-micro font-semibold uppercase tracking-wider ${styles.label}`}>
          {label}
        </span>
        {typeof value === 'string' ? (
          <p className="mt-1 text-body leading-relaxed text-primary">{value}</p>
        ) : null}
        {Array.isArray(values) && values.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {values.slice(0, 5).map((entry) => (
              <li key={entry} className="text-body leading-relaxed text-primary">
                {entry}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
