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
        'relative overflow-hidden rounded-2xl',
        'soft-shadow border border-[--orgx-border]',
        className
      )}
      style={{
        backgroundColor: colors.cardBg,
        borderColor: colors.cardBorder,
      }}
    >
      {children}
    </section>
  );
}
