import { colors } from '@/lib/tokens';
import type { Initiative, InitiativeMilestone } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  getMilestoneStatusClass,
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { useMissionControl } from './MissionControlContext';

interface MilestoneDetailProps {
  milestone: InitiativeMilestone;
  initiative: Initiative;
}

export function MilestoneDetail({ milestone, initiative }: MilestoneDetailProps) {
  const { openModal, authToken, embedMode, mutations } = useMissionControl();

  const { details } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });

  const associatedTasks = details.tasks.filter(
    (t) => t.milestoneId === milestone.id
  );

  const isDone =
    milestone.status.toLowerCase() === 'done' ||
    milestone.status.toLowerCase() === 'completed';

  return (
    <div className="p-6 space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-[11px]">
        <button
          onClick={() => openModal({ type: 'initiative', entity: initiative })}
          className="text-white/45 hover:text-white transition-colors truncate max-w-[200px]"
        >
          {initiative.name}
        </button>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20">
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span className="text-white/70 font-medium truncate">{milestone.title}</span>
      </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full border flex-shrink-0"
            style={{
              backgroundColor: isDone ? `${colors.teal}99` : 'rgba(255,255,255,0.1)',
              borderColor: isDone ? `${colors.teal}66` : 'rgba(255,255,255,0.2)',
            }}
          />
          <h2 className="text-[16px] font-semibold text-white">
            {milestone.title}
          </h2>
          <span
            className={`text-[10px] px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(milestone.status)}`}
          >
            {formatEntityStatus(milestone.status)}
          </span>
        </div>
        {milestone.description && (
          <p className="text-[13px] text-white/50 leading-relaxed">
            {milestone.description}
          </p>
        )}
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-3">
        {milestone.dueDate && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Due Date</div>
            <div className="text-[13px] text-white/80 mt-0.5">
              {new Date(milestone.dueDate).toLocaleDateString()}
            </div>
          </div>
        )}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Associated Tasks</div>
          <div className="text-[15px] font-medium text-white/80 mt-0.5">
            {associatedTasks.length}
          </div>
        </div>
      </div>

      {/* Associated tasks */}
      {associatedTasks.length > 0 && (
        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">
            Tasks
          </span>
          {associatedTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => openModal({ type: 'task', entity: task, initiative })}
              className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-all hover:bg-white/[0.06] hover-lift"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-white/90 truncate">{task.title}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getTaskStatusClass(task.status)}`}>
                  {formatEntityStatus(task.status)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Actions */}
      {!isDone && (
        <div className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
          {milestone.status.toLowerCase() === 'planned' && (
            <button
              onClick={() => mutations.entityAction.mutate({ type: 'milestone', id: milestone.id, action: 'start' })}
              disabled={mutations.entityAction.isPending}
              className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
              style={{ backgroundColor: `${colors.lime}20`, color: colors.lime, borderColor: `${colors.lime}30` }}
            >
              Start
            </button>
          )}
          {(milestone.status.toLowerCase() === 'in_progress' || milestone.status.toLowerCase() === 'at_risk') && (
            <button
              onClick={() => {
                const allDone = associatedTasks.length === 0 || associatedTasks.every((t) =>
                  ['done', 'completed'].includes(t.status.toLowerCase())
                );
                mutations.entityAction.mutate({
                  type: 'milestone',
                  id: milestone.id,
                  action: 'complete',
                  force: !allDone,
                });
              }}
              disabled={mutations.entityAction.isPending}
              className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
              style={{ backgroundColor: `${colors.teal}20`, color: colors.teal, borderColor: `${colors.teal}30` }}
            >
              {associatedTasks.length > 0 &&
                !associatedTasks.every((t) => ['done', 'completed'].includes(t.status.toLowerCase()))
                ? 'Complete (force)'
                : 'Complete'}
            </button>
          )}
          {mutations.entityAction.error && (
            <span className="text-[11px] ml-2" style={{ color: `${colors.red}b3` }}>
              {(mutations.entityAction.error as Error)?.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
