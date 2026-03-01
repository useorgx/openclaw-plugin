import { cn } from '@/lib/utils';

type SkeletonVariant = 'card' | 'list-item' | 'metric-row' | 'timeline-item';

interface SkeletonCardProps {
  variant?: SkeletonVariant;
  className?: string;
}

export function SkeletonCard({ variant = 'card', className }: SkeletonCardProps) {
  if (variant === 'list-item') {
    return (
      <div className={cn('flex items-center gap-3 px-4 py-3', className)} aria-hidden="true">
        <div className="shimmer-skeleton h-8 w-8 rounded-full flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="shimmer-skeleton h-3 rounded-md" style={{ width: '70%' }} />
          <div className="shimmer-skeleton h-2.5 rounded-md" style={{ width: '40%' }} />
        </div>
      </div>
    );
  }

  if (variant === 'metric-row') {
    return (
      <div className={cn('flex items-center gap-12', className)} aria-hidden="true">
        {[40, 50, 45, 35].map((w, i) => (
          <div key={i} className="space-y-2">
            <div className="shimmer-skeleton h-2 rounded-md" style={{ width: `${w}%`, minWidth: 32 }} />
            <div className="shimmer-skeleton h-5 w-10 rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'timeline-item') {
    return (
      <div className={cn('flex gap-3 py-2', className)} aria-hidden="true">
        <div className="shimmer-skeleton h-2 w-2 rounded-full flex-shrink-0 mt-1.5" />
        <div className="flex-1 space-y-2">
          <div className="shimmer-skeleton h-3 rounded-md" style={{ width: '60%' }} />
          <div className="shimmer-skeleton h-2.5 rounded-md" style={{ width: '90%' }} />
        </div>
      </div>
    );
  }

  // Default: card variant
  return (
    <div
      className={cn('surface-tier-1 rounded-2xl p-5 nextup-skeleton-card', className)}
      aria-hidden="true"
    >
      <div className="space-y-4">
        <div className="shimmer-skeleton h-3.5 rounded-md" style={{ width: '40%' }} />
        <div className="shimmer-skeleton h-3 rounded-md" style={{ width: '70%' }} />
        <div className="shimmer-skeleton h-3 rounded-md" style={{ width: '90%' }} />
        <div className="shimmer-skeleton h-3 rounded-md" style={{ width: '60%' }} />
      </div>
    </div>
  );
}
