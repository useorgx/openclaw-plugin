import type { Initiative } from '@/types';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { PhaseProgress } from './PhaseProgress';

interface InitiativeCardProps {
  initiative: Initiative;
  onClick: () => void;
}

function AvatarStack({ names }: { names: string[] }) {
  return (
    <div className="flex -space-x-1">
      {names.slice(0, 3).map((name, i) => (
        <div key={name} className="relative" style={{ zIndex: names.length - i }}>
          <AgentAvatar name={name} size="xs" />
        </div>
      ))}
    </div>
  );
}

export function InitiativeCard({ initiative, onClick }: InitiativeCardProps) {
  const phases = initiative.phases ?? [];
  const currentPhase = initiative.currentPhase ?? 0;
  const avatars = initiative.avatars ?? [];

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
    >
      <div className="flex items-start gap-2.5 mb-2">
        {avatars.length > 0 && <AvatarStack names={avatars} />}
        <div className="flex-1 min-w-0">
          <h4 className="text-[12px] font-medium text-white truncate">
            {initiative.name}
          </h4>
          <span className="text-[9px] font-medium tracking-wider text-white/40 uppercase">
            {initiative.category ?? 'INITIATIVE'}
          </span>
        </div>
      </div>
      {phases.length > 0 && (
        <PhaseProgress phases={phases} currentPhase={currentPhase} />
      )}
    </button>
  );
}
