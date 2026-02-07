import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';

interface PremiumCardProps {
  children: React.ReactNode;
  className?: string;
}

export function PremiumCard({ children, className = '' }: PremiumCardProps) {
  return (
    <section
      className={cn(
        'group relative overflow-hidden rounded-2xl',
        'glass-panel soft-shadow hover-lift',
        className
      )}
      style={{
        backgroundColor: colors.cardBg,
        borderColor: colors.cardBorder,
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" style={{ background: 'radial-gradient(circle at 18% 0%, rgba(191,255,0,0.06), transparent 46%)' }} />
      {children}
    </section>
  );
}
