import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { colors, listItemVariants } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import { statusColor } from '@/lib/entityStatusColors';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { ProviderLogo } from '@/components/shared/ProviderLogo';
import type { ProviderId } from '@/lib/providers';

interface AgentSessionCardProps {
  id: string;
  title: string;
  agentName: string;
  status: string;
  providerId: ProviderId;
  updatedAt: string | null;
  workstreamContext?: string | null;
  taskCount?: number;
  isSelected?: boolean;
  onClick: () => void;
  index?: number;
}

export function AgentSessionCard({
  title,
  agentName,
  status,
  providerId,
  updatedAt,
  workstreamContext,
  isSelected,
  onClick,
  index = 0,
}: AgentSessionCardProps) {
  const dotColor = statusColor(status);
  const isRunning = status === 'running' || status === 'queued';

  return (
    <motion.button
      type="button"
      onClick={onClick}
      className={cn(
        'surface-tier-2 w-full rounded-xl px-4 py-3 text-left hover-lift relative overflow-hidden',
        isSelected && 'ring-1 ring-lime/20'
      )}
      variants={listItemVariants}
      custom={index}
    >
      <div className="flex items-center gap-3">
        <AgentAvatar name={agentName} hint={agentName} size="xs" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-white truncate">{title}</p>
          <div className="mt-0.5 flex items-center gap-1.5 text-micro text-muted">
            {workstreamContext && (
              <>
                <span className="truncate">{workstreamContext}</span>
                <span className="opacity-40">·</span>
              </>
            )}
            {updatedAt && <span className="tabular-nums">{formatRelativeTime(updatedAt)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ProviderLogo provider={providerId} size="xs" />
          <span className="status-pill" data-tone={
            isRunning ? 'active' : status === 'blocked' ? 'blocked' : status === 'completed' ? 'done' : 'planned'
          }>
            {status}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-xl">
        <motion.div
          className="h-full rounded-full"
          initial={{ width: 0 }}
          animate={{
            width: isRunning ? '60%' : status === 'completed' ? '100%' : '0%',
          }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          style={{
            background: isRunning ? colors.lime : status === 'completed' ? colors.teal : 'transparent',
            opacity: 0.5,
          }}
        />
      </div>
    </motion.button>
  );
}
