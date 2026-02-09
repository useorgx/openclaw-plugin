import { colors } from '@/lib/tokens';
import type { Initiative, InitiativeMilestone } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  getMilestoneStatusClass,
  getTaskStatusClass,
  formatEntityStatus,
} from '@/lib/entityStatusColors';
import { completionPercent, isDoneStatus } from '@/lib/progress';
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
  const doneTaskCount = associatedTasks.filter((t) => isDoneStatus(t.status)).length;
  const progressValue =
    associatedTasks.length > 0
      ? completionPercent(doneTaskCount, associatedTasks.length)
      : isDone
        ? 100
        : 0;

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <button
            onClick={() => openModal({ type: 'initiative', entity: initiative })}
            className="break-words text-white/45 transition-colors hover:text-white"
          >
            {initiative.name}
          </button>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="break-words font-medium text-white/70">{milestone.title}</span>
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Completion</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progressValue}%`, backgroundColor: colors.teal }}
              />
            </div>
            <div className="text-[12px] text-white/75" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {progressValue}%
            </div>
          </div>
          <div className="mt-1 text-[10px] text-white/35">
            {doneTaskCount}/{associatedTasks.length} done
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
                <span className="text-[12px] text-white/90">{task.title}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getTaskStatusClass(task.status)}`}>
                  {formatEntityStatus(task.status)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      </div>

      {/* Actions */}
      <div className="border-t border-white/[0.06] bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {!isDone && milestone.status.toLowerCase() === 'planned' && (
            <button
              onClick={() => mutations.entityAction.mutate({ type: 'milestone', id: milestone.id, action: 'start' })}
              disabled={mutations.entityAction.isPending}
              className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
              style={{ backgroundColor: colors.lime, color: '#05060A', borderColor: `${colors.lime}CC` }}
            >
              Start
            </button>
          )}
          {!isDone && (milestone.status.toLowerCase() === 'in_progress' || milestone.status.toLowerCase() === 'at_risk') && (
            <button
              onClick={() => {
                const allDone = associatedTasks.length === 0 || associatedTasks.every((t) => isDoneStatus(t.status));
                mutations.entityAction.mutate({
                  type: 'milestone',
                  id: milestone.id,
                  action: 'complete',
                  force: !allDone,
                });
              }}
              disabled={mutations.entityAction.isPending}
              className="text-[11px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
              style={{ backgroundColor: colors.teal, color: '#05060A', borderColor: `${colors.teal}CC` }}
            >
              {associatedTasks.length > 0 &&
                !associatedTasks.every((t) => isDoneStatus(t.status))
                ? 'Complete (force)'
                : 'Complete'}
            </button>
          )}
          {isDone && (
            <span className="text-[11px] text-white/50">Milestone is complete.</span>
          )}
          {mutations.entityAction.error && (
            <span className="text-[11px] ml-2" style={{ color: `${colors.red}b3` }}>
              {(mutations.entityAction.error as Error)?.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
