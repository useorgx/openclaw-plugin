import { cn } from '@/lib/utils';

interface PremiumCardProps {
  children: React.ReactNode;
  className?: string;
  surface?: boolean;
}

export function PremiumCard({ children, className = '', surface = true }: PremiumCardProps) {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl',
        surface ? 'surface-tier-1' : '',
        className
      )}
    >
      {children}
    </section>
  );
}
