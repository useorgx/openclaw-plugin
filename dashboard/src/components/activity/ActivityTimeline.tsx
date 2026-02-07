import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import type { LiveActivityItem, LiveActivityType, SessionTreeNode } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';

const itemVariants = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
};

interface ActivityTimelineProps {
  activity: LiveActivityItem[];
  sessions: SessionTreeNode[];
  selectedRunId: string | null;
  onClearSelection: () => void;
}

const MAX_RENDERED_ACTIVITY = 220;

type ActivityBucket = 'message' | 'artifact' | 'decision';
type ActivityFilterId = 'all' | 'messages' | 'artifacts' | 'decisions';
type SortOrder = 'newest' | 'oldest';

const filterLabels: Record<ActivityFilterId, string> = {
  all: 'All',
  messages: 'Messages',
  artifacts: 'Artifacts',
  decisions: 'Decisions',
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

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value === 'string' &&
      (key.toLowerCase().includes('type') ||
        key.toLowerCase().includes('kind') ||
        key.toLowerCase().includes('summary') ||
        key.toLowerCase().includes('message') ||
        key.toLowerCase().includes('artifact') ||
        key.toLowerCase().includes('decision') ||
        key.toLowerCase().includes('run') ||
        key.toLowerCase().includes('title') ||
        key.toLowerCase().includes('task') ||
        key.toLowerCase().includes('workstream') ||
        key.toLowerCase().includes('milestone'))
    ) {
      parts.push(value);
    }
  }
  return parts.join(' ');
}

function resolveRunId(item: LiveActivityItem): string | null {
  if (item.runId) return item.runId;
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const candidates = ['runId', 'run_id', 'sessionId', 'session_id', 'agentRunId'];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function classifyActivity(item: LiveActivityItem): ActivityBucket {
  const metadataText = textFromMetadata(item.metadata as Record<string, unknown> | undefined);
  const combined = [item.type, item.kind, item.summary, item.title, item.description, metadataText]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const looksLikeArtifact =
    item.type === 'artifact_created' ||
    /artifact|output|diff|patch|commit|pr|pull request|deliverable/.test(combined);
  if (looksLikeArtifact) return 'artifact';

  const looksLikeDecision =
    item.type === 'decision_requested' ||
    item.type === 'decision_resolved' ||
    item.decisionRequired === true ||
    /decision|approve|approval|reject|review request|request changes/.test(combined);
  if (looksLikeDecision) return 'decision';

  return 'message';
}

function labelForType(type: LiveActivityType): string {
  return type.split('_').join(' ');
}

function toDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return String(local.getTime());
}

