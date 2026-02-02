import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';

interface PremiumCardProps {
  children: React.ReactNode;
  className?: string;
}

export function PremiumCard({ children, className = '' }: PremiumCardProps) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl',
        'shadow-[0_4px_24px_rgba(0,0,0,0.3)]',
        className
      )}
      style={{
        backgroundColor: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
      {children}
    </div>
  );
}
