import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';

interface BurstItem {
  title: string;
  status: 'completed' | 'needs_attention' | 'in_progress' | 'blocked' | 'unknown';
  timestamp: string;
}

interface AutopilotBurstSummaryProps {
  workstreamTitle: string;
  items: BurstItem[];
  firstTimestamp: number;
  lastTimestamp: number;
  onExpandItem?: (index: number) => void;
}

const STATUS_DOT: Record<string, string> = {
  completed: colors.lime,
  needs_attention: colors.amber,
  in_progress: colors.teal,
  blocked: colors.red,
  unknown: 'rgba(255,255,255,0.4)',
};

export function AutopilotBurstSummary({
  workstreamTitle,
  items,
  firstTimestamp,
  lastTimestamp,
  onExpandItem,
}: AutopilotBurstSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  const counts = items.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const startTime = new Date(firstTimestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endTime = new Date(lastTimestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-micro" style={{ color: colors.teal, opacity: 0.8 }}>&#8734;</span>
            <p className="text-body font-semibold text-bright">
              Autopilot ran {items.length} sessions in &ldquo;{workstreamTitle}&rdquo;
            </p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption text-secondary">
            {counts.completed && counts.completed > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors.lime }} />
                {counts.completed} completed
              </span>
            )}
            {counts.needs_attention && counts.needs_attention > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors.amber }} />
                {counts.needs_attention} needs attention
              </span>
            )}
            {counts.in_progress && counts.in_progress > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full status-breathe" style={{ backgroundColor: colors.teal }} />
                {counts.in_progress} in progress
              </span>
            )}
            {counts.blocked && counts.blocked > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors.red }} />
                {counts.blocked} blocked
              </span>
            )}
          </div>
          <p className="mt-1 text-micro text-muted tabular-nums">
            {startTime} — {endTime}
          </p>
        </div>
        <span className="mt-1.5 text-micro text-muted">
          {expanded ? 'Hide' : 'Show details'}
        </span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
              {items.map((item, i) => (
                <motion.button
                  key={`burst-${i}`}
                  type="button"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.15 }}
                  onClick={() => onExpandItem?.(i)}
                  className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left hover:bg-white/[0.05]"
                >
                  <span
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_DOT[item.status] ?? STATUS_DOT.unknown }}
                  />
                  <span className="min-w-0 flex-1 truncate text-caption text-primary">{item.title}</span>
                  <span className="flex-shrink-0 text-micro text-muted">{formatRelativeTime(item.timestamp)}</span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
