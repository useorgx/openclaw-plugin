import { colors } from '@/lib/tokens';

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  pulse?: boolean;
  title?: string;
}

export function Badge({ children, color, pulse, title }: BadgeProps) {
  const c = color ?? colors.lime;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
      title={title}
      style={{
        backgroundColor: `${c}22`,
        border: `1px solid ${c}5a`,
        color: c,
      }}
    >
      <span className="relative flex h-1.5 w-1.5">
        {pulse && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ backgroundColor: c }}
          />
        )}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      </span>
      {children}
    </span>
  );
}
