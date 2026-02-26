import { useMemo, useState } from 'react';
import { colors } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';
import type { Initiative, InitiativeWorkstream } from '@/types';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';
import { useNextUpQueueActions } from '@/hooks/useNextUpQueueActions';
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
import { EntityArtifactsPanel } from '@/components/artifacts/EntityArtifactsPanel';
import { QueuePlacementControl } from './QueuePlacementControl';

interface WorkstreamDetailProps {
  workstream: InitiativeWorkstream;
  initiative: Initiative;
}

type QueuePlacement = 'top' | 'bottom';

export function WorkstreamDetail({ workstream, initiative }: WorkstreamDetailProps) {
  const { agentEntityMap, openModal, closeModal, authToken, embedMode, mutations } = useMissionControl();
  const agents = agentEntityMap.get(workstream.id) ?? agentEntityMap.get(initiative.id) ?? [];
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(workstream.name);
  const [draftSummary, setDraftSummary] = useState(workstream.summary ?? '');
  const [draftStatus, setDraftStatus] = useState(workstream.status);

  const { details, isLoading } = useInitiativeDetails({
    initiativeId: initiative.id,
    authToken,
    embedMode,
  });
  const nextUpActions = useNextUpQueueActions({ authToken, embedMode });

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
  const queueActionBusy = nextUpActions.isPinning || nextUpActions.isMoving;
  const formatNoticeError = (raw: string | undefined, fallback: string) =>
    raw && raw.trim().length > 0 ? humanizeWarning(raw.trim()) : fallback;

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
          setNotice(
            formatNoticeError(
              error instanceof Error ? error.message : '',
              'Failed to update workstream.'
            )
          );
        },
      }
    );
  };

  const queueWorkstream = async (placement: QueuePlacement) => {
    setNotice(null);
    try {
      await nextUpActions.pin({
        initiativeId: initiative.id,
        workstreamId: workstream.id,
      });
      await nextUpActions.move({
        initiativeId: initiative.id,
        workstreamId: workstream.id,
        placement,
      });
      setNotice(`Queued workstream to ${placement === 'top' ? 'top' : 'end'}.`);
    } catch (error) {
      setNotice(
        formatNoticeError(error instanceof Error ? error.message : '', 'Failed to queue workstream.')
      );
    }
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-caption">
          <EntityIcon type="initiative" size={12} className="flex-shrink-0 opacity-80" />
          <button
            onClick={() => openModal({ type: 'initiative', entity: initiative })}
            className="break-words text-secondary transition-colors hover:text-white"
          >
            {initiative.name}
          </button>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-faint">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <EntityIcon type="workstream" size={12} className="flex-shrink-0 opacity-95" />
          <span className="break-words font-medium text-primary">{workstream.name}</span>
        </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <EntityIcon type="workstream" size={16} />
          <h2 className="text-title font-semibold text-white">
            {workstream.name}
          </h2>
          <span
            className={`text-micro px-2.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getWorkstreamStatusClass(workstream.status)}`}
          >
            {formatEntityStatus(workstream.status)}
          </span>
        </div>
        {editMode ? (
          <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">Name</span>
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">Summary</span>
              <textarea
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
              />
            </label>
            <label className="block">
              <span className="text-micro uppercase tracking-[0.08em] text-muted">Status</span>
              <select
                value={draftStatus}
                onChange={(event) => setDraftStatus(event.target.value)}
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-body text-bright outline-none focus:border-white/30"
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
          <p className="text-body text-secondary leading-relaxed">
            {workstream.summary}
          </p>
        ) : (
          <p className="text-body text-muted">No summary yet.</p>
        )}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-micro text-muted uppercase tracking-wider">Agents</span>
            <InferredAgentAvatars agents={agents} max={6} />
          </div>
        )}
        {notice && <div className="text-caption text-secondary">{notice}</div>}
      </div>

      {/* Inline stats + progress */}
      <div className="space-y-2">
        <p className="text-caption text-secondary">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} · {doneTaskCount}/{tasks.length} done
          {milestones.length > 0 && ` · ${milestones.length} milestone${milestones.length === 1 ? '' : 's'}`}
        </p>
        {progressValue !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(progressValue, 2)}%`, backgroundColor: colors.lime }}
              />
            </div>
            <span className="text-micro text-secondary tabular-nums">{progressValue}%</span>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`ws-detail-${i}`} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Milestones — flat rows */}
          {milestones.length > 0 && (
            <div className="space-y-1">
              {milestones.map((ms) => (
                <button
                  key={ms.id}
                  onClick={() => openModal({ type: 'milestone', entity: ms, initiative })}
                  className="flex w-full items-center justify-between gap-2 rounded-lg py-2 pl-3 pr-2 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <span className="text-body text-bright break-words">{ms.title}</span>
                  <span className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getMilestoneStatusClass(ms.status)}`}>
                    {formatEntityStatus(ms.status)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Tasks — flat rows with status-tinted left border */}
          {tasks.length > 0 && (
            <div className="space-y-1">
              {tasks.map((task) => {
                const ts = task.status.toLowerCase();
                const borderColor = ['active', 'in_progress'].includes(ts) ? colors.lime
                  : ts === 'blocked' ? colors.red
                  : ['done', 'completed'].includes(ts) ? colors.teal
                  : 'rgba(255,255,255,0.08)';
                return (
                  <button
                    key={task.id}
                    onClick={() => openModal({ type: 'task', entity: task, initiative })}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border-l-2 py-2 pl-3 pr-2 text-left transition-colors hover:bg-white/[0.04]"
                    style={{ borderLeftColor: borderColor }}
                  >
                    <div className="min-w-0">
                      <span className="text-body text-bright break-words">{task.title}</span>
                      {task.priority && (
                        <span className="text-micro text-muted mt-0.5 block uppercase tracking-wider">{task.priority}</span>
                      )}
                    </div>
                    <span className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] flex-shrink-0 ${getTaskStatusClass(task.status)}`}>
                      {formatEntityStatus(task.status)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

          {/* Artifacts */}
          <EntityArtifactsPanel
            entityType="workstream"
            entityId={workstream.id}
            title="Artifacts (from milestones)"
            authToken={authToken}
            embedMode={embedMode}
            finalOnly
            milestoneIds={milestones.map((m) => m.id)}
          />

          {/* Notes — inline, always visible */}
          <div className="space-y-2">
            <EntityCommentsPanel
              entityType="workstream"
              entityId={workstream.id}
              authToken={authToken}
              embedMode={embedMode}
            />
          </div>
        </>
      )}
      </div>

      {/* Actions */}
      <div className="border-t border-subtle bg-[#070b12]/85 px-6 py-3 backdrop-blur">
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
          <QueuePlacementControl
            label="Queue"
            size="md"
            busy={queueActionBusy}
            disabled={isMutating}
            title={`Queue workstream: ${workstream.name}`}
            onSelectPlacement={queueWorkstream}
          />
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
              <span className="text-caption text-secondary">Delete workstream?</span>
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
                          formatNoticeError(
                            error instanceof Error ? error.message : '',
                            'Failed to delete workstream.'
                          )
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
                      setNotice(
                        formatNoticeError(
                          error instanceof Error ? error.message : '',
                          'Failed to create task.'
                        )
                      );
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
                className="text-body bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-primary placeholder-white/30 w-[160px] outline-none focus:border-white/25"
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
