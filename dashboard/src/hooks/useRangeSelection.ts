import { useRef, useCallback } from 'react';

type SetSelectedFn = (updater: (previous: Set<string>) => Set<string>) => void;

/**
 * Shared hook for shift+click range selection across ordered lists.
 *
 * Tracks the last-clicked ID and, on shift+click, selects all IDs between
 * the last-clicked and the current click target (inclusive).
 */
export function useRangeSelection(orderedIds: string[]) {
  const lastClickedId = useRef<string | null>(null);

  const handleSelect = useCallback(
    (
      id: string,
      checked: boolean,
      shiftKey: boolean,
      setSelected: SetSelectedFn,
    ) => {
      if (shiftKey && lastClickedId.current !== null) {
        const lastIndex = orderedIds.indexOf(lastClickedId.current);
        const currentIndex = orderedIds.indexOf(id);

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = orderedIds.slice(start, end + 1);

          setSelected((previous) => {
            const next = new Set(previous);
            for (const rangeId of rangeIds) {
              if (checked) {
                next.add(rangeId);
              } else {
                next.delete(rangeId);
              }
            }
            return next;
          });
          // Don't update lastClickedId on shift+click
          return;
        }
      }

      // Single toggle (no shift or fallback)
      setSelected((previous) => {
        const next = new Set(previous);
        if (checked) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
      lastClickedId.current = id;
    },
    [orderedIds],
  );

  return { lastClickedId, handleSelect };
}
