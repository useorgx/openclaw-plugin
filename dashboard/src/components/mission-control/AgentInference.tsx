import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { InferredAgent } from '@/hooks/useAgentEntityMap';

interface InferredAgentAvatarsProps {
  agents: InferredAgent[];
  max?: number;
}

export function InferredAgentAvatars({ agents, max = 4 }: InferredAgentAvatarsProps) {
  if (!agents.length) return null;

  const shown = agents.slice(0, max);
  const overflow = agents.length - max;

  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((agent) => (
        <div
          key={agent.id}
          className="relative"
          title={`${agent.name} (${agent.confidence} confidence)`}
          style={{
            borderRadius: '9999px',
            border:
              agent.confidence === 'high'
                ? '1.5px solid rgba(255,255,255,0.25)'
                : agent.confidence === 'medium'
                  ? '1.5px dashed rgba(255,255,255,0.15)'
                  : '1.5px dotted rgba(255,255,255,0.10)',
          }}
        >
          <AgentAvatar name={agent.name} size="xs" />
        </div>
      ))}
      {overflow > 0 && (
        <span className="ml-1 text-[9px] text-white/40">+{overflow}</span>
      )}
    </div>
  );
}
