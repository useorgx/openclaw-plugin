import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '@/lib/entityStatusColors';
import { clampPercent, completionPercent, isDoneStatus } from '@/lib/progress';
import { Skeleton } from '@/components/shared/Skeleton';
import { InferredAgentAvatars } from './AgentInference';
import { useMissionControl } from './MissionControlContext';
import { EntityActionButton } from './EntityActionButton';
import { EntityCommentsPanel } from '@/components/comments/EntityCommentsPanel';
import { EntityArtifactsPanel } from '@/components/artifacts/EntityArtifactsPanel';
import { QueuePlacementControl } from './QueuePlacementControl';
import { IwmtLevelIcon, iwmtLevelCode } from './IwmtLevelIcon';

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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(workstream.name);
  const [draftSummary, setDraftSummary] = useState(workstream.summary ?? '');
  const [draftStatus, setDraftStatus] = useState(workstream.status);

  // Close overflow menu on outside click or Escape
  useEffect(() => {
    if (!overflowOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [overflowOpen]);

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
        const sequenceA =
          typeof a.sequenceIndex === 'number' ? a.sequenceIndex : Number.POSITIVE_INFINITY;
        const sequenceB =
          typeof b.sequenceIndex === 'number' ? b.sequenceIndex : Number.POSITIVE_INFINITY;
        if (sequenceA !== sequenceB) return sequenceA - sequenceB;
        const dateA = a.createdAt ? Date.parse(a.createdAt) : 0;
        const dateB = b.createdAt ? Date.parse(b.createdAt) : 0;
        return dateA - dateB;
      });
  }, [details.tasks, milestoneIdSet, workstream.id]);
  const tasksByMilestone = useMemo(() => {
    const grouped = new Map<string, typeof tasks>();
    for (const task of tasks) {
      if (!task.milestoneId) continue;
      const current = grouped.get(task.milestoneId);
      if (current) {
        current.push(task);
      } else {
        grouped.set(task.milestoneId, [task]);
      }
    }
    return grouped;
  }, [tasks]);
  const unscopedTasks = useMemo(
    () => tasks.filter((task) => !task.milestoneId),
    [tasks]
  );

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
  const runWorkstreamAction = (
    action: 'start' | 'complete' | 'pause' | 'block' | 'resume',
    successMessage: string,
    fallbackErrorMessage: string
  ) => {
    setNotice(null);
    mutations.entityAction.mutate(
      { type: 'workstream', id: workstream.id, action },
      {
        onSuccess: () => setNotice(successMessage),
        onError: (error) => {
          setNotice(
            formatNoticeError(
              error instanceof Error ? error.message : '',
              fallbackErrorMessage
            )
          );
        },
      }
    );
  };

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
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <IwmtLevelIcon level="workstream" size={16} />
          <h2 className="text-title font-semibold text-white">
            {workstream.name}
          </h2>
          <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-micro font-semibold uppercase tracking-[0.08em] text-white/65">
            {workstream.hierarchyLabel ?? iwmtLevelCode('workstream')}
          </span>
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
          {(milestones.length > 0 || unscopedTasks.length > 0) && (
            <section className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">
                IWMT Composition
              </h3>

              <div className="space-y-2.5">
                {milestones.map((milestone) => {
                  const milestoneTasks = tasksByMilestone.get(milestone.id) ?? [];
                  const doneMilestoneTasks = milestoneTasks.filter((task) =>
                    isDoneStatus(task.status)
                  ).length;

                  return (
                    <article
                      key={milestone.id}
                      className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          onClick={() =>
                            openModal({ type: 'milestone', entity: milestone, initiative })
                          }
                          className="group min-w-0 flex-1 text-left"
                        >
                          <div className="flex min-w-0 items-start gap-2.5">
                            <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.04]">
                              <IwmtLevelIcon level="milestone" size={12} />
                            </span>
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="text-micro font-semibold uppercase tracking-[0.08em] text-white/58">
                                  {milestone.hierarchyLabel ?? iwmtLevelCode('milestone')}
                                </span>
                                <span className="truncate text-body text-bright">
                                  {milestone.title}
                                </span>
                              </div>
                              <p className="mt-0.5 text-caption text-muted">
                                {doneMilestoneTasks}/{milestoneTasks.length} tasks done
                              </p>
                            </div>
                          </div>
                        </button>
                        <span
                          className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getMilestoneStatusClass(
                            milestone.status
                          )}`}
                        >
                          {formatEntityStatus(milestone.status)}
                        </span>
                      </div>

                      <div className="ml-7 mt-2.5 border-l border-white/[0.08] pl-3">
                        {milestoneTasks.length > 0 ? (
                          <div className="space-y-1.5">
                            {milestoneTasks.map((task) => (
                              <button
                                key={task.id}
                                onClick={() =>
                                  openModal({ type: 'task', entity: task, initiative })
                                }
                                className="flex w-full items-center justify-between gap-2 rounded-lg bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                              >
                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <IwmtLevelIcon level="task" size={11} className="flex-shrink-0" />
                                    <span className="text-micro uppercase tracking-[0.08em] text-white/50">
                                      {task.hierarchyLabel ?? iwmtLevelCode('task')}
                                    </span>
                                    <span className="truncate text-caption text-bright">
                                      {task.title}
                                    </span>
                                  </div>
                                  {task.priority && (
                                    <p className="mt-0.5 text-micro uppercase tracking-[0.08em] text-muted">
                                      {task.priority}
                                    </p>
                                  )}
                                </div>
                                <span
                                  className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getTaskStatusClass(
                                    task.status
                                  )}`}
                                >
                                  {formatEntityStatus(task.status)}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="rounded-lg border border-dashed border-white/[0.1] bg-white/[0.01] px-3 py-2 text-micro text-muted">
                            No tasks yet.
                          </p>
                        )}
                      </div>
                    </article>
                  );
                })}

                {unscopedTasks.length > 0 && (
                  <article className="rounded-xl border border-white/[0.08] bg-white/[0.015] px-3 py-2.5">
                    <p className="text-micro uppercase tracking-[0.1em] text-white/50">
                      Unscoped tasks
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {unscopedTasks.map((task) => (
                        <button
                          key={task.id}
                          onClick={() =>
                            openModal({ type: 'task', entity: task, initiative })
                          }
                          className="flex w-full items-center justify-between gap-2 rounded-lg bg-white/[0.015] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <IwmtLevelIcon level="task" size={11} className="flex-shrink-0" />
                              <span className="text-micro uppercase tracking-[0.08em] text-white/50">
                                {task.hierarchyLabel ?? iwmtLevelCode('task')}
                              </span>
                              <span className="truncate text-caption text-bright">
                                {task.title}
                              </span>
                            </div>
                          </div>
                          <span
                            className={`text-micro px-1.5 py-0.5 rounded-full border uppercase tracking-[0.08em] ${getTaskStatusClass(
                              task.status
                            )}`}
                          >
                            {formatEntityStatus(task.status)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </article>
                )}
              </div>
            </section>
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
            <EntityActionButton
              label="Start"
              color={colors.lime}
              variant="primary"
              onClick={() =>
                runWorkstreamAction('start', 'Workstream started.', 'Failed to start workstream.')
              }
              disabled={isMutating}
            />
          )}
          {['active', 'in_progress'].includes(normalizedStatus) && (
            <>
              <EntityActionButton
                label="Complete"
                color={colors.teal}
                variant="primary"
                onClick={() =>
                  runWorkstreamAction(
                    'complete',
                    'Workstream marked complete.',
                    'Failed to complete workstream.'
                  )
                }
                disabled={isMutating}
              />
              <EntityActionButton
                label="Pause"
                color={colors.amber}
                onClick={() =>
                  runWorkstreamAction('pause', 'Workstream paused.', 'Failed to pause workstream.')
                }
                disabled={isMutating}
              />
              <EntityActionButton
                label="Block"
                color={colors.red}
                variant="destructive"
                onClick={() =>
                  runWorkstreamAction('block', 'Workstream blocked.', 'Failed to block workstream.')
                }
                disabled={isMutating}
              />
            </>
          )}
          {['paused', 'blocked'].includes(normalizedStatus) && (
            <EntityActionButton
              label="Resume"
              color={colors.lime}
              variant="primary"
              onClick={() =>
                runWorkstreamAction('resume', 'Workstream resumed.', 'Failed to resume workstream.')
              }
              disabled={isMutating}
            />
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

          {/* Overflow menu */}
          <div className="relative" ref={overflowRef}>
            <button
              type="button"
              className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-secondary hover:bg-white/10 hover:text-primary transition-colors text-sm leading-none"
              onClick={() => { setOverflowOpen((v) => !v); setConfirmDelete(false); }}
              aria-label="More actions"
              disabled={isMutating}
            >
              &#x22EF;
            </button>
            {overflowOpen && (
              <div className="absolute bottom-full right-0 mb-1 min-w-[160px] rounded-lg border border-white/10 bg-[#0c1322] shadow-xl z-50">
                {confirmDelete ? (
                  <div className="flex flex-col gap-1 p-2">
                    <span className="text-caption text-secondary px-2">Delete workstream?</span>
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-white/5 transition-colors"
                      style={{ color: colors.red }}
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
                    >
                      Confirm Delete
                    </button>
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm text-secondary hover:bg-white/5 transition-colors"
                      onClick={() => setConfirmDelete(false)}
                      disabled={isMutating}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="p-1">
                    <button
                      type="button"
                      className="w-full text-left rounded-md px-3 py-1.5 text-sm hover:bg-white/5 transition-colors"
                      style={{ color: colors.red }}
                      onClick={() => setConfirmDelete(true)}
                      disabled={isMutating}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

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
