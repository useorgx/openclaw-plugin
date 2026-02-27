import { useMemo } from 'react';
import { colors } from '@/lib/tokens';
import type { InitiativeMilestone, Initiative } from '@/types';
import { useMissionControl } from './MissionControlContext';

interface MilestoneStripProps {
  milestones: InitiativeMilestone[];
  initiative: Initiative;
}

export function MilestoneStrip({ milestones, initiative }: MilestoneStripProps) {
  const { openModal } = useMissionControl();

  /** Sort milestones by sequenceIndex (ascending), pushing those without to the end */
  const sortedMilestones = useMemo(
    () =>
      [...milestones].sort((a, b) => {
        const aSeq = a.sequenceIndex ?? Infinity;
        const bSeq = b.sequenceIndex ?? Infinity;
        return aSeq - bSeq;
      }),
    [milestones]
  );

  if (!sortedMilestones.length) return null;

  return (
    <div className="flex items-center gap-1 px-1">
      <span className="text-micro text-muted uppercase tracking-wider mr-1 flex-shrink-0">
        Milestones
      </span>
      <div className="flex items-center gap-0.5">
        {sortedMilestones.map((milestone, index) => {
          const lower = milestone.status.toLowerCase();
          const isDone = lower === 'done' || lower === 'completed';
          const isActive = lower === 'active' || lower === 'in_progress';

          const milestoneLabel =
            milestone.sequenceIndex != null
              ? `M${milestone.sequenceIndex + 1}`
              : milestone.hierarchyLabel ?? null;

          return (
            <button
              key={milestone.id}
              type="button"
              onClick={() => openModal({ type: 'milestone', entity: milestone, initiative })}
              className="group flex items-center rounded px-1 py-1"
              title={`${milestoneLabel ? `${milestoneLabel} ` : ''}${milestone.title} — ${milestone.status}`}
            >
              {milestoneLabel && (
                <span className="text-[10px] tracking-wider uppercase font-mono tabular-nums opacity-60 group-hover:opacity-100 transition-opacity leading-none select-none mr-0.5">
                  {milestoneLabel}
                </span>
              )}
              <div
                className="h-3.5 w-3.5 rounded-full border transition-transform group-hover:scale-110"
                style={{
                  backgroundColor: isDone
                    ? `${colors.teal}99`
                    : isActive
                      ? `${colors.lime}99`
                      : 'rgba(255,255,255,0.1)',
                  borderColor: isDone
                    ? `${colors.teal}66`
                    : isActive
                      ? `${colors.lime}66`
                      : 'rgba(255,255,255,0.2)',
                }}
              />
              {index < sortedMilestones.length - 1 && (
                <div
                  className="w-3 h-px"
                  style={{
                    backgroundColor: isDone ? `${colors.teal}4d` : 'rgba(255,255,255,0.08)',
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      {sortedMilestones.length > 0 && (
        <span className="text-micro text-faint ml-1">
          {sortedMilestones.filter(
            (m) =>
              m.status.toLowerCase() === 'done' ||
              m.status.toLowerCase() === 'completed'
          ).length}
          /{sortedMilestones.length}
        </span>
      )}
    </div>
  );
}
