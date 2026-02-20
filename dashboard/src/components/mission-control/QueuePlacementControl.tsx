import { useEffect, useRef, useState } from 'react';
import type { SliceScope } from '@/types';

type QueuePlacement = 'top' | 'bottom';

interface QueuePlacementControlProps {
  label?: string;
  defaultPlacement?: QueuePlacement;
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
  menuDirection?: 'up' | 'down';
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  menuClassName?: string;
  title?: string;
  stopPropagation?: boolean;
  onSelectPlacement: (placement: QueuePlacement, scope?: SliceScope) => void | Promise<void>;
}

const placementCopy: Record<QueuePlacement, string> = {
  top: 'Play next',
  bottom: 'Add to queue',
};

const scopeOptions: Array<{ scope: SliceScope; label: string; description: string }> = [
  { scope: 'task', label: 'Play next', description: 'task scope' },
  { scope: 'milestone', label: 'Play milestone', description: 'milestone scope' },
  { scope: 'workstream', label: 'Play workstream', description: 'workstream scope' },
];

function ScopeIcon({ scope, size = 12 }: { scope: SliceScope; size?: number }) {
  const s = size;
  const r = Math.round(s * 0.14);
  const gap = Math.round(s * 0.06);
  if (scope === 'task') {
    // Single dot
    return (
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="currentColor" aria-hidden>
        <circle cx={s / 2} cy={s / 2} r={r + 1} />
      </svg>
    );
  }
  if (scope === 'milestone') {
    // Vertical stack of 3 dots
    const cx = s / 2;
    const spacing = (s - r * 6) / 2;
    return (
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="currentColor" aria-hidden>
        <circle cx={cx} cy={r + gap} r={r} />
        <circle cx={cx} cy={s / 2} r={r} />
        <circle cx={cx} cy={s - r - gap} r={r} />
      </svg>
    );
  }
  // Workstream: 2x2 grid
  const inset = r + gap + 1;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="currentColor" aria-hidden>
      <circle cx={inset} cy={inset} r={r} />
      <circle cx={s - inset} cy={inset} r={r} />
      <circle cx={inset} cy={s - inset} r={r} />
      <circle cx={s - inset} cy={s - inset} r={r} />
    </svg>
  );
}

export function QueuePlacementControl({
  label = 'Queue',
  defaultPlacement = 'bottom',
  size = 'sm',
  align = 'right',
  menuDirection = 'up',
  disabled = false,
  busy = false,
  className = '',
  menuClassName = '',
  title,
  stopPropagation = false,
  onSelectPlacement,
}: QueuePlacementControlProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useRef(`queue-placement-${Math.random().toString(36).slice(2, 10)}`);
  const isDisabled = disabled || busy;
  const sizeClass = size === 'md' ? 'h-8 text-caption' : 'h-7 text-micro';
  const mainPaddingClass = size === 'md' ? 'px-3' : 'px-2.5';
  const menuButtonSizeClass = size === 'md' ? 'h-8 w-8' : 'h-7 w-7';
  const menuAlignClass = align === 'left' ? 'left-0' : 'right-0';
  const menuVerticalClass = menuDirection === 'up' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]';

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const runAction = (event: React.MouseEvent, placement: QueuePlacement, scope?: SliceScope) => {
    if (stopPropagation) event.stopPropagation();
    setMenuOpen(false);
    void onSelectPlacement(placement, scope);
  };

  return (
    <div ref={rootRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        title={title ?? `Queue ${defaultPlacement === 'top' ? 'to top' : 'to end'}`}
        onClick={(event) => runAction(event, defaultPlacement)}
        disabled={isDisabled}
        className={`control-pill ${sizeClass} ${mainPaddingClass} rounded-r-none border-r-0 font-semibold text-primary disabled:opacity-45`}
      >
        <svg
          width={size === 'md' ? 13 : 12}
          height={size === 'md' ? 13 : 12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-90"
          aria-hidden
        >
          <path d="M4 6h16" />
          <path d="M4 12h11" />
          <path d="M4 18h9" />
          <path d="m17 15 3 3 3-3" />
          <path d="M20 8v10" />
        </svg>
        <span>{busy ? 'Queueing...' : label}</span>
      </button>
      <button
        type="button"
        aria-label="Choose queue placement"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId.current}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          if (isDisabled) return;
          setMenuOpen((previous) => !previous);
        }}
        disabled={isDisabled}
        className={`control-pill ${menuButtonSizeClass} rounded-l-none px-0 text-secondary disabled:opacity-45`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menuOpen && (
        <div
          id={menuId.current}
          role="menu"
          className={`absolute ${menuAlignClass} ${menuVerticalClass} z-[260] min-w-[196px] rounded-lg border border-strong bg-[#0B0F16]/95 p-1 shadow-[0_16px_32px_rgba(0,0,0,0.38)] backdrop-blur ${menuClassName}`}
        >
          {scopeOptions.map((opt) => (
            <button
              key={opt.scope}
              type="button"
              role="menuitem"
              onClick={(event) => runAction(event, 'top', opt.scope)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.07]"
            >
              <ScopeIcon scope={opt.scope} size={12} />
              <span className="text-caption font-medium text-primary">{opt.label}</span>
              <span className="ml-auto text-micro text-tertiary">{opt.description}</span>
            </button>
          ))}
          <div className="my-1 border-t border-strong" />
          <button
            type="button"
            role="menuitem"
            onClick={(event) => runAction(event, 'bottom')}
            className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.07]"
          >
            <span className="text-caption font-medium text-primary">{placementCopy.bottom}</span>
          </button>
        </div>
      )}
    </div>
  );
}
