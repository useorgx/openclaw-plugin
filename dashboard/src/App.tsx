import { useState } from 'react';
import { useLiveData } from '@/hooks/useLiveData';
import { colors } from '@/lib/tokens';
import { Badge } from '@/components/shared/Badge';
import { AgentPanel } from '@/components/agents/AgentPanel';
import { ActivityStream } from '@/components/activity/ActivityStream';
import { InitiativePanel } from '@/components/initiatives/InitiativePanel';
import { DecisionBanner } from '@/components/decisions/DecisionBanner';
import { DecisionModal } from '@/components/decisions/DecisionModal';
import type { Decision, Artifact, Initiative } from '@/types';

const CONNECTION_LABEL: Record<string, string> = {
  connected: 'LIVE',
  reconnecting: 'RECONNECTING',
  disconnected: 'OFFLINE',
};

const CONNECTION_COLOR: Record<string, string> = {
  connected: colors.lime,
  reconnecting: colors.amber,
  disconnected: colors.red,
};

export function App() {
  const { data, isLoading, error } = useLiveData({ useMock: false });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeDecision, setActiveDecision] = useState<Decision | null>(null);

  if (isLoading) {
    return (
      <div
        className="h-screen flex items-center justify-center"
        style={{ backgroundColor: colors.background }}
      >
        <div className="text-white/40 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: colors.background }}
    >
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[15px] font-semibold text-white tracking-tight">
            OrgX
          </h1>
          <Badge color={CONNECTION_COLOR[data.connection]}>
            {CONNECTION_LABEL[data.connection] ?? 'UNKNOWN'}
          </Badge>
        </div>
        {data.lastActivity && (
          <span className="text-[11px] text-white/30">
            Last activity: {data.lastActivity}
          </span>
        )}
      </header>

      {/* Decision banner */}
      <DecisionBanner
        decisions={data.pendingDecisions}
        onDecide={setActiveDecision}
      />

      {/* Main grid */}
      <main className="flex-1 min-h-0 grid grid-cols-[280px_1fr_320px] gap-3 p-4 pt-3">
        {/* Left: Agents */}
        <AgentPanel
          agents={data.agents}
          selectedAgentId={selectedAgentId}
          onAgentSelect={setSelectedAgentId}
        />

        {/* Center: Activity */}
        <ActivityStream
          activities={data.activities}
          selectedAgentId={selectedAgentId}
          onClearAgentFilter={() => setSelectedAgentId(null)}
          onArtifactClick={() => {}}
        />

        {/* Right: Initiatives */}
        <InitiativePanel
          initiatives={data.initiatives}
          onInitiativeClick={() => {}}
        />
      </main>

      {/* Decision modal */}
      <DecisionModal
        decision={activeDecision}
        onClose={() => setActiveDecision(null)}
        onAction={() => setActiveDecision(null)}
      />
    </div>
  );
}
