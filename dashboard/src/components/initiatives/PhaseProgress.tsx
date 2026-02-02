import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { Phase } from '@/types';

interface PhaseProgressProps {
  phases: Phase[];
  currentPhase: number;
}

export function PhaseProgress({ phases, currentPhase }: PhaseProgressProps) {
  return (
    <div className="relative">
      <div className="relative flex items-center">
        {phases.map((phase, i) => {
          const isLast = i === phases.length - 1;
          const progress = i < currentPhase ? 100 : i === currentPhase ? 50 : 0;

          return (
            <div key={phase.name} className="flex-1 relative">
              <div className="h-1 rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${progress}%`,
                    background: `linear-gradient(90deg, ${colors.lime}, ${colors.teal})`,
                  }}
                />
              </div>

              {!isLast && (
                <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10">
                  {phase.status === 'completed' || phase.status === 'current' ? (
                    <div
                      className="w-3.5 h-3.5 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: colors.lime }}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  ) : phase.status === 'warning' ? (
                    <div
                      className="w-3.5 h-3.5 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: colors.teal }}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                      </svg>
                    </div>
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-white/20" />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between mt-1.5">
        {phases.map((phase) => (
          <span
            key={phase.name}
            className={cn(
              'text-[8px] font-medium tracking-wider uppercase',
              phase.status === 'completed' || phase.status === 'current'
                ? 'text-white/50'
                : 'text-white/25'
            )}
          >
            {phase.name}
          </span>
        ))}
      </div>
    </div>
  );
}
