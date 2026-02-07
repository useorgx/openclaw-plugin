import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={cn('shimmer-skeleton', className)} aria-hidden="true" />;
}
