import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { Phase } from '@/types';

interface PhaseProgressProps {
  phases: Phase[];
  currentPhase: number;
  health?: number;
}

function progressFromPhases(phases: Phase[], currentPhase: number): number {
  if (phases.length === 0) return 0;
  if (currentPhase >= phases.length - 1 && phases.every((phase) => phase.status === 'completed')) {
    return 100;
  }

  const baseline = (currentPhase / Math.max(1, phases.length - 1)) * 100;
  const current = phases[currentPhase];
  if (!current) return baseline;
  if (current.status === 'completed') return Math.min(100, baseline + 100 / phases.length);
  if (current.status === 'current' || current.status === 'warning') {
    return Math.min(100, baseline + 50 / phases.length);
  }
  return baseline;
}

export function PhaseProgress({ phases, currentPhase, health }: PhaseProgressProps) {
  const progress = progressFromPhases(phases, currentPhase);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between text-micro uppercase tracking-[0.1em] text-muted">
        <span>Momentum</span>
        <span>{Math.round(health ?? progress)}%</span>
      </div>

      <div className="relative">
        <div className="h-2 rounded-full bg-white/[0.08]" />
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.max(0, Math.min(100, progress))}%`,
            background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
            boxShadow: `0 0 18px ${colors.teal}45`,
          }}
        />

        {phases.map((phase, index) => {
          const left = (index / Math.max(1, phases.length - 1)) * 100;
          const isCompleted = phase.status === 'completed';
          const isCurrent = phase.status === 'current';
          const isWarning = phase.status === 'warning';

          return (
            <div
              key={phase.name}
              className="absolute top-1/2 z-10 -translate-y-1/2"
              style={{ left: `${left}%`, transform: 'translate(-50%, -50%)' }}
            >
              <div
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border text-micro font-semibold',
                  isCompleted && 'border-lime/80 bg-lime text-black',
                  isCurrent && 'border-lime/60 bg-lime/30 text-lime',
                  isWarning && 'border-amber-300/70 bg-amber-300 text-black',
                  !isCompleted && !isCurrent && !isWarning && 'border-white/20 bg-black/60 text-secondary'
                )}
              >
                {isCompleted ? '✓' : isWarning ? '!' : ''}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${Math.max(phases.length, 1)}, minmax(0, 1fr))` }}
      >
        {phases.map((phase) => (
          <span
            key={phase.name}
            className={cn(
              'truncate text-[8px] uppercase tracking-[0.12em]',
              phase.status === 'completed' || phase.status === 'current'
                ? 'text-secondary'
                : 'text-muted'
            )}
          >
            {phase.name}
          </span>
        ))}
      </div>
    </div>
  );
}
