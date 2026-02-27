import { useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import type { Initiative } from '@/types';
import { CollapsibleSection } from './CollapsibleSection';

/* ────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────── */

const TEAL = '#14B8A6';

/** Statuses that represent "successfully completed" (trophy-case worthy). */
const COMPLETED_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'resolved',
  'success',
  'succeeded',
]);

function isCompletedStatus(status: string): boolean {
  const s = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return COMPLETED_STATUSES.has(s);
}

/* ────────────────────────────────────────────────────────────────────
 * Date grouping
 * ──────────────────────────────────────────────────────────────────── */

type DateGroup = 'Today' | 'Yesterday' | 'This Week' | 'Earlier';

function getDateGroup(dateStr: string | null | undefined): DateGroup {
  if (!dateStr) return 'Earlier';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 'Earlier';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86_400_000);

  if (date >= startOfToday) return 'Today';
  if (date >= startOfYesterday) return 'Yesterday';
  if (date >= startOfWeek) return 'This Week';
  return 'Earlier';
}

const DATE_GROUP_ORDER: DateGroup[] = ['Today', 'Yesterday', 'This Week', 'Earlier'];

/* ────────────────────────────────────────────────────────────────────
 * Celebration tracking (once per session per initiative)
 * ──────────────────────────────────────────────────────────────────── */

const CELEBRATION_KEY_PREFIX = 'orgx.celebrated.';

function hasCelebrated(initiativeId: string): boolean {
  try {
    return sessionStorage.getItem(`${CELEBRATION_KEY_PREFIX}${initiativeId}`) === '1';
  } catch {
    return true; // fail closed — no glow
  }
}

