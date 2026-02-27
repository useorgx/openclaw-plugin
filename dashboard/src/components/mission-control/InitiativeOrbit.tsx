import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import type { Initiative } from '@/types';
import { InitiativeSection } from './InitiativeSection';

/** Number of items to render initially and per scroll-triggered batch. */
const VIRTUALIZE_THRESHOLD = 20;

interface InitiativeOrbitProps {
  initiatives: Initiative[];
  selectedInitiativeIds?: Set<string>;
  onToggleInitiativeSelection?: (initiativeId: string, selected: boolean, shiftKey: boolean) => void;
  isSquished?: boolean;
  runtimeActivityByInitiativeId?: ReadonlyMap<
    string,
    { activeCount: number; totalCount: number; lastHeartbeatAt: string | null }
  >;
  queuedInitiativeIds?: ReadonlySet<string>;
  /**
   * Optimistic pin callback. Called with the initiative id when the user pins an item.
   * Should return `true` on success. If it returns `false` or throws, the reorder is reverted.
   */
  onPin?: (initiativeId: string) => Promise<boolean | void>;
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.045, delayChildren: 0.02 },
  },
};

const item = {
  hidden: { opacity: 0, y: 10, scale: 0.995 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 320, damping: 28, mass: 0.7 },
  },
};

const layoutTransition = { type: 'spring' as const, stiffness: 280, damping: 32, mass: 0.75 };

export function InitiativeOrbit({
  initiatives,
  selectedInitiativeIds,
  onToggleInitiativeSelection,
  isSquished = false,
  runtimeActivityByInitiativeId,
  queuedInitiativeIds,
  onPin,
}: InitiativeOrbitProps) {
  // ---------------------------------------------------------------------------
  // Optimistic pin reorder
  // ---------------------------------------------------------------------------
  const [pinnedOrder, setPinnedOrder] = useState<Initiative[] | null>(null);
  const displayInitiatives = pinnedOrder ?? initiatives;

  const handlePin = useCallback(
    async (initiativeId: string) => {
      if (!onPin) return;
      const source = pinnedOrder ?? initiatives;
      const idx = source.findIndex((i) => i.id === initiativeId);
      if (idx <= 0) return; // already first or not found

      // Optimistically move the item to position 0
      const reordered = [...source];
      const [pinned] = reordered.splice(idx, 1);
      reordered.unshift(pinned);
      setPinnedOrder(reordered);

      try {
        const result = await onPin(initiativeId);
        if (result === false) {
          // Revert on explicit false
          setPinnedOrder(null);
        } else {
          // Success — keep the optimistic order until parent provides new data
          // (the parent's initiatives prop will eventually reflect the server state)
        }
      } catch {
        // Revert on error
        setPinnedOrder(null);
      }
    },
    [onPin, initiatives, pinnedOrder]
  );

  // When the parent updates the initiatives list (e.g. after server confirms the pin),
  // clear the optimistic override so we reflect the authoritative order.
  const prevInitiativesRef = useRef(initiatives);
  useEffect(() => {
    if (prevInitiativesRef.current !== initiatives) {
      prevInitiativesRef.current = initiatives;
      setPinnedOrder(null);
    }
  }, [initiatives]);

  // ---------------------------------------------------------------------------
  // Virtualization via IntersectionObserver
  // ---------------------------------------------------------------------------
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(VIRTUALIZE_THRESHOLD);

  // Reset visible count when the list changes substantially
  useEffect(() => {
    setVisibleCount(VIRTUALIZE_THRESHOLD);
  }, [displayInitiatives.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= displayInitiatives.length) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((c) => Math.min(c + VIRTUALIZE_THRESHOLD, displayInitiatives.length));
        }
      },
      { rootMargin: '200px' } // Trigger ~200px before reaching bottom (≈80% scroll depth)
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, displayInitiatives.length]);

  const visibleInitiatives = displayInitiatives.slice(0, visibleCount);
  const hasMore = visibleCount < displayInitiatives.length;
  const remainingCount = displayInitiatives.length - visibleCount;

  return (
    <LayoutGroup>
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="space-y-2"
      >
        <AnimatePresence mode="popLayout">
          {visibleInitiatives.map((initiative) => (
            <motion.div
              key={initiative.id}
              variants={item}
              layout
              transition={layoutTransition}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
            >
              <InitiativeSection
                initiative={initiative}
                selected={selectedInitiativeIds?.has(initiative.id) ?? false}
                onSelectionChange={onToggleInitiativeSelection}
                isSquished={isSquished}
                runtimeActivity={runtimeActivityByInitiativeId?.get(initiative.id) ?? null}
                isQueued={queuedInitiativeIds?.has(initiative.id) ?? false}
              />
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Skeleton placeholders + intersection sentinel */}
        {hasMore && (
          <div ref={sentinelRef} className="space-y-2">
            {[...Array(Math.min(3, remainingCount))].map((_, i) => (
              <div
                key={`skel-${i}`}
                className="h-[72px] rounded-lg bg-white/[0.03] animate-pulse"
              />
            ))}
          </div>
        )}
      </motion.div>
    </LayoutGroup>
  );
}
