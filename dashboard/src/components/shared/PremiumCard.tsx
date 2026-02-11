import { cn } from '@/lib/utils';

interface PremiumCardProps {
  children: React.ReactNode;
  className?: string;
}

export function PremiumCard({ children, className = '' }: PremiumCardProps) {
  return (
    <section
      className={cn(
        'surface-tier-1 relative overflow-hidden rounded-2xl',
        className
      )}
    >
      {children}
    </section>
  );
}