function markCelebrated(initiativeId: string): void {
  try {
    sessionStorage.setItem(`${CELEBRATION_KEY_PREFIX}${initiativeId}`, '1');
  } catch {
    // ignore
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Artifact chip types (derived from workstreams or inline data)
 * ──────────────────────────────────────────────────────────────────── */

interface ArtifactChipData {
  type: string;
  label: string;
}

function deriveArtifactTypesFromInitiative(_initiative: Initiative): ArtifactChipData[] {
  // In a real implementation, artifact data would come from the API.
  // For now, we derive placeholder chips from the initiative status/name
  // when artifact counts are available in the future.
  return [];
}

/* ────────────────────────────────────────────────────────────────────
 * Animated Checkmark
 * ──────────────────────────────────────────────────────────────────── */

function AnimatedCheckmark({ size = 16 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="flex-shrink-0"
    >
      <motion.path
        d="M3 8.5L6.5 12L13 4"
        fill="none"
        stroke={TEAL}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      />
    </motion.svg>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Completed Card
 * ──────────────────────────────────────────────────────────────────── */

interface CompletedCardProps {
  initiative: Initiative;
  index: number;
  onViewArtifacts?: (initiativeId: string) => void;
}

function CompletedCard({ initiative, index, onViewArtifacts }: CompletedCardProps) {
  const shouldCelebrate = useMemo(() => {
    if (hasCelebrated(initiative.id)) return false;
    markCelebrated(initiative.id);
    return true;
  }, [initiative.id]);

  const artifactChips = useMemo(
    () => deriveArtifactTypesFromInitiative(initiative),
    [initiative],
  );

  const relativeTime = useMemo(() => {
    if (!initiative.updatedAt) return null;
    try {
      return formatDistanceToNow(new Date(initiative.updatedAt), { addSuffix: true });
    } catch {
      return null;
    }
  }, [initiative.updatedAt]);

  const handleViewArtifacts = useCallback(() => {
    onViewArtifacts?.(initiative.id);
  }, [onViewArtifacts, initiative.id]);

  // Task count display: use health as proxy (0-100 maps to completion)
  const taskLabel = initiative.health === 100
    ? 'All tasks done'
    : initiative.health > 0
      ? `${initiative.health}% complete`
      : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{
        delay: Math.min(index, 8) * 0.04,
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={`relative rounded-lg bg-[#08090D] p-3 transition-shadow duration-300 ${shouldCelebrate ? 'shadow-[0_0_12px_rgba(20,184,166,0.25)]' : ''}`}
      style={{ borderLeft: `4px solid ${TEAL}` }}
      onAnimationComplete={() => {
        // Celebration glow fades naturally via CSS transition
      }}
    >
      <div className="flex items-start gap-2.5">
        {/* Animated checkmark */}
        <div className="mt-0.5">
          <AnimatedCheckmark size={16} />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-white/90">
              {initiative.name}
            </p>
          </div>

          {/* Meta row */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {taskLabel && (
              <span className="text-[11px] font-mono tabular-nums text-[#14B8A6]">
                {taskLabel}
              </span>
            )}
            {relativeTime && (
              <span className="text-[10px] text-white/30">
                {relativeTime}
              </span>
            )}
          </div>

          {/* Artifact chips */}
          {artifactChips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {artifactChips.map((chip) => (
                <button
                  key={chip.type}
                  type="button"
                  onClick={handleViewArtifacts}
                  className="px-2 py-0.5 rounded-full bg-[#14B8A6]/10 text-[#14B8A6] text-[10px] cursor-pointer hover:bg-[#14B8A6]/20 transition-colors"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Review Artifacts link */}
        {onViewArtifacts && (
          <button
            type="button"
            onClick={handleViewArtifacts}
            className="flex-shrink-0 text-[10px] text-[#14B8A6]/70 hover:text-[#14B8A6] transition-colors whitespace-nowrap"
          >
            Review Artifacts
          </button>
        )}
      </div>
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Date Group Heading
 * ──────────────────────────────────────────────────────────────────── */

function DateGroupHeading({ label }: { label: DateGroup }) {
  return (
    <h4 className="text-[11px] uppercase tracking-wider text-white/40 font-medium mb-2 mt-4 first:mt-0">
      {label}
    </h4>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Main Component: CompletedSection
 * ──────────────────────────────────────────────────────────────────── */

export interface CompletedSectionProps {
  initiatives: Initiative[];
  onViewArtifacts?: (initiativeId: string) => void;
}

export function CompletedSection({
  initiatives,
  onViewArtifacts,
}: CompletedSectionProps) {
  // Filter to only completed (successful terminal) initiatives
  const completedInitiatives = useMemo(
    () =>
      initiatives.filter(
        (init) =>
          init.status === 'completed' ||
          (init.rawStatus != null && isCompletedStatus(init.rawStatus)),
      ),
    [initiatives],
  );

  // Group by date
  const groupedInitiatives = useMemo(() => {
    const groups = new Map<DateGroup, Initiative[]>();

    for (const init of completedInitiatives) {
      const group = getDateGroup(init.updatedAt);
      const existing = groups.get(group) ?? [];
      existing.push(init);
      groups.set(group, existing);
    }

    // Sort each group by updatedAt descending
    for (const [, items] of groups) {
      items.sort((a, b) => {
        const aTime = Date.parse(a.updatedAt ?? '') || 0;
        const bTime = Date.parse(b.updatedAt ?? '') || 0;
        return bTime - aTime;
      });
    }

    return groups;
  }, [completedInitiatives]);

  // Don't render if nothing completed
  if (completedInitiatives.length === 0) return null;

  // Running card index for stagger across all groups
  let cardIndex = 0;

  return (
    <CollapsibleSection
      title="Completed"
      defaultOpen={false}
      storageKey="completed"
      badge={completedInitiatives.length}
      accentColor={TEAL}
    >
      <div className="px-1 pb-2 pt-2">
        <AnimatePresence mode="popLayout">
          {DATE_GROUP_ORDER.map((groupLabel) => {
            const items = groupedInitiatives.get(groupLabel);
            if (!items || items.length === 0) return null;

            return (
              <div key={groupLabel}>
                <DateGroupHeading label={groupLabel} />
                <div className="space-y-2">
                  {items.map((initiative) => {
                    const idx = cardIndex;
                    cardIndex += 1;
                    return (
                      <CompletedCard
                        key={initiative.id}
                        initiative={initiative}
                        index={idx}
                        onViewArtifacts={onViewArtifacts}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </AnimatePresence>

        {/* Empty state — shouldn't happen since we bail early, but just in case */}
        {completedInitiatives.length === 0 && (
          <p className="py-6 text-center text-[11px] text-white/30">
            No completed initiatives yet.
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
