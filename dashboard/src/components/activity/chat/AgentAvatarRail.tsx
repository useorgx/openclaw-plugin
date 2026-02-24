import { useReducedMotion } from 'framer-motion';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { cn } from '@/lib/utils';
import type { AgentOption } from './chatTypes';

interface AgentAvatarRailProps {
  agents: AgentOption[];
  selectedAssigneeId: string;
  selectedWatcherIds: string[];
  onSelectAssignee: (id: string) => void;
  onToggleWatcher: (id: string) => void;
  onOpenFullPicker: () => void;
}

export function AgentAvatarRail({
  agents,
  selectedAssigneeId,
  selectedWatcherIds,
  onSelectAssignee,
  onToggleWatcher,
  onOpenFullPicker,
}: AgentAvatarRailProps) {
  const prefersReducedMotion = useReducedMotion();
  const watcherSet = new Set(selectedWatcherIds);

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
      {agents.map((agent) => {
        const isAssignee = selectedAssigneeId === agent.id;
        const isWatcher = watcherSet.has(agent.id);
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelectAssignee(agent.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!isAssignee) onToggleWatcher(agent.id);
            }}
            title={`${agent.name}${isAssignee ? ' (assignee)' : isWatcher ? ' (watcher)' : ''}`}
            className={cn(
              'flex-shrink-0 rounded-full p-0.5 transition-all',
              prefersReducedMotion ? 'duration-0' : 'duration-[120ms]',
              isAssignee
                ? 'ring-2 ring-lime/60 ring-offset-1 ring-offset-[#0A0E16]'
                : isWatcher
                  ? 'ring-1 ring-teal/40 ring-offset-1 ring-offset-[#0A0E16]'
                  : 'ring-1 ring-white/[0.12]'
            )}
            aria-pressed={isAssignee}
            aria-label={`Select ${agent.name} as assignee`}
          >
            <AgentAvatar name={agent.name} hint={agent.name} size="xs" />
          </button>
        );
      })}

      <button
        type="button"
        onClick={onOpenFullPicker}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-micro text-secondary hover:bg-white/[0.08] hover:text-primary"
        aria-label="Open full agent picker"
      >
        +
      </button>

      {/* Fade gradient for overflow */}
      <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-[#0A0E16]/80 to-transparent" aria-hidden />
    </div>
  );
}
