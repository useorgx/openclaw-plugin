import type { Initiative } from '@/types';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PhaseProgress } from './PhaseProgress';

interface InitiativeCardProps {
  initiative: Initiative;
  onClick: () => void;
}

function AvatarStack({ names }: { names: string[] }) {
  return (
    <div className="flex -space-x-1.5">
      {names.slice(0, 3).map((name, index) => (
        <div key={`${name}-${index}`} className="relative" style={{ zIndex: names.length - index }}>
          <AgentAvatar name={name} size="xs" />
        </div>
      ))}
    </div>
  );
}

function statusLabel(status: Initiative['status']): { text: string; className: string } {
  if (status === 'blocked') {
    return {
      text: 'Watch',
      className: 'border-amber-300/45 bg-amber-300/10 text-amber-200',
    };
  }
  if (status === 'completed') {
    return {
      text: 'Done',
      className: 'border-lime/45 bg-lime/15 text-lime',
    };
  }
  if (status === 'paused') {
    return {
      text: 'Paused',
      className: 'border-white/20 bg-white/[0.04] text-white/60',
    };
  }
  return {
    text: 'In Motion',
    className: 'border-teal/45 bg-teal/10 text-teal',
  };
}

export function InitiativeCard({ initiative, onClick }: InitiativeCardProps) {
  const phases = initiative.phases ?? [];
  const currentPhase = initiative.currentPhase ?? 0;
  const avatars = initiative.avatars ?? [];
  const badge = statusLabel(initiative.status);
  const workstreamCount = initiative.workstreams?.length ?? 0;

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl border border-white/[0.08] bg-[linear-gradient(150deg,rgba(20,184,166,0.15),rgba(2,4,10,0.7)_42%,rgba(2,4,10,0.95))] p-3 text-left transition-all duration-200 hover:border-white/[0.16] hover:bg-[linear-gradient(150deg,rgba(20,184,166,0.22),rgba(2,4,10,0.72)_42%,rgba(2,4,10,0.95))]"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {avatars.length > 0 && <AvatarStack names={avatars} />}
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] ${badge.className}`}
              >
                {badge.text}
              </span>
              <span className="rounded-full border border-white/[0.16] bg-white/[0.03] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-white/60">
                {initiative.category ?? 'Program'}
              </span>
            </div>
            <h4 className="mt-1 text-[13px] font-semibold text-white">{initiative.name}</h4>
          </div>
        </div>
        <span className="text-[10px] text-white/45">{initiative.health}%</span>
      </div>

      {initiative.description && (
        <p className="mb-2 text-[10px] text-white/65">{initiative.description}</p>
      )}

      {phases.length > 0 && (
        <PhaseProgress phases={phases} currentPhase={currentPhase} health={initiative.health} />
      )}

      <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-[9px] uppercase tracking-[0.08em]">
        <div className="rounded-md border border-white/[0.1] bg-black/25 px-1.5 py-1">
          <p className="text-white/35">Live Streams</p>
          <p className="text-[10px] font-semibold text-white">{initiative.activeAgents}</p>
        </div>
        <div className="rounded-md border border-white/[0.1] bg-black/25 px-1.5 py-1">
          <p className="text-white/35">Total Streams</p>
          <p className="text-[10px] font-semibold text-white">{initiative.totalAgents}</p>
        </div>
        <div className="rounded-md border border-white/[0.1] bg-black/25 px-1.5 py-1">
          <p className="text-white/35">Workstreams</p>
          <p className="text-[10px] font-semibold text-white">{workstreamCount}</p>
        </div>
      </div>
    </button>
  );
}
