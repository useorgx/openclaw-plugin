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
import { EntityIcon } from '@/components/shared/EntityIcon';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';

interface WorkstreamDetailProps {
  workstream: InitiativeWorkstream;
  initiative: Initiative;
}

export function WorkstreamDetail({ workstream, initiative }: WorkstreamDetailProps) {
  const { agentEntityMap, openModal, closeModal, authToken, embedMode, mutations } = useMissionControl();
  const agents = agentEntityMap.get(workstream.id) ?? agentEntityMap.get(initiative.id) ?? [];
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [draftName, setDraftName] = useState(workstream.name);
  const [draftSummary, setDraftSummary] = useState(workstream.summary ?? '');
  const [draftStatus, setDraftStatus] = useState(workstream.status);

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

  const normalizedStatus = workstream.status.toLowerCase();
  const isMutating =
    mutations.entityAction.isPending ||
    mutations.createEntity.isPending ||
    mutations.updateEntity.isPending ||
    mutations.deleteEntity.isPending;

  const handleSaveEdits = () => {
    const name = draftName.trim();
    if (!name) {
      setNotice('Workstream name is required.');
      return;
    }

    setNotice(null);
    mutations.updateEntity.mutate(
      {
        type: 'workstream',
        id: workstream.id,
        title: name,
        summary: draftSummary.trim() || null,
        status: draftStatus,
      },
      {
        onSuccess: () => {
          setEditMode(false);
          setNotice('Workstream updated.');
        },
        onError: (error) => {
          setNotice(error instanceof Error ? error.message : 'Failed to update workstream.');
        },
      }
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <EntityIcon type="initiative" size={12} className="flex-shrink-0 opacity-80" />
          <button
            onClick={() => openModal({ type: 'initiative', entity: initiative })}
            className="break-words text-white/45 transition-colors hover:text-white"
          >
            {initiative.name}
          </button>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/20">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
          <span className="break-words font-medium text-white/70">{workstream.name}</span>
        </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <EntityIcon type="workstream" size={16} />
          <h2 className="text-[16px] font-semibold text-white">
            {workstream.name}
          </h2>
          <span
            className={`text-[10px] px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(workstream.status)}`}
          >
            {formatEntityStatus(workstream.status)}
          </span>
        </div>
        {editMode ? (
          <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">Name</span>
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">Summary</span>
              <textarea
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">Status</span>
              <select
                value={draftStatus}
                onChange={(event) => setDraftStatus(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[12px] text-white/90 outline-none focus:border-white/30"
              >
                {['not_started', 'planned', 'active', 'in_progress', 'paused', 'blocked', 'done'].map((status) => (
                  <option key={status} value={status}>
                    {formatEntityStatus(status)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : workstream.summary ? (
          <p className="text-[13px] text-white/50 leading-relaxed">
            {workstream.summary}
          </p>
        ) : (
          <p className="text-[12px] text-white/35">No summary yet.</p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Agents</span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
        {notice && <div className="text-[11px] text-white/55">{notice}</div>}
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
            {progressValue !== null ? `${progressValue}%` : '-'}
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
                  className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.06]"
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
                  className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.06]"
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

          {/* Notes */}
          <div className="mt-2 space-y-2 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">
                  Notes
                </p>
                <p className="mt-1 text-[11px] text-white/35">
                  Commentary thread for humans and agents on this workstream.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNotes((prev) => !prev)}
                className="inline-flex items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold tracking-wide text-white/80 transition-colors hover:bg-white/[0.09]"
              >
                {showNotes ? 'Hide' : 'Show'}
              </button>
            </div>
            {showNotes ? (
              <div className="pt-3 border-t border-white/[0.06]">
                <EntityCommentsPanel
                  entityType="workstream"
                  entityId={workstream.id}
                  authToken={authToken}
                  embedMode={embedMode}
                />
              </div>
            ) : null}
          </div>

        </>
      )}
      </div>

      {/* Actions */}
      <div className="border-t border-white/[0.06] bg-[#070b12]/85 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {['not_started', 'planned', 'todo'].includes(normalizedStatus) && (
            <EntityActionButton label="Start" color={colors.lime} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'start' })} disabled={isMutating} />
          )}
          {['active', 'in_progress'].includes(normalizedStatus) && (
            <>
              <EntityActionButton label="Complete" color={colors.teal} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'complete' })} disabled={isMutating} />
              <EntityActionButton label="Pause" color={colors.amber} onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'pause' })} disabled={isMutating} />
              <EntityActionButton label="Block" color={colors.red} variant="destructive" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'block' })} disabled={isMutating} />
            </>
          )}
          {['paused', 'blocked'].includes(normalizedStatus) && (
            <EntityActionButton label="Resume" color={colors.lime} variant="primary" onClick={() => mutations.entityAction.mutate({ type: 'workstream', id: workstream.id, action: 'resume' })} disabled={isMutating} />
          )}
          {editMode ? (
            <>
              <EntityActionButton
                label="Save"
                color={colors.teal}
                variant="primary"
                onClick={handleSaveEdits}
                disabled={isMutating || !draftName.trim()}
              />
              <EntityActionButton
                label="Cancel"
                variant="ghost"
                onClick={() => {
                  setEditMode(false);
                  setDraftName(workstream.name);
                  setDraftSummary(workstream.summary ?? '');
                  setDraftStatus(workstream.status);
                  setNotice(null);
                }}
                disabled={isMutating}
              />
            </>
          ) : (
            <EntityActionButton
              label="Edit"
              variant="ghost"
              onClick={() => {
                setEditMode(true);
                setNotice(null);
              }}
              disabled={isMutating}
            />
          )}

          <div className="flex-1" />

          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-white/60">Delete workstream?</span>
              <EntityActionButton
                label="Delete"
                color={colors.red}
                variant="destructive"
                onClick={() =>
                  mutations.deleteEntity.mutate(
                    { type: 'workstream', id: workstream.id },
                    {
                      onSuccess: () => closeModal(),
                      onError: (error) =>
                        setNotice(
                          error instanceof Error ? error.message : 'Failed to delete workstream.'
                        ),
                    }
                  )
                }
                disabled={isMutating}
              />
              <EntityActionButton
                label="Keep"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={isMutating}
              />
            </div>
          ) : (
            <EntityActionButton
              label="Delete"
              color={colors.red}
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={isMutating}
            />
          )}

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
                  {
                    onSuccess: () => {
                      setTaskTitle('');
                      setAddingTask(false);
                    },
                    onError: (error) => {
                      setNotice(error instanceof Error ? error.message : 'Failed to create task.');
                    },
                  }
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
              <EntityActionButton
                label="Add"
                color={colors.lime}
                type="submit"
                size="sm"
                disabled={!taskTitle.trim() || mutations.createEntity.isPending}
              />
              <EntityActionButton
                label="Cancel"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingTask(false);
                  setTaskTitle('');
                }}
              />
            </form>
          ) : (
            <EntityActionButton
              label="+ Task"
              variant="ghost"
              onClick={() => setAddingTask(true)}
              disabled={isMutating}
            />
          )}
        </div>
      </div>
    </div>
  );
}
