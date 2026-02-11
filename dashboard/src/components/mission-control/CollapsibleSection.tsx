import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  storageKey?: string;
  sticky?: boolean;
  stickyOffsetClass?: string;
  stickyTop?: string;
  children: React.ReactNode;
}

function readStorage(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(`orgx.section.${key}`);
    if (value === '0') return false;
    if (value === '1') return true;
  } catch {
    // ignore
  }
  return fallback;
}

function writeStorage(key: string, open: boolean): void {
  try {
    localStorage.setItem(`orgx.section.${key}`, open ? '1' : '0');
  } catch {
    // ignore
  }
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  storageKey,
  sticky = false,
  stickyOffsetClass = 'top-0',
  stickyTop,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(() =>
    storageKey ? readStorage(storageKey, defaultOpen) : defaultOpen
  );
  const stickyHeaderRef = useRef<HTMLButtonElement | null>(null);
  const [stickyHeaderOffset, setStickyHeaderOffset] = useState(40);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    if (storageKey) writeStorage(storageKey, next);
  };

  useEffect(() => {
    if (!sticky) return;
    const element = stickyHeaderRef.current;
    if (!element) return;

    const update = () => {
      const next = Math.max(34, element.offsetHeight);
      setStickyHeaderOffset((previous) => (previous === next ? previous : next));
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    return () => observer.disconnect();
  }, [sticky, stickyTop, title]);

  return (
    <div
      style={
        sticky
          ? ({ ['--mc-collapsible-header-offset' as string]: `${stickyHeaderOffset}px` } as Record<string, string>)
          : undefined
      }
    >
      <button
        ref={sticky ? stickyHeaderRef : undefined}
        type="button"
        data-mc-section-header={title}
        onClick={toggle}
        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors ${
          sticky
            ? `sticky ${stickyOffsetClass} z-20 border-white/[0.08] bg-[#090B11]/92 shadow-[0_8px_18px_rgba(0,0,0,0.24)] backdrop-blur-xl`
            : 'border-transparent hover:border-white/[0.06] hover:bg-white/[0.03]'
        }`}
        style={
          sticky && stickyTop
            ? { top: stickyTop }
            : undefined
        }
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`text-white/30 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="text-[11px] font-semibold tracking-[0.02em] text-white/68">
          {title}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
