import { memo, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { humanizeModel, humanizeText } from '@/lib/humanize';
import type { LiveActivityItem, LiveActivityType, SessionTreeNode } from '@/types';
import { AgentAvatar } from '@/components/agents/AgentAvatar';

interface ThreadViewProps {
  /** Activity items filtered to a single session. */
  items: LiveActivityItem[];
  /** The session this thread belongs to. */
  session: SessionTreeNode | null;
  /** Agent name for display. */
  agentName: string | null;
  /** Called to exit thread view. */
  onBack: () => void;
}

const typeIcon: Record<string, string> = {
  artifact_created: '\u2B26', // diamond
  run_failed: '\u2717',       // cross
  run_started: '\u25B6',      // play
  run_completed: '\u2713',    // check
  decision_requested: '\u2753', // question
  decision_resolved: '\u2713',
  delegation: '\u2192',       // arrow
  blocker_created: '\u26A0',  // warning
  milestone_completed: '\u2605', // star
};

const typeColor: Record<LiveActivityType, string> = {
  run_started: colors.teal,
  run_completed: colors.lime,
  run_failed: colors.red,
  artifact_created: colors.cyan,
  decision_requested: colors.amber,
  decision_resolved: colors.lime,
  handoff_requested: colors.iris,
  handoff_claimed: colors.teal,
  handoff_fulfilled: colors.lime,
  blocker_created: colors.red,
  milestone_completed: colors.cyan,
  delegation: colors.iris,
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatCost(items: LiveActivityItem[]): string | null {
  let total = 0;
  for (const item of items) {
    const cost = (item.metadata as Record<string, unknown> | undefined)?.costTotal;
    if (typeof cost === 'number') total += cost;
  }
  if (total <= 0) return null;
  if (total < 0.01) return `$${total.toFixed(4)}`;
  return `$${total.toFixed(2)}`;
}

export const ThreadView = memo(function ThreadView({
  items,
  session,
  agentName,
  onBack,
}: ThreadViewProps) {
  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      ),
    [items]
  );

  const cost = useMemo(() => formatCost(sorted), [sorted]);

  const duration = useMemo(() => {
    if (sorted.length < 2) return null;
    const first = Date.parse(sorted[0].timestamp);
    const last = Date.parse(sorted[sorted.length - 1].timestamp);
    const diffMs = last - first;
    if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
    if (diffMs < 3600_000) return `${Math.round(diffMs / 60_000)}m`;
    return `${(diffMs / 3600_000).toFixed(1)}h`;
  }, [sorted]);

  const sessionTitle = session?.title ?? agentName ?? 'Session';

  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="border-b border-white/[0.06] px-4 py-3">
        <button
          onClick={onBack}
          className="mb-2 flex items-center gap-1.5 text-[11px] text-white/50 transition-colors hover:text-white/80"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back to timeline
        </button>

        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: colors.lime,
              boxShadow: `0 0 12px ${colors.lime}55`,
            }}
          />
          <h3 className="text-[14px] font-semibold text-white">
            {humanizeText(sessionTitle)}
          </h3>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-white/45">
          {agentName && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] px-1 py-0.5">
              <AgentAvatar name={agentName} hint={session?.id ?? session?.runId ?? null} size="xs" />
              <span>{agentName}</span>
            </span>
          )}
          <span>{sorted.length} turn{sorted.length !== 1 ? 's' : ''}</span>
          {duration && <span>{duration}</span>}
          {cost && (
            <span className="text-white/35">{cost}</span>
          )}
          {session?.status && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
              style={{
                backgroundColor:
                  session.status === 'running'
                    ? `${colors.lime}20`
                    : session.status === 'failed'
                      ? `${colors.red}20`
                      : `${colors.teal}20`,
                color:
                  session.status === 'running'
                    ? colors.lime
                    : session.status === 'failed'
                      ? colors.red
                      : colors.teal,
              }}
            >
              {session.status}
            </span>
          )}
        </div>
      </div>

      {/* Turn list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <AnimatePresence mode="popLayout">
          <div className="relative">
            {/* Vertical connector line */}
            <div
              className="absolute left-[7px] top-3 bottom-3 w-px"
              style={{ backgroundColor: `${colors.iris}25` }}
            />

            <div className="space-y-1">
              {sorted.map((item, index) => {
                const color = typeColor[item.type] ?? colors.iris;
                const icon = typeIcon[item.type] ?? '\u2192';
                const model = humanizeModel(item.description);
                const title = humanizeText(item.title ?? '');
                const isError = item.type === 'run_failed';
                const isArtifact = item.type === 'artifact_created';
                const isDecision =
                  item.type === 'decision_requested' ||
                  item.type === 'decision_resolved';

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.02 }}
                    className="group relative flex items-start gap-2.5 rounded-lg py-1.5 pl-0 pr-2 transition-colors hover:bg-white/[0.02]"
                  >
                    {/* Dot on the timeline */}
                    <span
                      className="relative z-10 mt-1.5 flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-full text-[8px]"
                      style={{
                        backgroundColor: `${color}20`,
                        color,
                        border: `1px solid ${color}40`,
                      }}
                    >
                      {icon}
                    </span>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[12px] leading-snug ${
                          isError
                            ? 'text-red-400'
                            : isDecision
                              ? 'text-amber-300'
                              : isArtifact
                                ? 'text-cyan-300'
                                : 'text-white/85'
                        }`}
                      >
                        {title}
                      </p>

                      {item.summary && item.summary !== title && (
                        <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">
                          {humanizeText(item.summary)}
                        </p>
                      )}
                    </div>

                    {/* Right side: time + model */}
                    <div className="flex flex-shrink-0 flex-col items-end gap-0.5 pt-0.5">
                      <span className="text-[10px] text-white/35">
                        {formatTime(item.timestamp)}
                      </span>
                      {model && (
                        <span className="text-[9px] text-white/25">
                          {model}
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </AnimatePresence>

        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-[12px] text-white/40">No activity in this session yet.</p>
          </div>
        )}

        {/* Session summary footer */}
        {sorted.length > 0 && (
          <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/35">
            {sorted.length} turn{sorted.length !== 1 ? 's' : ''}
            {duration ? ` over ${duration}` : ''}
            {cost ? ` \u00B7 ${cost}` : ''}
            {' \u00B7 '}
            {formatRelativeTime(sorted[sorted.length - 1].timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
