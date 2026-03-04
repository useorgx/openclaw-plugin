import { InferredAgentAvatars } from './AgentInference';
import type { InferredAgent } from '@/hooks/useAgentEntityMap';

interface AgentPresenceBarProps {
  agents: InferredAgent[];
  activeCount: number;
  totalCount: number;
  isSquished?: boolean;
}

export function AgentPresenceBar({
  agents,
  activeCount,
  totalCount,
  isSquished = false,
}: AgentPresenceBarProps) {
  const hasKnownCapacity = totalCount > 0;
  const hasActiveAgents = activeCount > 0;
  const hasAgents = agents.length > 0;
  const compact = isSquished;
  const visibleNames = agents
    .slice(0, compact ? 1 : 2)
    .map((agent) => agent.name)
    .join(', ');
  const hiddenAgentCount = Math.max(0, agents.length - (compact ? 1 : 2));
  const namesLabel =
    visibleNames.length > 0
      ? hiddenAgentCount > 0
        ? `${visibleNames} +${hiddenAgentCount}`
        : visibleNames
      : null;

  if (!hasActiveAgents && !hasKnownCapacity && !hasAgents) {
    return <span className="w-full text-right text-micro text-white/28">—</span>;
  }

  if (hasActiveAgents) {
    return (
      <div className="flex w-full min-w-0 items-center justify-end gap-2" aria-label="Agent presence">
        <span className="inline-flex items-center gap-1 rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/14 px-2 py-0.5 text-micro font-semibold text-[#D8FFA1]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#BFFF00] status-breathe" />
          {hasKnownCapacity ? `${activeCount}/${totalCount} live` : `${activeCount} live`}
        </span>
        {namesLabel && (
          <span className="hidden max-w-[132px] truncate text-micro text-[#D8FFA1]/88 lg:inline">
            {namesLabel}
          </span>
        )}
        {hasAgents && <InferredAgentAvatars agents={agents} max={compact ? 2 : 3} />}
      </div>
    );
  }

  if (hasAgents) {
    return (
      <div className="flex w-full min-w-0 items-center justify-end gap-2">
        <span className="text-micro uppercase tracking-[0.08em] text-muted">
          idle
        </span>
        <InferredAgentAvatars agents={agents} max={compact ? 2 : 3} />
      </div>
    );
  }

  return (
    <span className="w-full text-right text-micro text-muted">
      {totalCount} idle
    </span>
  );
}
