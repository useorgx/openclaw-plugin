import { cn } from '@/lib/utils';

interface ScopeChipProps {
  initiativeName: string | null;
  onClick: () => void;
}

export function ScopeChip({ initiativeName, onClick }: ScopeChipProps) {
  const isScoped = Boolean(initiativeName);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-micro transition-colors duration-150',
        isScoped
          ? 'border-cyan/25 bg-cyan/[0.08] text-cyan-100'
          : 'border-white/[0.12] bg-white/[0.03] text-secondary hover:bg-white/[0.08] hover:text-primary'
      )}
    >
      <span className="max-w-[160px] truncate">{initiativeName ?? 'Unscoped'}</span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="flex-shrink-0 opacity-60"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
