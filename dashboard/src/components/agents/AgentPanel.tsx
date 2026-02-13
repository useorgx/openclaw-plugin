import { useState } from 'react';
import type { Agent } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { StatusIndicator } from './StatusIndicator';
import { AgentRow } from './AgentRow';

interface AgentPanelProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onAgentSelect: (agentId: string | null) => void;
}

export function AgentPanel({
  agents,
  selectedAgentId,
  onAgentSelect,
}: AgentPanelProps) {
  const grouped = {
    working: agents.filter((a) => ['working', 'planning'].includes(a.status)),
    waiting: agents.filter((a) => ['waiting', 'blocked'].includes(a.status)),
    idle: agents.filter((a) => ['idle', 'done'].includes(a.status)),
  };

  if (agents.length === 0) {
    return (
      <PremiumCard className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-hairline">
          <span className="text-body font-medium text-white">Agents</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <svg
              className="mx-auto mb-2 text-faint"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
            </svg>
            <p className="text-caption text-muted">No agents assigned</p>
          </div>
        </div>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className="flex-1 flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-hairline">
        <span className="text-body font-medium text-white">Agents</span>
        <div className="flex items-center gap-1.5">
          <StatusIndicator status="working" size="sm" />
          <span className="text-micro text-muted">
            {grouped.working.length + grouped.waiting.length}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {grouped.working.length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-1 text-micro font-semibold uppercase tracking-[0.12em] text-muted">
              Working
            </div>
            {grouped.working.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                onSelect={() =>
                  onAgentSelect(selectedAgentId === agent.id ? null : agent.id)
                }
              />
            ))}
          </div>
        )}

        {grouped.waiting.length > 0 && (
          <div className="mb-2">
            <div className="px-2 py-1 text-micro font-semibold uppercase tracking-[0.12em] text-muted">
              Waiting
            </div>
            {grouped.waiting.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                onSelect={() =>
                  onAgentSelect(selectedAgentId === agent.id ? null : agent.id)
                }
              />
            ))}
          </div>
        )}

        {grouped.idle.length > 0 && (
          <div>
            <div className="px-2 py-1 text-micro font-semibold uppercase tracking-[0.12em] text-faint">
              Idle
            </div>
            {grouped.idle.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={selectedAgentId === agent.id}
                onSelect={() =>
                  onAgentSelect(selectedAgentId === agent.id ? null : agent.id)
                }
              />
            ))}
          </div>
        )}
      </div>
    </PremiumCard>
  );
}
