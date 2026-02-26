import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface ScopeDropdownProps {
  open: boolean;
  initiatives: { id: string; name: string }[];
  query: string;
  activeIndex: number;
  onSelect: (initiative: { id: string; name: string } | null) => void;
  onClose: () => void;
}

const DROPDOWN_SPRING = { type: 'spring' as const, stiffness: 500, damping: 30, mass: 0.5 };

export function ScopeDropdown({
  open,
  initiatives,
  query,
  activeIndex,
  onSelect,
}: ScopeDropdownProps) {
  const prefersReducedMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const filtered = query.length > 0
    ? initiatives.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
    : initiatives;

  if (!open) return null;

  const displayed = filtered.slice(0, 6);

  return (
    <AnimatePresence>
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 8, scale: 0.96 }}
        animate={prefersReducedMotion ? {} : { opacity: 1, y: 0, scale: 1 }}
        exit={prefersReducedMotion ? {} : { opacity: 0, y: 8, scale: 0.96 }}
        transition={prefersReducedMotion ? undefined : DROPDOWN_SPRING}
        className={cn(
          'absolute bottom-[calc(100%+6px)] left-0 z-30 w-[280px]',
          'rounded-2xl border border-white/[0.1] bg-[#0D1117]/98 p-1',
          'shadow-[0_16px_48px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur-2xl'
        )}
        role="listbox"
        aria-label="Initiative scope suggestions"
      >
        <div ref={listRef} className="space-y-px">
          {/* Unscoped option */}
          <button
            type="button"
            role="option"
            aria-selected={activeIndex === 0}
            data-active={activeIndex === 0}
            onClick={() => onSelect(null)}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
              'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-caption',
              'transition-colors duration-[60ms]',
              activeIndex === 0
                ? 'bg-white/[0.08] text-primary'
                : 'text-secondary hover:bg-white/[0.05] hover:text-primary'
            )}
          >
            Unscoped
          </button>
          {displayed.map((initiative, i) => {
            const isActive = i + 1 === activeIndex;
            return (
              <button
                key={initiative.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                onClick={() => onSelect(initiative)}
                onMouseDown={(e) => e.preventDefault()}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-caption',
                  'transition-colors duration-[60ms]',
                  isActive
                    ? 'bg-white/[0.08] text-primary'
                    : 'text-secondary hover:bg-white/[0.05] hover:text-primary'
                )}
              >
                <span className="truncate">{initiative.name}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
