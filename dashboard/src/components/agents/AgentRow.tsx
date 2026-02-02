import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { Agent } from '@/types';
import { AgentAvatar } from './AgentAvatar';
import { StatusIndicator } from './StatusIndicator';

interface AgentRowProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}

export function AgentRow({ agent, selected, onSelect }: AgentRowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 p-2 rounded-lg transition-all cursor-pointer',
        selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.02]'
      )}
      onClick={onSelect}
    >
      <div className="relative flex-shrink-0">
        <AgentAvatar name={agent.name} size="xs" />
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIndicator status={agent.status} size="sm" />
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-white/90">
            {agent.name}
          </span>
          <span className="text-[9px] font-mono text-white/30">
            {agent.role}
          </span>
        </div>
        {agent.task ? (
          <p className="text-[10px] text-white/40 truncate">{agent.task}</p>
        ) : (
          <p className="text-[10px] text-white/25 italic">Idle</p>
        )}
        {agent.status === 'working' && agent.progress !== null && (
          <div className="mt-1.5 h-0.5 rounded-full overflow-hidden bg-white/[0.06]">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${agent.progress}%`,
                background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
