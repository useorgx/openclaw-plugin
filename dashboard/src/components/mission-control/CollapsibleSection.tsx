import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  storageKey?: string;
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
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(() =>
    storageKey ? readStorage(storageKey, defaultOpen) : defaultOpen
  );

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    if (storageKey) writeStorage(storageKey, next);
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`text-white/25 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40">
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
