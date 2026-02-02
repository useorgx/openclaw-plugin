import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { AgentStatus } from '@/types';

interface StatusIndicatorProps {
  status: AgentStatus;
  size?: 'sm' | 'md' | 'lg';
}

const statusConfig: Record<AgentStatus, { color: string; pulse: boolean }> = {
  working: { color: colors.lime, pulse: true },
  planning: { color: colors.teal, pulse: true },
  waiting: { color: colors.amber, pulse: false },
  blocked: { color: colors.red, pulse: false },
  idle: { color: 'rgba(255,255,255,0.2)', pulse: false },
  done: { color: colors.teal, pulse: false },
};

const sizeMap = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
  lg: 'w-2.5 h-2.5',
};

export function StatusIndicator({ status, size = 'sm' }: StatusIndicatorProps) {
  const config = statusConfig[status];

  return (
    <div className="relative flex items-center justify-center">
      <span
        className={cn('rounded-full transition-all duration-500', sizeMap[size])}
        style={{ backgroundColor: config.color }}
      />
      {config.pulse && (
        <span
          className="absolute inset-0 rounded-full animate-ping opacity-40"
          style={{ backgroundColor: config.color }}
        />
      )}
    </div>
  );
}
