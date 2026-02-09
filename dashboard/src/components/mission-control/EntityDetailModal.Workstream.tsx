import { useMemo, useState } from 'react';
import { colors } from '@/lib/tokens';
import type { Initiative, InitiativeWorkstream } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import {
  getWorkstreamStatusClass,
  getTaskStatusClass,
  getMilestoneStatusClass,
  formatEntityStatus,
  statusRank,
} from '@/lib/entityStatusColors';
import { clampPercent, completionPercent, isDoneStatus } from '@/lib/progress';
import { Skeleton } from '@/components/shared/Skeleton';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';

interface WorkstreamDetailProps {
  workstream: InitiativeWorkstream;
  initiative: Initiative;
}

export function WorkstreamDetail({ workstream, initiative }: WorkstreamDetailProps) {
  const { agentEntityMap, openModal, authToken, embedMode, mutations } = useMissionControl();
  const agents = agentEntityMap.get(workstream.id) ?? agentEntityMap.get(initiative.id) ?? [];
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');

  const { details, isLoading } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });

  const milestones = useMemo(() => {
    return details.milestones.filter((m) => m.workstreamId === workstream.id);
  }, [details.milestones, workstream.id]);

  const milestoneIdSet = useMemo(() => new Set(milestones.map((m) => m.id)), [milestones]);

  const tasks = useMemo(() => {
    return details.tasks
      .filter(
        (t) =>
          t.workstreamId === workstream.id ||
          (t.milestoneId !== null && milestoneIdSet.has(t.milestoneId))
      )
      .sort((a, b) => {
        const rankDiff = statusRank(a.status) - statusRank(b.status);
        if (rankDiff !== 0) return rankDiff;
        const dateA = a.createdAt ? Date.parse(a.createdAt) : 0;
        const dateB = b.createdAt ? Date.parse(b.createdAt) : 0;
        return dateB - dateA;
      });
  }, [details.tasks, milestoneIdSet, workstream.id]);

  const doneTaskCount = tasks.filter((t) => isDoneStatus(t.status)).length;
  const progressValue =
    tasks.length > 0
      ? completionPercent(doneTaskCount, tasks.length)
      : typeof workstream.progress === 'number'
        ? clampPercent(
            workstream.progress <= 1 ? workstream.progress * 100 : workstream.progress
          )
        : isDoneStatus(workstream.status)
          ? 100
          : null;

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
          <span className="break-words font-medium text-white/70">{workstream.name}</span>
        </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-[16px] font-semibold text-white">
            {workstream.name}
          </h2>
          <span
            className={`text-[10px] px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(workstream.status)}`}
          >
            {formatEntityStatus(workstream.status)}
          </span>
        </div>
        {workstream.summary && (
          <p className="text-[13px] text-white/50 leading-relaxed">
            {workstream.summary}
          </p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Agents</span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
      </div>

      {/* Progress */}
      {progressValue !== null && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Progress</span>
            <span className="text-[12px] text-white/60">{progressValue}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progressValue}%`, backgroundColor: colors.lime }}
            />
          </div>
        </div>
      )}

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Tasks</div>
          <div className="text-[15px] font-medium text-white/80 mt-0.5">{tasks.length}</div>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Milestones</div>
          <div className="text-[15px] font-medium text-white/80 mt-0.5">{milestones.length}</div>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-white/35">Progress</div>
          <div className="text-[15px] font-medium text-white/80 mt-0.5">
            {progressValue !== null ? `${progressValue}%` : '\u2014'}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`ws-detail-${i}`} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Milestones */}
          {milestones.length > 0 && (
            <div className="space-y-2">
              <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">
                Milestones
              </span>
              {milestones.map((ms) => (
                <button
                  key={ms.id}
                  onClick={() => openModal({ type: 'milestone', entity: ms, initiative })}
                  className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-all hover:bg-white/[0.06] hover-lift"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-white/90">{ms.title}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(ms.status)}`}>
                      {formatEntityStatus(ms.status)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Tasks */}
          {tasks.length > 0 && (
            <div className="space-y-2">
              <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">
                Tasks ({tasks.length})
              </span>
              {tasks.map((task) => (
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
                  {task.priority && (
                    <span className="text-[10px] text-white/30 mt-0.5 block uppercase tracking-wider">
                      Priority: {task.priority}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

        </>
      )}
      </div>

      {/* Actions */}
      <div className="border-t border-white/[0.06] bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {workstream.status === 'not_started' && (
            <ActionBtn label="Start" color={colors.lime} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'start' })} disabled={mutations.entityAction.isPending} />
          )}
          {workstream.status === 'active' && (
            <>
              <ActionBtn label="Complete" color={colors.teal} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'complete' })} disabled={mutations.entityAction.isPending} />
              <ActionBtn label="Pause" color={colors.amber} onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'pause' })} disabled={mutations.entityAction.isPending} />
              <ActionBtn label="Block" color={colors.red} variant="destructive" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'block' })} disabled={mutations.entityAction.isPending} />
            </>
          )}
          {(workstream.status === 'paused' || workstream.status === 'blocked') && (
            <ActionBtn label="Resume" color={colors.lime} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'resume' })} disabled={mutations.entityAction.isPending} />
          )}
          <div className="flex-1" />
          {addingTask ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!taskTitle.trim()) return;
                mutations.createEntity.mutate(
                  {
                    type: 'task',
                    title: taskTitle.trim(),
                    workstream_id: workstream.id,
                    initiative_id: initiative.id,
                    status: 'todo',
                  },
                  { onSuccess: () => { setTaskTitle(''); setAddingTask(false); } },
                );
              }}
            >
              <input
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Task title..."
                autoFocus
                className="text-[12px] bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/80 placeholder-white/30 w-[160px] outline-none focus:border-white/25"
              />
              <ActionBtn label="Add" color={colors.lime} onClick={() => {}} disabled={!taskTitle.trim() || mutations.createEntity.isPending} />
              <button
                type="button"
                onClick={() => { setAddingTask(false); setTaskTitle(''); }}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/40 border border-white/10"
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() => setAddingTask(true)}
              className="text-[11px] px-3 py-1.5 rounded-lg border bg-white/5 text-white/50 border-white/10 hover:bg-white/10 transition-colors"
            >
              + Task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  color,
  onClick,
  disabled,
  variant = 'secondary',
}: {
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'destructive';
}) {
  const sharedStyle =
    variant === 'primary'
      ? { backgroundColor: color, color: '#05060A', borderColor: `${color}CC` }
      : variant === 'destructive'
        ? { backgroundColor: `${color}14`, color, borderColor: `${color}40` }
        : { backgroundColor: `${color}20`, color, borderColor: `${color}30` };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50"
      style={sharedStyle}
    >
      {label}
    </button>
  );
}
