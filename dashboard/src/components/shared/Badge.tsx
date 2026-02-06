import { colors } from '@/lib/tokens';

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
}

export function Badge({ children, color }: BadgeProps) {
  const c = color ?? colors.lime;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
      style={{
        backgroundColor: `${c}22`,
        border: `1px solid ${c}5a`,
        color: c,
        boxShadow: `0 8px 20px ${c}24`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      {children}
    </span>
  );
}
