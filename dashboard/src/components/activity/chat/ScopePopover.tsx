import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';

interface ScopePopoverProps {
  open: boolean;
  initiatives: { id: string; name: string }[];
  query: string;
  selectedInitiativeId: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function ScopePopover({
  open,
  initiatives,
  query,
  selectedInitiativeId,
  onQueryChange,
  onSelect,
  onClose,
  anchorRef,
}: ScopePopoverProps) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.95, y: 8 }}
          animate={prefersReducedMotion ? {} : { opacity: 1, scale: 1, y: 0 }}
          exit={prefersReducedMotion ? {} : { opacity: 0, scale: 0.95, y: 8 }}
          transition={
            prefersReducedMotion
              ? undefined
              : motionTokens.easingBounce
          }
          className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-[340px] rounded-xl border border-white/[0.14] bg-[#0A0E16]/98 p-2.5 shadow-[0_20px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          {/* Caret pointing down */}
          <div
            className="absolute -bottom-[6px] right-4 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-white/[0.14]"
            aria-hidden
          />

          <div className="mb-2 flex items-center justify-between">
            <p className="text-micro uppercase tracking-[0.08em] text-muted">Select scope</p>
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 text-micro text-secondary hover:bg-white/[0.08] hover:text-primary"
            >
              Close
            </button>
          </div>

          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search initiatives..."
            className="mb-2 h-9 w-full rounded-lg border border-white/[0.12] bg-black/35 px-2.5 text-caption text-primary outline-none focus:border-lime/35"
            autoFocus
          />

          <div className="max-h-[240px] space-y-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onSelect('');
                onClose();
              }}
              className={cn(
                'w-full rounded-lg border px-2 py-1.5 text-left text-caption',
                selectedInitiativeId === ''
                  ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                  : 'border-white/[0.1] bg-white/[0.02] text-secondary hover:bg-white/[0.08] hover:text-primary'
              )}
            >
              Unscoped
            </button>
            {initiatives.map((initiative) => {
              const isSelected = selectedInitiativeId === initiative.id;
              return (
                <button
                  key={initiative.id}
                  type="button"
                  onClick={() => {
                    onSelect(initiative.id);
                    onClose();
                  }}
                  className={cn(
                    'w-full rounded-lg border px-2 py-1.5 text-left text-caption',
                    isSelected
                      ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                      : 'border-white/[0.1] bg-white/[0.02] text-secondary hover:bg-white/[0.08] hover:text-primary'
                  )}
                >
                  {initiative.name}
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