function dayLabel(dayKey: string): string {
  const epoch = Number(dayKey);
  if (!Number.isFinite(epoch)) return 'Unknown day';
  const day = new Date(epoch);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === yesterday.getTime()) return 'Yesterday';

  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: day.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export const ActivityTimeline = memo(function ActivityTimeline({
  activity,
  sessions,
  selectedRunId,
  onClearSelection,
}: ActivityTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<ActivityFilterId>('all');
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  const runLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.runId, session.title);
      map.set(session.id, session.title);
    }
    return map;
  }, [sessions]);

  const { filtered, truncatedCount } = useMemo(() => {
    const visible: LiveActivityItem[] = [];
    let overflow = 0;
    const normalizedQuery = query.trim().toLowerCase();

    for (const item of activity) {
      const runId = resolveRunId(item);
      if (selectedRunId && runId !== selectedRunId) {
        continue;
      }

      const bucket = classifyActivity(item);
      if (activeFilter === 'messages' && bucket !== 'message') continue;
      if (activeFilter === 'artifacts' && bucket !== 'artifact') continue;
      if (activeFilter === 'decisions' && bucket !== 'decision') continue;

      if (normalizedQuery.length > 0) {
        const runLabel = runId ? runLabelById.get(runId) ?? runId : '';
        const haystack = [
          item.title,
          item.description,
          item.summary,
          item.agentName,
          runLabel,
          textFromMetadata(item.metadata as Record<string, unknown> | undefined),
        ]
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(normalizedQuery)) continue;
      }

      if (visible.length < MAX_RENDERED_ACTIVITY) {
        visible.push(item);
      } else {
        overflow += 1;
      }
    }

    const sorted = [...visible].sort((a, b) => {
      const delta = toEpoch(b.timestamp) - toEpoch(a.timestamp);
      return sortOrder === 'newest' ? delta : -delta;
    });

    return {
      filtered: sorted,
      truncatedCount: overflow,
    };
  }, [activeFilter, activity, query, runLabelById, selectedRunId, sortOrder]);

  const grouped = useMemo(() => {
    const map = new Map<string, LiveActivityItem[]>();
    for (const item of filtered) {
      const key = toDayKey(item.timestamp);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(item);
      } else {
        map.set(key, [item]);
      }
    }

    const keys = Array.from(map.keys()).sort((a, b) => {
      const delta = Number(b) - Number(a);
      return sortOrder === 'newest' ? delta : -delta;
    });

    return keys.map((key) => ({
      key,
      label: dayLabel(key),
      items: map.get(key) ?? [],
    }));
  }, [filtered, sortOrder]);

  const renderItem = (item: LiveActivityItem, index: number) => {
    const color = typeColor[item.type] ?? colors.iris;
    const isRecent = sortOrder === 'newest' && index < 2;
    const bucket = classifyActivity(item);
    const runId = resolveRunId(item);
    const runLabel = runId ? runLabelById.get(runId) ?? runId : 'Workspace';

    return (
      <motion.article
        key={item.id}
        variants={itemVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
        layout
        className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex items-start gap-2.5">
          <span
            className={cn('mt-1.5 h-2.5 w-2.5 rounded-full', isRecent && 'pulse-soft')}
            style={{
              backgroundColor: color,
              boxShadow: `0 0 16px ${color}77`,
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] text-white/90">
                <span className="font-semibold text-white">
                  {item.agentName ?? 'System'}
                </span>{' '}
                {item.title}
              </p>
              <span className="text-[9px] uppercase tracking-[0.1em] text-white/35">
                {labelForType(item.type)}
              </span>
            </div>

            {(item.summary || item.description) && (
              <p className="mt-1 text-[10px] leading-relaxed text-white/55">
                {item.summary ?? item.description}
              </p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
              <span
                className="rounded-full border px-1.5 py-0.5 uppercase tracking-[0.08em]"
                style={{
                  borderColor:
                    bucket === 'artifact'
                      ? `${colors.cyan}66`
                      : bucket === 'decision'
                        ? `${colors.amber}66`
                        : `${colors.teal}66`,
                  color:
                    bucket === 'artifact'
                      ? colors.cyan
                      : bucket === 'decision'
                        ? colors.amber
                        : colors.teal,
                }}
              >
                {bucket === 'artifact' ? 'artifact' : bucket === 'decision' ? 'decision' : 'message'}
              </span>
              <span className="rounded-full border border-white/[0.12] px-1.5 py-0.5 text-white/55">
                {runLabel}
              </span>
              <span className="text-white/35">
                {new Date(item.timestamp).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className="text-white/35">{formatRelativeTime(item.timestamp)}</span>
            </div>
          </div>
        </div>
      </motion.article>
    );
  };

  return (
    <PremiumCard className="flex min-h-0 flex-col fade-in-up">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-[13px] font-semibold text-white">Activity</h2>
            <span className="relative flex h-1.5 w-1.5">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                style={{ backgroundColor: colors.lime }}
              />
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: colors.lime }}
              />
            </span>

            {selectedRunId && (
              <button onClick={onClearSelection} className="chip text-[10px]">
                Session filtered
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
              className="rounded-md border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-[10px] text-white/60 transition-colors hover:text-white"
            >
              {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
            <button
              onClick={() => setCollapsed((prev) => !prev)}
              className="text-[10px] text-white/55 transition-colors hover:text-white"
            >
              {collapsed ? 'Expand groups' : 'Collapse groups'}
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search messages, artifacts, decisions, or run labels..."
              className="w-full rounded-lg border border-white/[0.1] bg-black/30 py-1.5 pl-7 pr-2 text-[10px] text-white/80 placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-white/30"
            />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(Object.keys(filterLabels) as ActivityFilterId[]).map((filterId) => (
            <button
              key={filterId}
              onClick={() => setActiveFilter(filterId)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[10px] font-medium transition-all duration-200',
                activeFilter === filterId
                  ? 'border border-lime/25 bg-lime/[0.12] text-lime shadow-[0_0_10px_rgba(191,255,0,0.08)]'
                  : 'border border-transparent bg-white/[0.03] text-white/50 hover:bg-white/[0.06] hover:text-white/80'
              )}
            >
              {filterLabels[filterId]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-6 text-center">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/25"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <p className="text-[11px] text-white/45">
              {selectedRunId
                ? `No ${filterLabels[activeFilter].toLowerCase()} for the selected session.`
                : 'No matching activity right now.'}
            </p>
            {selectedRunId && (
              <button
                onClick={onClearSelection}
                className="rounded-md border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                Show all sessions
              </button>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-4">
            {grouped.map((group) => {
              const visibleItems = collapsed ? group.items.slice(0, 4) : group.items;
              return (
                <section key={group.key}>
                  <h3 className="mb-2 text-[10px] uppercase tracking-[0.12em] text-white/35">
                    {group.label}
                  </h3>
                  <AnimatePresence mode="popLayout">
                    <div className="space-y-2">
                      {visibleItems.map((item, index) => renderItem(item, index))}
                    </div>
                  </AnimatePresence>
                  {collapsed && group.items.length > visibleItems.length && (
                    <p className="mt-1.5 text-[10px] text-white/35">
                      +{group.items.length - visibleItems.length} more
                    </p>
                  )}
                </section>
              );
            })}

            {truncatedCount > 0 && (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] text-white/45">
                Showing latest {filtered.length} events ({truncatedCount} older events omitted for smooth rendering).
              </p>
            )}
          </div>
        )}
      </div>
    </PremiumCard>
  );
});
