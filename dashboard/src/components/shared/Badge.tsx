import { colors } from '@/lib/tokens';

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
}

export function Badge({ children, color }: BadgeProps) {
  const c = color ?? colors.lime;
  return (
    <span
      className="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-semibold tracking-[0.12em] uppercase"
      style={{
        backgroundColor: `${c}1a`,
        border: `1px solid ${c}4d`,
        color: c,
      }}
    >
      {children}
    </span>
  );
}
